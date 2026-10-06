import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
	digestImportContent,
	type FrozenImportItem,
} from "../../domain/portability/import-apply-plan.ts";
import type { HistoryPreviewItem } from "../../domain/portability/import-apply-plan-v2.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import {
	HistoricalRowError,
	projectHistoricalRow,
} from "../../domain/portability/import-history-row.ts";
import type { PortableJson } from "../../domain/portability/v1.ts";
import { portableRows } from "../../domain/portability/validate.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import {
	ImportPlanStoreError,
	importTransaction,
} from "./import-plan-store.ts";
import {
	digestImportTarget,
	taskCreatedAtPresent,
	taskRecurrencePresent,
} from "./import-target.ts";

const columns = `ordinal, collection, source_id as "sourceId", source_key as "sourceKey", item_digest as "itemDigest", target_id as "targetId", disposition, payload, codes, phase, content_digest as "contentDigest", target_precondition as "targetPrecondition", dependency_proof as "dependencyProof"`;
function fail(code: string, status = 409): never {
	throw new ImportPlanStoreError(code, status);
}
const id = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => !value.includes("\0") && value.isWellFormed());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const optionsSchema = z.strictObject({
	afterOrdinal: z.number().int().min(-1).max(50_000).default(-1),
	limit: z.number().int().min(1).max(64).default(64),
});
const workspaceProof = z.object({
	workspace: z.strictObject({ sourceId: id, targetId: id }),
});
type Job = {
	sourceId: string;
	documentDigest: string;
	mappingDigest: string;
	planDigest: string;
	plannerVersion: number;
	schemaVersion: number;
	state: string;
	applySupported: boolean;
};
type Item = FrozenImportItem | HistoryPreviewItem;
type Blocked =
	| "uncommitted-source"
	| "parent-unapplied"
	| "workspace-mismatch"
	| "parent-unavailable"
	| "parent-changed"
	| "not-permitted"
	| "historical-proof-unavailable";
