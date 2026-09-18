import type { PoolClient } from "pg";
import type { ImportApplyCandidate } from "../../domain/portability/import-apply.ts";
import {
	digestImportContent,
	type ImportDependencyProof,
	type ImportTargetSnapshot,
} from "../../domain/portability/import-apply-plan.ts";
import {
	type ImportMappings,
	ImportPlanError,
} from "../../domain/portability/import-plan.ts";
import type {
	PortableExportV1,
	PortableJson,
	PortableRows,
} from "../../domain/portability/v1.ts";
import {
	digestImportTarget,
	IMPORT_TARGETS,
	type ImportTargetCollection,
} from "./import-target.ts";

export class ImportFreezeLimitError extends Error {
	readonly code = "import-target-limit";
	readonly status = 413;
	constructor() {
		super("Import target projections exceed the planning limit");
	}
}

type SourceMap = {
	source_key: string;
	collection: string;
	source_row_id: string;
	target_id: string;
	target_workspace_id: string;
	content_digest: string;
	last_target_digest: string;
	version: number;
};
type ObjectPayload = Record<string, PortableJson>;
function payload(item: ImportApplyCandidate): ObjectPayload {
	if (
		!item.payload ||
		typeof item.payload !== "object" ||
		Array.isArray(item.payload)
	)
		throw new ImportPlanError("invalid-graph");
	return item.payload;
}
function textField(row: ObjectPayload, key: string): string {
	if (typeof row[key] !== "string") throw new ImportPlanError("invalid-graph");
	return row[key];
}
const column = (field: string) =>
	field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The caller owns the bounded transaction and has locked the live owner and
