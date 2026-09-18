import type { Pool, PoolClient } from "pg";
import type {
	FrozenImportItem,
	ImportApplyReport,
} from "../../domain/portability/import-apply-plan.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import type { PortableJson } from "../../domain/portability/v1.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import {
	ImportPlanStoreError,
	importTransaction,
} from "./import-plan-store.ts";
import {
	digestImportTarget,
	IMPORT_TARGETS,
	type ImportTargetCollection,
} from "./import-target.ts";

export type ImportRunStatus = {
	jobId: string;
	state: "pending" | "running" | "conflict" | "completed";
	nextOrdinal: number;
	appliedCount: number;
	noopCount: number;
	conflictCode: string | null;
	conflictOrdinal: number | null;
};
const runColumns = `job_id as "jobId", state, next_ordinal as "nextOrdinal", applied_count as "appliedCount", noop_count as "noopCount", conflict_code as "conflictCode", conflict_ordinal as "conflictOrdinal"`;
const itemColumns = `ordinal, collection, source_id as "sourceId", source_key as "sourceKey", item_digest as "itemDigest", target_id as "targetId", disposition, payload, codes, phase, content_digest as "contentDigest", target_precondition as "targetPrecondition", dependency_proof as "dependencyProof"`;
const fail = (code: string, status = 409): never => {
	throw new ImportPlanStoreError(code, status);
};
class BatchConflict extends Error {
	constructor(
		readonly code: string,
		readonly ordinal: number,
	) {
		super(code);
	}
}
type Row = Record<string, unknown>;
type SourceMap = {
	source_key: string;
	collection: string;
	source_row_id: string;
	target_id: string;
	target_workspace_id: string;
	content_digest: string;
	last_target_digest: string;
	last_plan_digest: string;
	version: number;
};
const column = (field: string) =>
	field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const rowKey = (collection: string, id: string) =>
	JSON.stringify([collection, id]);
function collectionOf(item: FrozenImportItem): ImportTargetCollection {
	if (!Object.hasOwn(IMPORT_TARGETS, item.collection))
		throw new BatchConflict("unsupported-collection", item.ordinal);
	return item.collection as ImportTargetCollection;
}
function payloadOf(item: FrozenImportItem): Record<string, PortableJson> {
	if (
		!item.payload ||
		typeof item.payload !== "object" ||
		Array.isArray(item.payload)
	)
		throw new BatchConflict("invalid-plan-evidence", item.ordinal);
	return item.payload;
}
function payloadRow(item: FrozenImportItem): Row {
	return Object.fromEntries(
		Object.entries(payloadOf(item)).map(([key, value]) => [
			column(key),
			item.collection === "tasks" &&
			(key === "dueAt" || key === "completedAt") &&
			typeof value === "string"
				? new Date(value)
				: value,
		]),
	);
}
async function readRun(client: PoolClient, ownerId: string, jobId: string) {
	return (
		(
			await client.query<ImportRunStatus>(
				`select ${runColumns} from import_run where job_id = $1 and owner_user_id = $2 for update`,
				[jobId, ownerId],
			)
		).rows[0] ?? null
	);
}
export async function getImportRunStatus(
	pool: Pool,
	ownerId: string,
	jobId: string,
): Promise<ImportRunStatus | null> {
	return importTransaction(pool, ownerId, (client) =>
		readRun(client, ownerId, jobId),
	);
}