export type AttachmentMigrationParent = {
	ordinal: number;
	sourceAttachmentId: string;
	sourceAttachmentFingerprint: string;
	destinationParent: {
		kind: "list" | "task" | "comment";
		id: string;
		workspaceId: string;
	} | null;
	blockedReason: Blocked | null;
};
async function verifyItem(item: Item, version: number, checkpoint: () => void) {
	const { itemDigest, ...evidence } = item;
	if (
		!hash.safeParse(itemDigest).success ||
		(await hashImportValue(
			`ditero-import-item-v${version}`,
			evidence as unknown as PortableJson,
			checkpoint,
		)) !== itemDigest
	)
		fail("invalid-plan-evidence");
}
async function oneParent(
	client: PoolClient,
	jobId: string,
	collection: string,
	sourceId: string,
) {
	const sizes = await client.query<{ ordinal: number; bytes: number }>(
		`select ordinal, octet_length(i::text) as bytes from import_item i where job_id=$1 and collection=$2 and source_id=$3 order by ordinal limit 2`,
		[jobId, collection, sourceId],
	);
	if (sizes.rows.length !== 1) return null;
	if (
		!Number.isSafeInteger(sizes.rows[0].bytes) ||
		sizes.rows[0].bytes > 1024 * 1024
	)
		fail("parent-evidence-too-large", 413);
	const result = await client.query<Item>(
		`select ${columns} from import_item where job_id=$1 and ordinal=$2`,
		[jobId, sizes.rows[0].ordinal],
	);
	return result.rows.length === 1 ? result.rows[0] : null;
}
async function ordinaryParent(
	client: PoolClient,
	ownerId: string,
	job: Job,
	item: Item,
	sourceWorkspace: string,
	checkpoint: () => void,
): Promise<{ id: string; workspaceId: string } | Blocked> {
	if (
		(item.collection !== "lists" && item.collection !== "tasks") ||
		item.disposition !== "ensure" ||
		!item.targetId ||
		!item.dependencyProof
	)
		return "parent-unapplied";
	await verifyItem(item, job.plannerVersion, checkpoint);
	const proof = workspaceProof.safeParse(item.dependencyProof);
	if (!proof.success || proof.data.workspace.sourceId !== sourceWorkspace)
		return "workspace-mismatch";
	const workspaceId = proof.data.workspace.targetId;
	const pins = await client.query(
		`select 1 from import_workspace_map where source_id=$1 and owner_user_id=$2 and source_workspace_id=$3 and target_workspace_id=$4`,
		[job.sourceId, ownerId, sourceWorkspace, workspaceId],
	);
	if (pins.rowCount !== 1) return "workspace-mismatch";
	if ((await digestImportContent(item, checkpoint)) !== item.contentDigest)
		fail("invalid-plan-evidence");
	const maps = await client.query<{
		targetId: string;
		workspaceId: string;
		contentDigest: string;
		lastTargetDigest: string;
		lastPlanDigest: string;
		collection: string;
		sourceRowId: string;
	}>(
		`select target_id as "targetId", target_workspace_id as "workspaceId", content_digest as "contentDigest", last_target_digest as "lastTargetDigest", last_plan_digest as "lastPlanDigest", collection, source_row_id as "sourceRowId" from import_source_map where source_id=$1 and owner_user_id=$2 and source_key=$3`,
		[job.sourceId, ownerId, item.sourceKey],
	);
	const map = maps.rows[0];
	if (
		maps.rows.length !== 1 ||
		!map ||
		map.collection !== item.collection ||
		map.sourceRowId !== item.sourceId ||
		map.targetId !== item.targetId ||
		map.workspaceId !== workspaceId ||
		map.contentDigest !== item.contentDigest ||
		map.lastPlanDigest !== job.planDigest
	)
		return "parent-unapplied";
	const live = await client.query<Record<string, unknown>>(
		item.collection === "lists"
			? `select l.* from list l where l.id=$1 and l.workspace_id=$2`
			: `select t.* from task t join list l on l.id=t.list_id where t.id=$1 and l.workspace_id=$2`,
		[item.targetId, workspaceId],
	);
	if (live.rows.length !== 1) return "parent-unavailable";
	const current = await digestImportTarget(
		item.collection,
		live.rows[0],
		checkpoint,
		taskCreatedAtPresent(item.collection, item.payload),
		taskRecurrencePresent(item.collection, item.payload),
	);
	if (current !== map.lastTargetDigest) return "parent-changed";
	return { id: item.targetId, workspaceId };
}
async function historicalParent(
	client: PoolClient,
	ownerId: string,
	jobId: string,
	job: Job,
	item: Item,
	sourceWorkspace: string,
	checkpoint: () => void,
): Promise<{ id: string; workspaceId: string } | Blocked> {
	if (
		job.plannerVersion !== 5 ||
		job.schemaVersion !== 2 ||
		item.collection !== "comments" ||
		item.phase !== "history-comments" ||
		item.disposition !== "ensure" ||
		!item.targetId ||
		!item.dependencyProof ||
		!("parent" in item.dependencyProof)
	)
		return "historical-proof-unavailable";
	await verifyItem(item, 5, checkpoint);
	const frozen = item as HistoryPreviewItem;
	let projected: Awaited<ReturnType<typeof projectHistoricalRow>>;
	try {
		projected = await projectHistoricalRow(
			frozen,
			ownerId,
			"2000-01-01T00:00:00.000Z",
			checkpoint,
		);
	} catch (error) {
		if (error instanceof HistoricalRowError)
			return "historical-proof-unavailable";
		throw error;
	}
	const proof = frozen.dependencyProof;
	if (proof?.parent.kind !== "task") return "historical-proof-unavailable";
	const sizes = await client.query<{ ordinal: number; bytes: number }>(
		`select ordinal, octet_length(i::text) as bytes from import_item i where job_id=$1 and collection='tasks' and target_id=$2 and disposition='ensure' order by ordinal limit 2`,
		[jobId, proof.parent.id],
	);
	if (sizes.rows.length !== 1) return "historical-proof-unavailable";
	if (
		!Number.isSafeInteger(sizes.rows[0].bytes) ||
		sizes.rows[0].bytes < 0 ||
		sizes.rows[0].bytes > 1024 * 1024
	)
		fail("parent-evidence-too-large", 413);
	const candidates = await client.query<Item>(
		`select ${columns} from import_item where job_id=$1 and ordinal=$2`,
		[jobId, sizes.rows[0].ordinal],
	);
	const task = candidates.rows[0];
	if (!task) return "historical-proof-unavailable";
	if (
		proof.parent.dependencySourceKey !== null &&
		proof.parent.dependencySourceKey !== task.sourceKey
	)
		return "historical-proof-unavailable";
	const parent = await ordinaryParent(
		client,
		ownerId,
		job,
		task,
		sourceWorkspace,
		checkpoint,
	);
	if (typeof parent === "string") return parent;
	if (
		parent.id !== proof.parent.id ||
		parent.workspaceId !== proof.parent.workspaceId
	)
		return "workspace-mismatch";
	const seats = await client.query<{ id: string; role: Role }>(
		`select m.id, m.role from membership m join workspace w on w.id=m.workspace_id where m.user_id=$1 and m.workspace_id=$2`,
		[ownerId, parent.workspaceId],
	);
	if (seats.rows.length !== 1 || !WRITE_ROLES.has(seats.rows[0].role))
		return "not-permitted";
	if (seats.rows[0].id !== proof.parent.membershipId)
		return "historical-proof-unavailable";
	const tuple = projected.historical.ledger;
	const ledger = await client.query<{
		targetId: string;
		contentDigest: string;
	}>(
		`select target_id as "targetId", content_digest as "contentDigest" from import_history_ledger where collection='comments' and target_parent_id=$1 and source_namespace=$2 and source_row_id_sha256=$3 and source_row_id=$4`,
		[
			tuple.targetParentId,
			tuple.sourceNamespace,
			tuple.sourceIdHash,
			tuple.sourceId,
		],
	);
	if (
		ledger.rows.length !== 1 ||
		ledger.rows[0].targetId !== item.targetId ||
		ledger.rows[0].contentDigest !== item.contentDigest
	)
		return "historical-proof-unavailable";
	const rows = await client.query<Record<string, unknown>>(
		`select c.* from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id where c.id=$1 and c.task_id=$2 and l.workspace_id=$3`,
		[item.targetId, parent.id, parent.workspaceId],
	);
	const row = rows.rows[0];
	if (rows.rows.length !== 1 || !row) return "parent-unavailable";
	// Imported content is immutable except explicit provenance redaction; do not accept redacted claims.
	for (const [key, value] of Object.entries(projected.row)) {
		if (key === "imported_at") continue;
		const current =
			row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key];
		if (current !== value) return "parent-changed";
	}
	if (
		proof.parent.listId !== null &&
		(!task.payload ||
			typeof task.payload !== "object" ||
			Array.isArray(task.payload) ||
			task.payload.listId !== proof.parent.listId)
	)
		return "historical-proof-unavailable";
	return { id: item.targetId, workspaceId: parent.workspaceId };
}

