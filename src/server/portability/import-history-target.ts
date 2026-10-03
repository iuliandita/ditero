import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
	freezeHistoricalImportItem,
	type HistoricalFrozenTarget,
	type HistoricalParentProof,
	type HistoricalTargetSnapshot,
} from "../../domain/portability/import-apply-plan-v2.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import type {
	HistoricalCollection,
	HistoricalImportItem,
} from "../../domain/portability/import-plan-v2.ts";

export class HistoricalTargetError extends Error {
	constructor(
		readonly code:
			| "historical-parent-unavailable"
			| "invalid-historical-item"
			| "planning-cancelled"
			| "planning-timeout"
			| "import-target-limit",
	) {
		super(code);
		this.name = "HistoricalTargetError";
	}
}

type PlannedParent = { workspaceId: string; dependencySourceKey: string };
type Options = {
	signal?: AbortSignal;
	deadline?: number;
	plannedTasks?: ReadonlyMap<string, PlannedParent>;
};
type TaskParent = { id: string; list_id: string; workspace_id: string };
type LedgerRow = {
	collection: HistoricalCollection;
	target_parent_id: string;
	source_namespace: string;
	source_row_id_sha256: string;
	source_row_id: string;
	target_id: string;
	content_digest: string;
};
const targetTables = {
	comments: { table: "comment", parent: "task_id", lock: " for share" },
	templates: { table: "template", parent: "workspace_id", lock: " for share" },
	completionEvents: {
		table: "imported_completion_event",
		parent: "task_id",
		lock: "",
	},
} as const;
export const historicalItemKey = (item: HistoricalImportItem) =>
	JSON.stringify([item.collection, item.archiveRowId]);
const parentKey = (kind: string, id: string) => JSON.stringify([kind, id]);