// authorized mappings. This helper never creates target or ledger content.
export async function freezeImportTargets(
	client: PoolClient,
	ownerId: string,
	sourceId: string,
	document: PortableExportV1,
	mappings: ImportMappings,
	candidates: readonly ImportApplyCandidate[],
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<{
	items: ImportApplyCandidate[];
	snapshots: Map<string, ImportTargetSnapshot>;
}> {
	const deadline = options.deadline ?? performance.now() + 15_000;
	function checkpoint() {
		if (options.signal?.aborted)
			throw new ImportPlanError("planning-cancelled");
		if (performance.now() >= deadline)
			throw new ImportPlanError("planning-timeout");
	}
	checkpoint();
	const items = candidates.map((item) => {
		checkpoint();
		return structuredClone(item);
	});
	const byKey = new Map(items.map((item) => [item.sourceKey, item]));
	if (byKey.size !== items.length) throw new ImportPlanError("invalid-graph");
	const originals = new Map<string, PortableRows[keyof PortableRows]>();
	for (const collection of Object.keys(
		document.data,
	) as (keyof PortableRows)[]) {
		for (const row of document.data[collection]) {
			checkpoint();
			originals.set(
				JSON.stringify([collection, "id" in row ? row.id : row.userId]),
				row,
			);
		}
	}
	function original(item: ImportApplyCandidate): ObjectPayload {
		const row = originals.get(JSON.stringify([item.collection, item.sourceId]));
		if (!row) throw new ImportPlanError("invalid-graph");
		return row as unknown as ObjectPayload;
	}
	const sourceLists = new Map(document.data.lists.map((row) => [row.id, row]));
	const sourceTasks = new Map(document.data.tasks.map((row) => [row.id, row]));
	function sourceWorkspace(item: ImportApplyCandidate): string {
		const row = original(item);
		if (item.collection === "tasks") {
			const list = sourceLists.get(textField(row, "listId"));
			if (!list) throw new ImportPlanError("invalid-graph");
			return list.workspaceId;
		}
		if (item.collection === "taskLabels") {
			const task = sourceTasks.get(textField(row, "taskId"));
			const list = task && sourceLists.get(task.listId);
			if (!list) throw new ImportPlanError("invalid-graph");
			return list.workspaceId;
		}
		return textField(row, "workspaceId");
	}
	function targetWorkspace(item: ImportApplyCandidate): string {
		const id = mappings.workspaces[sourceWorkspace(item)];
		if (!id) throw new ImportPlanError("invalid-mappings");
		return id;
	}
	// Pins are immutable and serialized by the caller's owner lock. A row lock
	// would also require an UPDATE policy and hide these SELECT-only rows.
	const pins = await client.query<{
		source_workspace_id: string;
		target_workspace_id: string;
	}>(
		`select source_workspace_id, target_workspace_id from import_workspace_map where owner_user_id = $1 and source_id = $2 and source_workspace_id = any($3::text[]) order by source_workspace_id`,
		[ownerId, sourceId, Object.keys(mappings.workspaces).sort(compare)],
	);
	for (const pin of pins.rows) {
		checkpoint();
		if (
			mappings.workspaces[pin.source_workspace_id] !== pin.target_workspace_id
		)
			throw new ImportPlanError("invalid-mappings");
	}
	const maps = new Map<string, SourceMap>();
	const keys = items
		.filter((item) => item.disposition === "ensure")
		.map((item) => item.sourceKey)
		.sort(compare);
	for (let offset = 0; offset < keys.length; offset += 256) {
		checkpoint();
		const result = await client.query<SourceMap>(
			`select source_key, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, version from import_source_map where owner_user_id = $1 and source_id = $2 and source_key = any($3::text[]) order by source_key for share`,
			[ownerId, sourceId, keys.slice(offset, offset + 256)],
		);
		for (const map of result.rows) maps.set(map.source_key, map);
	}
	const targets = new Map<
		ImportTargetCollection,
		Map<string, Record<string, unknown>>
	>();
	let bytes = 0;
	const maxBytes = 64 * 1024 * 1024;
	// Acquire locks in table/id order, including natural-key collision rows. Only
	// IDs cross the wire until the locked projections have passed the byte cap.
	const collections = (
		Object.keys(IMPORT_TARGETS) as ImportTargetCollection[]
	).sort((a, b) => compare(IMPORT_TARGETS[a].table, IMPORT_TARGETS[b].table));
	for (const collection of collections) {
		checkpoint();
		const selected = items.filter(
			(item) => item.disposition === "ensure" && item.collection === collection,
		);
		if (!selected.length) continue;
		const { table, fields } = IMPORT_TARGETS[collection];
		const ids = selected.map((item) => {
			if (!item.targetId) throw new ImportPlanError("invalid-mappings");
			return item.targetId;
		});
		const parameters: unknown[] = [ids];
		let predicate = "r.id = any($1::text[])";
		if (collection === "labels" || collection === "taskLabels") {
			const natural = selected.map((item) => {
				const row = payload(item);
				return collection === "labels"
					? {
							workspace: textField(row, "workspaceId"),
							name: textField(row, "name"),
						}
					: {
							task: textField(row, "taskId"),
							label: textField(row, "labelId"),
						};
			});
			parameters.push(JSON.stringify(natural));
			predicate +=
				collection === "labels"
					? ` or exists (select 1 from jsonb_to_recordset($2::jsonb) as n(workspace text, name text) where r.workspace_id = n.workspace and r.name = n.name)`
					: ` or exists (select 1 from jsonb_to_recordset($2::jsonb) as n(task text, label text) where r.task_id = n.task and r.label_id = n.label)`;
		}
		const found = await client.query<{ id: string }>(
			`select r.id from "${table}" r where ${predicate} order by r.id for share`,
			parameters,
		);
		const rows = new Map<string, Record<string, unknown>>();
		targets.set(collection, rows);
		const columns = fields.map(column);
		const projection = columns.map((field) => `"${field}"`).join(", ");
		const rawSize = columns
			.map((field) => `coalesce(octet_length("${field}"::text)::bigint, 0)`)
			.join(" + ");
		for (let offset = 0; offset < found.rows.length; offset += 256) {
			checkpoint();
			const batch = found.rows.slice(offset, offset + 256).map((row) => row.id);
			// Probe scalar TOAST lengths before asking PostgreSQL to serialize the
			// locked projection. Charge actual JSON bytes, not worst-case escaping.
			const raw = await client.query<{ bytes: string }>(
				`select coalesce(sum(${rawSize}), 0)::text as bytes from "${table}" where id = any($1::text[])`,
				[batch],
			);
			const rawBytes = Number(raw.rows[0]?.bytes ?? Number.NaN);
			if (!Number.isFinite(rawBytes) || bytes + rawBytes > maxBytes)
				throw new ImportFreezeLimitError();
			const size = await client.query<{ bytes: string }>(
				`select coalesce(sum(octet_length(row_to_json(projected)::text)), 0)::text as bytes from (select ${projection} from "${table}" where id = any($1::text[])) projected`,
				[batch],
			);
			bytes += Number(size.rows[0]?.bytes ?? Number.NaN);
			if (!Number.isFinite(bytes) || bytes > maxBytes)
				throw new ImportFreezeLimitError();
			const result = await client.query<Record<string, unknown>>(
				`select ${projection} from "${table}" where id = any($1::text[]) order by id`,
				[batch],
			);
			for (const row of result.rows) rows.set(String(row.id), row);
		}
	}
	const snapshots = new Map<string, ImportTargetSnapshot>();
	const dependents = new Map<string, ImportApplyCandidate[]>();
	for (const item of items) {
		for (const dependency of item.dependencies) {
			const parent = byKey.get(dependency.sourceKey);
			if (
				!parent ||
				parent.collection !== dependency.collection ||
				parent.sourceId !== dependency.sourceId ||
				parent.ordinal >= item.ordinal
			)
				throw new ImportPlanError("invalid-graph");
			const children = dependents.get(parent.sourceKey) ?? [];
			children.push(item);
			dependents.set(parent.sourceKey, children);
		}
	}
	function block(item: ImportApplyCandidate, code: string) {
		item.disposition = "blocked";
		if (!item.codes.includes(code)) item.codes.push(code);
	}
	function proof(item: ImportApplyCandidate): ImportDependencyProof {
		const rows: ImportDependencyProof["rows"] = [];
		const seen = new Set<string>();
		function visit(current: ImportApplyCandidate) {
			for (const dependency of current.dependencies) {
				checkpoint();
				if (seen.has(dependency.sourceKey)) continue;
				seen.add(dependency.sourceKey);
				const parent = byKey.get(dependency.sourceKey);
				if (
					!parent?.targetId ||
					parent.disposition !== "ensure" ||
					!["folders", "lists", "tasks", "labels"].includes(parent.collection)
				)
					throw new ImportPlanError("invalid-graph");
				const row = payload(parent);
				rows.push({
					collection:
						parent.collection as ImportDependencyProof["rows"][number]["collection"],
					sourceKey: parent.sourceKey,
					itemOrdinal: parent.ordinal,
					id: parent.targetId,
					workspaceId: targetWorkspace(parent),
					...(parent.collection === "tasks"
						? {
								listId: textField(row, "listId"),
								parentId: row.parentId as string | null,
							}
						: {}),
				});
				visit(parent);
			}
		}
		visit(item);
		return {
			workspace: {
				sourceId: sourceWorkspace(item),
				targetId: targetWorkspace(item),
			},
			rows,
		};
	}
	const labelKeys = new Set(
		[...(targets.get("labels")?.values() ?? [])].map((row) =>
			JSON.stringify([row.workspace_id, row.name]),
		),
	);
	const taskLabelKeys = new Set(
		[...(targets.get("taskLabels")?.values() ?? [])].map((row) =>
			JSON.stringify([row.task_id, row.label_id]),
		),
	);
	for (const item of items) {
		checkpoint();
		if (item.disposition !== "ensure") continue;
		if (!Object.hasOwn(IMPORT_TARGETS, item.collection) || !item.targetId)
			throw new ImportPlanError("invalid-mappings");
		const collection = item.collection as ImportTargetCollection;
		const target = targets.get(collection)?.get(item.targetId);
		const map = maps.get(item.sourceKey);
		if (map) {
			if (
				map.collection !== collection ||
				map.source_row_id !== item.sourceId ||
				map.target_id !== item.targetId ||
				map.target_workspace_id !== targetWorkspace(item)
			)
				block(item, "source-mapping-conflict");
			else if (
				map.content_digest !== (await digestImportContent(item, checkpoint))
			)
				block(item, "source-content-changed");
			else if (!target) block(item, "target-missing");
			else if (
				(await digestImportTarget(collection, target, checkpoint)) !==
				map.last_target_digest
			)
				block(item, "target-changed");
			else
				snapshots.set(item.sourceKey, {
					targetPrecondition: {
						kind: "mapped",
						mapVersion: map.version,
						targetDigest: map.last_target_digest,
					},
					dependencyProof: {
						workspace: {
							sourceId: sourceWorkspace(item),
							targetId: targetWorkspace(item),
						},
						rows: [],
					},
				});
		} else if (target) block(item, "target-id-collision");
		else {
			const row = payload(item);
			const naturalKey =
				collection === "labels"
					? {
							kind: "label-name" as const,
							workspaceId: textField(row, "workspaceId"),
							name: textField(row, "name"),
						}
					: collection === "taskLabels"
						? {
								kind: "task-label-pair" as const,
								taskId: textField(row, "taskId"),
								labelId: textField(row, "labelId"),
							}
						: null;
			if (
				(naturalKey?.kind === "label-name" &&
					labelKeys.has(
						JSON.stringify([naturalKey.workspaceId, naturalKey.name]),
					)) ||
				(naturalKey?.kind === "task-label-pair" &&
					taskLabelKeys.has(
						JSON.stringify([naturalKey.taskId, naturalKey.labelId]),
					))
			)
				block(item, "target-natural-key-collision");
			else
				snapshots.set(item.sourceKey, {
					targetPrecondition: { kind: "absent", naturalKey },
					dependencyProof: {
						workspace: {
							sourceId: sourceWorkspace(item),
							targetId: targetWorkspace(item),
						},
						rows: [],
					},
				});
		}
	}
	const queue = items.filter((item) => item.disposition !== "ensure");
	for (let i = 0; i < queue.length; i++) {
		checkpoint();
		for (const child of dependents.get(queue[i].sourceKey) ?? []) {
			if (child.disposition !== "ensure") continue;
			block(child, "blocked-dependency");
			queue.push(child);
		}
	}
	for (const item of items) {
		checkpoint();
		if (item.disposition === "blocked") {
			snapshots.delete(item.sourceKey);
			item.phase = null;
			item.targetId = null;
			item.payload = structuredClone(original(item));
		} else if (item.disposition === "ensure") {
			const snapshot = snapshots.get(item.sourceKey);
			if (!snapshot) throw new ImportPlanError("invalid-mappings");
			snapshot.dependencyProof = proof(item);
		}
	}
	checkpoint();
	return { items, snapshots };
}