async function committedDestination(
	client: PoolClient,
	ownerId: string,
	jobId: string,
	job: Job,
	ordinal: number,
	source: z.infer<typeof portableRows.attachments>,
	fingerprint: string,
): Promise<AttachmentMigrationParent["destinationParent"]> {
	const found = await client.query<
		NonNullable<AttachmentMigrationParent["destinationParent"]>
	>(
		`select p.target_parent_kind as kind, p.target_parent_id as id,
   p.target_workspace_id as "workspaceId"
   from attachment_migration p
   join attachment_migration_attempt a on a.association_id=p.id
    and a.owner_user_id=p.owner_user_id and a.id=p.current_attempt_id
    and a.id=p.committed_attempt_id and a.revision=p.revision
    and a.job_id=p.origin_job_id
   join workspace w on w.id=p.target_workspace_id
   join membership m on m.workspace_id=w.id and m.user_id=p.owner_user_id
   where p.owner_user_id=$1 and p.origin_job_id=$2 and p.origin_item_ordinal=$3
    and p.import_source_id=$4 and p.source_attachment_id=$5
    and p.source_fingerprint=$6 and p.source_metadata=$7::jsonb
    and p.document_digest=$8 and p.mapping_digest=$9 and p.plan_digest=$10
    and p.target_parent_kind=$11 and p.committed_at is not null
    and p.revision>0 and m.role in ('owner','admin','member')`,
		[
			ownerId,
			jobId,
			ordinal,
			job.sourceId,
			source.id,
			fingerprint,
			JSON.stringify(source),
			job.documentDigest,
			job.mappingDigest,
			job.planDigest,
			source.parentKind,
		],
	);
	return found.rows.length === 1 ? found.rows[0] : null;
}