// Use inside the caller's bounded user-scoped transaction, after user locks and
// before target writes. Planned parents must be exact frozen ordinary candidates.
export async function freezeHistoricalTargets(
	client: PoolClient,
	ownerId: string,
	items: readonly HistoricalImportItem[],
	options: Options = {},
): Promise<Map<string, HistoricalFrozenTarget>> {
	const deadline = options.deadline ?? performance.now() + 15_000;
	const checkpoint = () => {
		if (options.signal?.aborted)
			throw new HistoricalTargetError("planning-cancelled");
		if (performance.now() >= deadline)
			throw new HistoricalTargetError("planning-timeout");
	};
	checkpoint();
	if (
		items.length > 50_000 ||
		Buffer.byteLength(JSON.stringify(items)) > 64 * 1024 * 1024
	)
		throw new HistoricalTargetError("import-target-limit");
	const keys = new Set<string>();
	const tasks = new Set<string>();
	const workspaces = new Set<string>();
	for (const item of items) {
		checkpoint();
		const key = historicalItemKey(item);
		if (
			keys.has(key) ||
			!Object.hasOwn(targetTables, item.collection) ||
			item.parentKind !==
				(item.collection === "templates" ? "workspace" : "task") ||
			!item.ledger.targetParentId ||
			!/^[0-9a-f]{64}$/.test(item.semanticDigest) ||
			createHash("sha256")
				.update(item.ledger.sourceId, "utf8")
				.digest("hex") !== item.ledger.sourceIdHash ||
			item.ledger.collection !== item.collection
		)
			throw new HistoricalTargetError("invalid-historical-item");
		keys.add(key);
		(item.parentKind === "task" ? tasks : workspaces).add(
			item.ledger.targetParentId,
		);
	}
	const live = await client.query(
		"select id from \"user\" where id = $1 and deleted_at is null and current_setting('ditero.user_id', true) = $1 for share",
		[ownerId],
	);
	if (live.rowCount !== 1)
		throw new HistoricalTargetError("historical-parent-unavailable");
	const taskIds = [...tasks].sort();
	const discovered = new Map<string, TaskParent>();
	for (let offset = 0; offset < taskIds.length; offset += 256) {
		checkpoint();
		const rows = await client.query<TaskParent>(
			"select t.id, t.list_id, l.workspace_id from task t join list l on l.id = t.list_id where t.id = any($1::text[]) order by t.id",
			[taskIds.slice(offset, offset + 256)],
		);
		for (const row of rows.rows) discovered.set(row.id, row);
	}
	for (const id of taskIds) {
		const current = discovered.get(id);
		const planned = options.plannedTasks?.get(id);
		if (!current && !planned?.dependencySourceKey)
			throw new HistoricalTargetError("historical-parent-unavailable");
		workspaces.add(current?.workspace_id ?? planned?.workspaceId ?? "");
	}
	const workspaceIds = [...workspaces].sort();
	const seats = new Map<string, string>();
	for (let offset = 0; offset < workspaceIds.length; offset += 256) {
		checkpoint();
		const ids = workspaceIds.slice(offset, offset + 256);
		const locked = await client.query(
			"select id from workspace where id = any($1::text[]) order by id for share",
			[ids],
		);
		if (locked.rowCount !== ids.length)
			throw new HistoricalTargetError("historical-parent-unavailable");
		const memberships = await client.query<{
			id: string;
			workspace_id: string;
		}>(
			"select id, workspace_id from membership where user_id = $1 and workspace_id = any($2::text[]) and role in ('owner','admin','member') order by id for share",
			[ownerId, ids],
		);
		if (memberships.rowCount !== ids.length)
			throw new HistoricalTargetError("historical-parent-unavailable");
		for (const row of memberships.rows) seats.set(row.workspace_id, row.id);
	}
	const listIds = [
		...new Set([...discovered.values()].map((row) => row.list_id)),
	].sort();
	for (let offset = 0; offset < listIds.length; offset += 256) {
		checkpoint();
		await client.query(
			"select id from list where id = any($1::text[]) order by id for share",
			[listIds.slice(offset, offset + 256)],
		);
	}
	const parents = new Map<string, HistoricalParentProof>();
	for (const id of workspaces)
		parents.set(parentKey("workspace", id), {
			kind: "workspace",
			id,
			workspaceId: id,
			membershipId: seats.get(id) ?? "",
			listId: null,
			dependencySourceKey: null,
		});
	for (let offset = 0; offset < taskIds.length; offset += 256) {
		checkpoint();
		const ids = taskIds.slice(offset, offset + 256);
		const locked = await client.query<TaskParent>(
			"select t.id, t.list_id, l.workspace_id from task t join list l on l.id = t.list_id where t.id = any($1::text[]) order by t.id for share of t",
			[ids],
		);
		const byId = new Map(locked.rows.map((row) => [row.id, row]));
		for (const id of ids) {
			const before = discovered.get(id);
			const current = byId.get(id);
			const planned = options.plannedTasks?.get(id);
			if (
				(before &&
					(!current ||
						current.list_id !== before.list_id ||
						current.workspace_id !== before.workspace_id)) ||
				(!before && current) ||
				(!current && !planned)
			)
				throw new HistoricalTargetError("historical-parent-unavailable");
			const workspaceId = current?.workspace_id ?? planned?.workspaceId ?? "";
			const membershipId = seats.get(workspaceId);
			if (!membershipId)
				throw new HistoricalTargetError("historical-parent-unavailable");
			parents.set(parentKey("task", id), {
				kind: "task",
				id,
				workspaceId,
				membershipId,
				listId: current?.list_id ?? null,
				dependencySourceKey: current
					? null
					: (planned?.dependencySourceKey ?? null),
			});
		}
	}
	const ledgerKey = (
		collection: string,
		parent: string,
		namespace: string,
		hash: string,
	) => JSON.stringify([collection, parent, namespace.toLowerCase(), hash]);
	const ledgers = new Map<string, LedgerRow>();
	for (let offset = 0; offset < items.length; offset += 256) {
		checkpoint();
		const wanted = items.slice(offset, offset + 256).map((item) => ({
			collection: item.collection,
			parent: item.ledger.targetParentId,
			namespace: item.ledger.sourceNamespace,
			hash: item.ledger.sourceIdHash,
		}));
		const rows = await client.query<LedgerRow>(
			"select collection, target_parent_id, source_namespace, source_row_id_sha256, source_row_id, target_id, content_digest from import_history_ledger l where exists (select 1 from jsonb_to_recordset($1::jsonb) as p(collection text, parent text, namespace uuid, hash text) where l.collection::text = p.collection and l.target_parent_id = p.parent and l.source_namespace = p.namespace and l.source_row_id_sha256 = p.hash)",
			[JSON.stringify(wanted)],
		);
		for (const row of rows.rows)
			ledgers.set(
				ledgerKey(
					row.collection,
					row.target_parent_id,
					row.source_namespace,
					row.source_row_id_sha256,
				),
				row,
			);
	}
	const prepared: {
		item: HistoricalImportItem;
		ledger: LedgerRow | undefined;
		targetId: string;
	}[] = [];
	for (let offset = 0; offset < items.length; offset += 256) {
		checkpoint();
		const pending = await Promise.allSettled(
			items.slice(offset, offset + 256).map(async (item) => {
				const ledger = ledgers.get(
					ledgerKey(
						item.collection,
						item.ledger.targetParentId,
						item.ledger.sourceNamespace,
						item.ledger.sourceIdHash,
					),
				);
				const targetId =
					ledger?.target_id ??
					(await hashImportValue(
						"ditero-import-historical-target-v5",
						[
							item.collection,
							item.ledger.targetParentId,
							item.ledger.sourceNamespace.toLowerCase(),
							item.ledger.sourceId,
						],
						checkpoint,
					));
				return { item, ledger, targetId };
			}),
		);
		for (const result of pending) {
			if (result.status === "rejected") throw result.reason;
			prepared.push(result.value);
		}
	}
	const targets = new Map<string, { id: string; parent_id: string }>();
	for (const collection of [
		"comments",
		"completionEvents",
		"templates",
	] as const) {
		const { table, parent: column, lock } = targetTables[collection];
		const ids = [
			...new Set(
				prepared
					.filter((row) => row.item.collection === collection)
					.map((row) => row.targetId),
			),
		].sort();
		for (let offset = 0; offset < ids.length; offset += 256) {
			checkpoint();
			const rows = await client.query<{ id: string; parent_id: string }>(
				`select id, "${column}" as parent_id from "${table}" where id = any($1::text[]) order by id${lock}`,
				[ids.slice(offset, offset + 256)],
			);
			for (const row of rows.rows)
				targets.set(JSON.stringify([collection, row.id]), row);
		}
	}
	const result = new Map<string, HistoricalFrozenTarget>();
	for (const { item, ledger, targetId } of prepared) {
		checkpoint();
		const parent = parents.get(
			parentKey(item.parentKind, item.ledger.targetParentId),
		);
		if (!parent)
			throw new HistoricalTargetError("historical-parent-unavailable");
		const current = targets.get(JSON.stringify([item.collection, targetId]));
		const snapshot: HistoricalTargetSnapshot = !ledger
			? { kind: "unmapped", authorizedTargetId: current ? "" : targetId }
			: {
					kind: "mapped",
					ledger: {
						collection: ledger.collection,
						targetParentId: ledger.target_parent_id,
						sourceNamespace: ledger.source_namespace,
						sourceIdHash: ledger.source_row_id_sha256,
						sourceId: ledger.source_row_id,
					},
					semanticDigest: ledger.content_digest,
					authorizedTargetId: ledger.target_id,
					ledgerTargetId: ledger.target_id,
					target: current
						? { state: "live", id: current.id, parentId: current.parent_id }
						: { state: "tombstone", id: ledger.target_id },
				};
		result.set(historicalItemKey(item), {
			parent,
			snapshot,
			decision: freezeHistoricalImportItem(item, snapshot),
		});
	}
	checkpoint();
	return result;
}