export async function applyImportBatch(
	pool: Pool,
	ownerId: string,
	jobId: string,
	confirmation: {
		planDigest: string;
		counts: { ensure: number; ignored: number; blocked: number };
	},
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<ImportRunStatus> {
	const deadline = Math.min(
		options.deadline ?? Infinity,
		performance.now() + 15_000,
	);
	const checkpoint = () => {
		if (options.signal?.aborted) fail("import-cancelled", 408);
		if (performance.now() >= deadline) fail("import-timeout", 503);
	};
	return importTransaction(
		pool,
		ownerId,
		async (client) => {
			const job = (
				await client.query<{
					source_id: string;
					planner_version: number;
					apply_supported: boolean;
					plan_digest: string;
					report: ImportApplyReport;
				}>(
					`select j.source_id, j.planner_version, j.apply_supported, j.plan_digest, j.report from import_source s join import_job j on j.source_id = s.id where j.id = $1 and j.owner_user_id = $2 and s.owner_user_id = $2`,
					[jobId, ownerId],
				)
			).rows[0];
			if (!job) fail("plan-not-found", 404);
			if (job.planner_version !== 2 || !job.apply_supported)
				fail("import-apply-unsupported");
			if (
				confirmation?.planDigest !== job.plan_digest ||
				!confirmation.counts ||
				["ensure", "ignored", "blocked"].some(
					(key) =>
						confirmation.counts[key as keyof typeof confirmation.counts] !==
						job.report.counts[key as keyof typeof confirmation.counts],
				)
			)
				fail("import-confirmation-mismatch");
			let run = await readRun(client, ownerId, jobId);
			if (run?.state === "completed" || run?.state === "conflict") return run;
			const start = run?.nextOrdinal ?? 0;
			const sizes = await client.query<{ ordinal: number; bytes: number }>(
				`select ordinal, octet_length(i::text) as bytes from import_item i where job_id = $1 and ordinal >= $2 order by ordinal limit 100`,
				[jobId, start],
			);
			if (
				sizes.rows.reduce((sum, row) => sum + row.bytes, 0) >
				64 * 1024 * 1024
			)
				fail("import-batch-too-large", 413);
			const items = (
				await client.query<FrozenImportItem>(
					`select ${itemColumns} from import_item where job_id = $1 and ordinal >= $2 order by ordinal limit 100`,
					[jobId, start],
				)
			).rows;
			for (const [index, item] of items.entries()) {
				const { itemDigest, ...evidence } = item;
				if (
					item.ordinal !== start + index ||
					(await hashImportValue(
						"ditero-import-item-v2",
						evidence as unknown as PortableJson,
						checkpoint,
					)) !== itemDigest
				)
					fail("invalid-plan-evidence");
			}
			const supported = items.filter((item) => item.disposition === "ensure");
			const workspaces = [
				...new Set(
					supported.map((item) => item.dependencyProof?.workspace.targetId),
				),
			].sort();
			if (workspaces.includes(undefined)) fail("invalid-plan-evidence");
			const authority = await client.query<{ role: Role }>(
				`select m.role from membership m join workspace w on w.id = m.workspace_id where m.user_id = $1 and m.workspace_id = any($2::text[]) order by w.id, m.id for share of w, m`,
				[ownerId, workspaces],
			);
			if (
				authority.rows.length !== workspaces.length ||
				authority.rows.some((row) => !WRITE_ROLES.has(row.role))
			) {
				if (!run) fail("invalid-workspace-mapping", 403);
				await client.query(
					`update import_run set state = 'conflict', conflict_code = 'invalid-workspace-mapping', conflict_ordinal = $1, updated_at = now() where job_id = $2 and owner_user_id = $3`,
					[start, jobId, ownerId],
				);
				const stopped = await readRun(client, ownerId, jobId);
				if (!stopped) throw new Error("Import run disappeared");
				return stopped;
			}
			if (!run) {
				await client.query(
					`insert into import_run (job_id, owner_user_id) values ($1,$2)`,
					[jobId, ownerId],
				);
				run = await readRun(client, ownerId, jobId);
			}
			if (!run) throw new Error("Import run is missing");
			await client.query("savepoint import_batch");
			let currentOrdinal = start;
			try {
				const sourceKeys = [
					...new Set(
						supported.flatMap((item) => [
							item.sourceKey,
							...(item.dependencyProof?.rows.map((row) => row.sourceKey) ?? []),
						]),
					),
				].sort();
				const maps = new Map(
					(
						await client.query<SourceMap>(
							`select source_key, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest, version from import_source_map where source_id = $1 and owner_user_id = $2 and source_key = any($3::text[]) order by source_key for update`,
							[job.source_id, ownerId, sourceKeys],
						)
					).rows.map((row) => [row.source_key, row]),
				);
				const sourceWorkspaces = [
					...new Set(
						supported.map((item) => item.dependencyProof?.workspace.sourceId),
					),
				].sort();
				const pins = new Map(
					(
						await client.query<{
							source_workspace_id: string;
							target_workspace_id: string;
						}>(
							`select source_workspace_id, target_workspace_id from import_workspace_map where source_id = $1 and owner_user_id = $2 and source_workspace_id = any($3::text[]) order by source_workspace_id`,
							[job.source_id, ownerId, sourceWorkspaces],
						)
					).rows.map((row) => [
						row.source_workspace_id,
						row.target_workspace_id,
					]),
				);
				const wanted = new Map<ImportTargetCollection, Set<string>>();
				const want = (collection: ImportTargetCollection, id: string) => {
					const ids = wanted.get(collection) ?? new Set<string>();
					ids.add(id);
					wanted.set(collection, ids);
				};
				for (const item of supported) {
					currentOrdinal = item.ordinal;
					const collection = collectionOf(item);
					if (
						!item.targetId ||
						!item.dependencyProof ||
						!item.targetPrecondition
					)
						throw new BatchConflict("invalid-plan-evidence", item.ordinal);
					want(collection, item.targetId);
					for (const proof of item.dependencyProof.rows) {
						want(proof.collection, proof.id);
						if (proof.listId) want("lists", proof.listId);
					}
				}
				const live = new Map<string, Row>();
				let bytes = 0;
				let rawBytes = 0;
				for (const [collection, ids] of [...wanted].sort(([a], [b]) =>
					IMPORT_TARGETS[a].table.localeCompare(IMPORT_TARGETS[b].table),
				)) {
					const { table, fields } = IMPORT_TARGETS[collection];
					const columns = fields.map((field) => `"${column(field)}"`).join(",");
					const rawSize = fields
						.map(
							(field) =>
								`coalesce(octet_length("${column(field)}"::text)::bigint, 0)`,
						)
						.join(" + ");
					const keys = [...ids].sort();
					for (let offset = 0; offset < keys.length; offset += 100) {
						const page = keys.slice(offset, offset + 100);
						const locked = await client.query<{ id: string }>(
							`select id from "${table}" where id = any($1::text[]) order by id for share`,
							[page],
						);
						const lockedIds = locked.rows.map((row) => row.id);
						// Probe scalar text sizes before allocating an escaped projection.
						const raw = await client.query<{ bytes: string }>(
							`select coalesce(sum(${rawSize}), 0)::text as bytes from "${table}" where id = any($1::text[])`,
							[lockedIds],
						);
						rawBytes += Number(raw.rows[0]?.bytes ?? NaN);
						if (!Number.isFinite(rawBytes) || rawBytes > 64 * 1024 * 1024)
							throw new BatchConflict("import-batch-too-large", currentOrdinal);
						const projected = await client.query<{ bytes: string }>(
							`select coalesce(sum(octet_length(row_to_json(p)::text)), 0)::text as bytes from (select ${columns} from "${table}" where id = any($1::text[])) p`,
							[lockedIds],
						);
						bytes += Number(projected.rows[0]?.bytes ?? NaN);
						if (!Number.isFinite(bytes) || bytes > 64 * 1024 * 1024)
							throw new BatchConflict("import-batch-too-large", currentOrdinal);
						const rows = await client.query<Row>(
							`select ${columns} from "${table}" where id = any($1::text[]) order by id`,
							[lockedIds],
						);
						for (const row of rows.rows)
							live.set(rowKey(collection, String(row.id)), row);
					}
				}
				const batch = new Map(items.map((item) => [item.ordinal, item]));
				const prepared: {
					item: FrozenImportItem;
					collection: ImportTargetCollection;
					targetDigest: string;
					noop: boolean;
				}[] = [];
				for (const item of supported) {
					currentOrdinal = item.ordinal;
					const conflict: (code: string) => never = (code) => {
						throw new BatchConflict(code, item.ordinal);
					};
					const proof = item.dependencyProof;
					const pre = item.targetPrecondition;
					if (!proof || !pre || !item.targetId)
						conflict("invalid-plan-evidence");
					const collection = collectionOf(item);
					const payload = payloadOf(item);
					if (
						payload.id !== item.targetId ||
						(collection === "lists" && payload.ownerId !== ownerId)
					)
						conflict("invalid-plan-evidence");
					if (
						collection === "tasks" &&
						([
							"reminderTime",
							"repeatEveryMin",
							"maxRepeats",
							"fallbackUserId",
						].some((key) => payload[key] !== null) ||
							payload.urgent !== false ||
							(payload.done !== true && payload.dueAt !== null))
					)
						conflict("notification-bearing-task");
					const workspace = proof.workspace.targetId;
					if (
						pins.has(proof.workspace.sourceId) &&
						pins.get(proof.workspace.sourceId) !== workspace
					)
						conflict("workspace-mapping-conflict");
					pins.set(proof.workspace.sourceId, workspace);
					for (const dependency of proof.rows) {
						if (dependency.itemOrdinal >= item.ordinal)
							conflict("dependency-order-conflict");
						const map = maps.get(dependency.sourceKey);
						const earlier = batch.get(dependency.itemOrdinal);
						if (
							(dependency.itemOrdinal < start && !map) ||
							(dependency.itemOrdinal >= start &&
								(earlier?.disposition !== "ensure" ||
									earlier.sourceKey !== dependency.sourceKey ||
									earlier.targetId !== dependency.id ||
									earlier.collection !== dependency.collection ||
									!prepared.some((entry) => entry.item === earlier)))
						)
							conflict("dependency-map-conflict");
						if (
							map &&
							(map.target_id !== dependency.id ||
								map.collection !== dependency.collection ||
								map.target_workspace_id !== dependency.workspaceId)
						)
							conflict("dependency-map-conflict");
						const row = live.get(rowKey(dependency.collection, dependency.id));
						if (!row || dependency.workspaceId !== workspace)
							conflict("dependency-target-conflict");
						if (dependency.collection === "tasks") {
							const list = live.get(rowKey("lists", String(row.list_id)));
							if (
								!list ||
								list.workspace_id !== workspace ||
								row.list_id !== dependency.listId ||
								row.parent_id !== dependency.parentId
							)
								conflict("dependency-target-conflict");
						} else if (row.workspace_id !== workspace)
							conflict("dependency-target-conflict");
					}
					const requireProof = (
						kind: ImportTargetCollection,
						id: PortableJson,
					) => {
						if (
							typeof id !== "string" ||
							!proof.rows.some(
								(row) => row.collection === kind && row.id === id,
							)
						)
							conflict("dependency-proof-conflict");
						return live.get(rowKey(kind, String(id)));
					};
					if (
						["folders", "lists", "labels"].includes(collection) &&
						payload.workspaceId !== workspace
					)
						conflict("dependency-target-conflict");
					if (collection === "lists" && payload.folderId !== null)
						requireProof("folders", payload.folderId);
					if (collection === "tasks") {
						requireProof("lists", payload.listId);
						if (
							payload.parentId !== null &&
							requireProof("tasks", payload.parentId)?.list_id !==
								payload.listId
						)
							conflict("dependency-target-conflict");
					}
					if (collection === "taskLabels") {
						requireProof("tasks", payload.taskId);
						requireProof("labels", payload.labelId);
					}
					const map = maps.get(item.sourceKey);
					const target = live.get(rowKey(collection, item.targetId));
					const targetDigest = await digestImportTarget(
						collection,
						payloadRow(item),
						checkpoint,
					);
					if (pre.kind === "mapped") {
						if (
							!map ||
							!target ||
							map.version !== pre.mapVersion ||
							map.collection !== collection ||
							map.source_row_id !== item.sourceId ||
							map.target_id !== item.targetId ||
							map.target_workspace_id !== workspace ||
							map.content_digest !== item.contentDigest ||
							map.last_target_digest !== pre.targetDigest ||
							targetDigest !== pre.targetDigest ||
							(await digestImportTarget(collection, target, checkpoint)) !==
								pre.targetDigest
						)
							conflict("mapped-target-conflict");
					} else {
						if (map || target) conflict("target-already-exists");
						if (collection === "labels") {
							if (
								pre.naturalKey?.kind !== "label-name" ||
								pre.naturalKey.workspaceId !== workspace ||
								pre.naturalKey.name !== payload.name
							)
								conflict("invalid-plan-evidence");
							if (
								(
									await client.query(
										`select id from label where workspace_id = $1 and name = $2 for share`,
										[workspace, payload.name],
									)
								).rowCount ||
								prepared.some(
									(entry) =>
										entry.collection === collection &&
										payloadOf(entry.item).workspaceId === workspace &&
										payloadOf(entry.item).name === payload.name,
								)
							)
								conflict("natural-key-conflict");
						} else if (collection === "taskLabels") {
							if (
								pre.naturalKey?.kind !== "task-label-pair" ||
								pre.naturalKey.taskId !== payload.taskId ||
								pre.naturalKey.labelId !== payload.labelId
							)
								conflict("invalid-plan-evidence");
							if (
								(
									await client.query(
										`select id from task_label where task_id = $1 and label_id = $2 for share`,
										[payload.taskId, payload.labelId],
									)
								).rowCount ||
								prepared.some(
									(entry) =>
										entry.collection === collection &&
										payloadOf(entry.item).taskId === payload.taskId &&
										payloadOf(entry.item).labelId === payload.labelId,
								)
							)
								conflict("natural-key-conflict");
						} else if (pre.naturalKey !== null)
							conflict("invalid-plan-evidence");
						live.set(rowKey(collection, item.targetId), payloadRow(item));
					}
					prepared.push({
						item,
						collection,
						targetDigest,
						noop: pre.kind === "mapped",
					});
				}
				for (const { item, collection, targetDigest, noop } of prepared) {
					currentOrdinal = item.ordinal;
					const payload = payloadOf(item);
					if (noop) {
						await client.query(
							`update import_source_map set last_plan_digest = $1, updated_at = now() where source_id = $2 and source_key = $3 and owner_user_id = $4 and last_plan_digest is distinct from $1`,
							[job.plan_digest, job.source_id, item.sourceKey, ownerId],
						);
					} else {
						const { table, fields } = IMPORT_TARGETS[collection];
						await client.query(
							`insert into "${table}" (${fields.map((field) => `"${column(field)}"`).join(",")}) values (${fields.map((_, index) => `$${index + 1}`).join(",")})`,
							fields.map((field) => payload[field]),
						);
						await client.query(
							`insert into import_source_map (source_id, source_key, owner_user_id, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
							[
								job.source_id,
								item.sourceKey,
								ownerId,
								collection,
								item.sourceId,
								item.targetId,
								item.dependencyProof?.workspace.targetId,
								item.contentDigest,
								targetDigest,
								job.plan_digest,
							],
						);
					}
				}
				for (const [source, target] of pins)
					await client.query(
						`insert into import_workspace_map (source_id, source_workspace_id, owner_user_id, target_workspace_id) values ($1,$2,$3,$4) on conflict (source_id, source_workspace_id) do nothing`,
						[job.source_id, source, ownerId, target],
					);
				const quota = (
					await client.query<{ maps: number; pins: number; bytes: string }>(
						`select (select count(*)::int from import_source_map where owner_user_id = $1) as maps, (select count(*)::int from import_workspace_map where owner_user_id = $1) as pins, ((select coalesce(sum(octet_length(m::text)),0) from import_source_map m where owner_user_id = $1) + (select coalesce(sum(octet_length(w::text)),0) from import_workspace_map w where owner_user_id = $1))::text as bytes`,
						[ownerId],
					)
				).rows[0];
				if (
					!quota ||
					quota.maps > 100_000 ||
					quota.pins > 1000 ||
					Number(quota.bytes) > 64 * 1024 * 1024
				)
					throw new BatchConflict("import-map-quota-exceeded", currentOrdinal);
				const next = start + items.length;
				const remaining = (
					await client.query(
						`select 1 from import_item where job_id = $1 and ordinal >= $2 limit 1`,
						[jobId, next],
					)
				).rowCount;
				await client.query(
					`update import_run set state = $1, next_ordinal = $2, applied_count = applied_count + $3, noop_count = noop_count + $4, updated_at = now(), completed_at = case when $1 = 'completed' then now() else null end where job_id = $5 and owner_user_id = $6`,
					[
						remaining ? "running" : "completed",
						next,
						prepared.filter((entry) => !entry.noop).length,
						prepared.filter((entry) => entry.noop).length,
						jobId,
						ownerId,
					],
				);
				await client.query("release savepoint import_batch");
			} catch (error) {
				const race =
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					["23505", "23503"].includes(String(error.code));
				if (!(error instanceof BatchConflict) && !race) throw error;
				await client.query("rollback to savepoint import_batch");
				await client.query(
					`update import_run set state = 'conflict', conflict_code = $1, conflict_ordinal = $2, updated_at = now() where job_id = $3 and owner_user_id = $4`,
					[
						error instanceof BatchConflict
							? error.code
							: "target-write-conflict",
						error instanceof BatchConflict ? error.ordinal : currentOrdinal,
						jobId,
						ownerId,
					],
				);
			}
			const result = await readRun(client, ownerId, jobId);
			if (!result) throw new Error("Import run disappeared");
			return result;
		},
		options.signal,
		deadline,
	);
}