// Shares advisory evidence only; callers must lock and recheck before reserve.
async function readAttachmentMigrationParentPage(
	client: PoolClient,
	ownerId: string,
	jobId: string,
	selection:
		| { afterOrdinal: number; limit: number }
		| { ordinal: number; limit: 1 },
	checkpoint: () => void,
) {
	checkpoint();
	const jobs = await client.query<Job>(
		`select j.source_id as "sourceId", j.document_digest as "documentDigest", j.mapping_digest as "mappingDigest", j.plan_digest as "planDigest", j.planner_version as "plannerVersion", s.schema_version as "schemaVersion", j.apply_supported as "applySupported", r.state from import_job j join import_source s on s.id=j.source_id and s.owner_user_id=j.owner_user_id join import_run r on r.job_id=j.id and r.owner_user_id=j.owner_user_id where j.id=$1 and j.owner_user_id=$2`,
		[jobId, ownerId],
	);
	const job = jobs.rows[0];
	if (jobs.rows.length !== 1 || !job) fail("plan-not-found", 404);
	if (job.state !== "completed") fail("import-run-incomplete");
	if (
		job.planDigest !== jobId ||
		!job.applySupported ||
		![2, 3, 4, 5].includes(job.plannerVersion) ||
		![job.documentDigest, job.mappingDigest, job.planDigest].every(
			(value) => hash.safeParse(value).success,
		)
	)
		fail("invalid-plan-evidence");
	const sizes = await client.query<{ ordinal: number; bytes: number }>(
		"ordinal" in selection
			? `select ordinal, octet_length(i::text) as bytes from import_item i where job_id=$1 and collection='attachments' and ordinal=$2 order by ordinal limit 2`
			: `select ordinal, octet_length(i::text) as bytes from import_item i where job_id=$1 and collection='attachments' and ordinal>$2 order by ordinal limit $3`,
		"ordinal" in selection
			? [jobId, selection.ordinal]
			: [jobId, selection.afterOrdinal, selection.limit + 1],
	);
	if (
		"ordinal" in selection &&
		(sizes.rows.length !== 1 || sizes.rows[0].ordinal !== selection.ordinal)
	)
		fail("attachment-not-found", 404);
	const selected = sizes.rows.slice(0, selection.limit);
	if (
		selected.some((row) => !Number.isSafeInteger(row.bytes) || row.bytes < 0) ||
		selected.reduce((sum, row) => sum + row.bytes, 0) > 2 * 1024 * 1024
	)
		fail("parent-evidence-too-large", 413);
	const result = selected.length
		? await client.query<Item>(
				`select ${columns} from import_item where job_id=$1 and ordinal=any($2::int[]) order by ordinal`,
				[jobId, selected.map((row) => row.ordinal)],
			)
		: { rows: [] };
	if (
		result.rows.length !== selected.length ||
		result.rows.some(
			(row, index) =>
				row.ordinal !== selected[index].ordinal ||
				row.collection !== "attachments" ||
				row.disposition !== "ignored",
		)
	)
		fail("invalid-plan-evidence");
	const items: AttachmentMigrationParent[] = [];
	const sourceAttachments: z.infer<typeof portableRows.attachments>[] = [];
	for (const item of result.rows) {
		checkpoint();
		await verifyItem(item, job.plannerVersion, checkpoint);
		const attachment = portableRows.attachments.safeParse(item.payload);
		if (!attachment.success || attachment.data.id !== item.sourceId)
			fail("invalid-plan-evidence");
		const row = attachment.data;
		sourceAttachments.push(row);
		const fingerprint = await hashImportValue(
			"ditero-attachment-migration-source-v1",
			row,
			checkpoint,
		);
		let parent: { id: string; workspaceId: string } | Blocked =
			"uncommitted-source";
		if (
			row.committedAt !== null &&
			row.observedBytes === row.declaredBytes &&
			row.ciphertextSha256 !== null &&
			(row.thumbnailDeclaredBytes === null
				? row.thumbnailObservedBytes === null &&
					row.thumbnailCiphertextSha256 === null
				: row.thumbnailObservedBytes === row.thumbnailDeclaredBytes &&
					row.thumbnailCiphertextSha256 !== null) &&
			Number.isSafeInteger(row.keyVersion) &&
			row.keyVersion <= 2147483647
		) {
			const candidate = await oneParent(
				client,
				jobId,
				row.parentKind === "list"
					? "lists"
					: row.parentKind === "task"
						? "tasks"
						: "comments",
				row.parentId,
			);
			parent = candidate
				? row.parentKind === "comment"
					? await historicalParent(
							client,
							ownerId,
							jobId,
							job,
							candidate,
							row.workspaceId,
							checkpoint,
						)
					: await ordinaryParent(
							client,
							ownerId,
							job,
							candidate,
							row.workspaceId,
							checkpoint,
						)
				: "parent-unapplied";
			if (typeof parent !== "string") {
				const seats = await client.query<{ role: Role }>(
					`select m.role from membership m join workspace w on w.id=m.workspace_id where m.user_id=$1 and m.workspace_id=$2`,
					[ownerId, parent.workspaceId],
				);
				if (seats.rows.length !== 1 || !WRITE_ROLES.has(seats.rows[0].role))
					parent = "not-permitted";
			}
		}
		const durableDestination =
			typeof parent === "string"
				? await committedDestination(
						client,
						ownerId,
						jobId,
						job,
						item.ordinal,
						row,
						fingerprint,
					)
				: null;
		items.push({
			ordinal: item.ordinal,
			sourceAttachmentId: row.id,
			sourceAttachmentFingerprint: fingerprint,
			destinationParent:
				typeof parent === "string"
					? durableDestination
					: { kind: row.parentKind, ...parent },
			blockedReason: typeof parent === "string" ? parent : null,
		});
	}
	checkpoint();
	const page = {
		ownerId,
		jobId,
		sourceId: job.sourceId,
		documentDigest: job.documentDigest,
		mappingDigest: job.mappingDigest,
		planDigest: job.planDigest,
		items,
		nextAfterOrdinal:
			sizes.rows.length > selection.limit
				? (selected.at(-1)?.ordinal ?? null)
				: null,
	};
	return { page, job, sourceAttachments };
}

export async function readAttachmentMigrationParentOnClient(
	client: PoolClient,
	ownerId: string,
	jobId: string,
	ordinal: number,
	checkpoint: () => void,
) {
	if (
		!id.safeParse(ownerId).success ||
		!hash.safeParse(jobId).success ||
		!z.number().int().min(0).max(50_000).safeParse(ordinal).success
	)
		fail("invalid-parent-discovery", 400);
	const result = await readAttachmentMigrationParentPage(
		client,
		ownerId,
		jobId,
		{ ordinal, limit: 1 },
		checkpoint,
	);
	const sourceAttachment = result.sourceAttachments[0];
	const parent = result.page.items[0];
	if (!sourceAttachment || !parent) fail("invalid-plan-evidence");
	return { ownerId, jobId, ...result.job, sourceAttachment, parent };
}

// Advisory only. A later reserve must revalidate all evidence and write/key authority.
export async function getAttachmentMigrationParents(
	pool: Pool,
	ownerId: string,
	jobId: string,
	options: { afterOrdinal?: number; limit?: number; signal?: AbortSignal } = {},
) {
	if (!id.safeParse(ownerId).success || !hash.safeParse(jobId).success)
		fail("invalid-parent-discovery", 400);
	const parsed = optionsSchema.safeParse({
		afterOrdinal: options.afterOrdinal,
		limit: options.limit,
	});
	if (!parsed.success) fail("invalid-parent-discovery", 400);
	const deadline = performance.now() + 15_000;
	const checkpoint = () => {
		if (options.signal?.aborted) fail("import-cancelled", 408);
		if (performance.now() >= deadline) fail("import-timeout", 503);
	};
	return importTransaction(
		pool,
		ownerId,
		async (client) =>
			(
				await readAttachmentMigrationParentPage(
					client,
					ownerId,
					jobId,
					parsed.data,
					checkpoint,
				)
			).page,
		options.signal,
		deadline,
	);
}
