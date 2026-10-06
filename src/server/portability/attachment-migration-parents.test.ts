import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	digestImportContent,
	type FrozenImportItem,
} from "../../domain/portability/import-apply-plan.ts";
import type { HistoryPreviewItem } from "../../domain/portability/import-apply-plan-v2.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import { projectHistoricalRow } from "../../domain/portability/import-history-row.ts";
import type { PortableJson } from "../../domain/portability/v1.ts";
import {
	getAttachmentMigrationParents,
	readAttachmentMigrationParentOnClient,
} from "./attachment-migration-parents.ts";
import { digestImportTarget } from "./import-target.ts";

const jobId = "c".repeat(64);
const owner = "caller",
	source = "source",
	sourceWorkspace = "original-space",
	workspace = "target-space";
const checkpoint = () => {};
const hash = (domain: string, value: PortableJson) =>
	hashImportValue(domain, value, checkpoint);
async function seal<T extends FrozenImportItem | HistoryPreviewItem>(
	item: T,
	version: number,
) {
	const { itemDigest: _digest, ...evidence } = item;
	item.itemDigest = await hash(
		`ditero-import-item-v${version}`,
		evidence as unknown as PortableJson,
	);
	return item;
}
async function fixture(kind: "list" | "task" | "comment" = "list") {
	const version = kind === "comment" ? 5 : 4;
	const job = {
		sourceId: source,
		documentDigest: "a".repeat(64),
		mappingDigest: "b".repeat(64),
		planDigest: "c".repeat(64),
		plannerVersion: version,
		schemaVersion: kind === "comment" ? 2 : 1,
		state: "completed",
		applySupported: true,
	};
	const list = {
		id: "target-parent",
		workspace_id: workspace,
		owner_id: owner,
		title: "Imported list",
		kind: "tasks",
		icon: null,
		folder_id: null,
		sort_key: "a0",
		completed_display: "sink",
	};
	const task = {
		id: "target-parent",
		list_id: "target-list",
		title: "Imported task",
		done: false,
		notes: null,
		due_at: null,
		due_all_day: false,
		priority: 0,
		completed_at: null,
		sort_key: "a0",
		parent_id: null,
		quantity: null,
		unit: null,
		category: null,
		rrule: null,
		recurrence_relative: false,
		reminder_time: null,
		repeat_every_min: null,
		max_repeats: null,
		fallback_user_id: null,
		urgent: false,
	};
	const live: Record<string, unknown> = kind === "list" ? list : task;
	const collection = kind === "list" ? "lists" : "tasks";
	const payload: Record<string, PortableJson> = {
		id: "target-parent",
		...(kind === "list"
			? { workspaceId: workspace, title: "Imported list" }
			: { listId: "target-list", title: "Imported task" }),
	};
	const parent: FrozenImportItem = {
		ordinal: 2,
		collection,
		sourceId: "original-parent",
		sourceKey: await hash("ditero-import-source-key-v1", [
			owner,
			source,
			collection,
			"original-parent",
		]),
		itemDigest: "",
		contentDigest: "",
		targetId: "target-parent",
		disposition: "ensure",
		payload,
		codes: [],
		phase: kind === "list" ? "lists" : "root-tasks",
		targetPrecondition: { kind: "absent", naturalKey: null },
		dependencyProof: {
			workspace: { sourceId: sourceWorkspace, targetId: workspace },
			rows: [],
		},
	};
	parent.contentDigest = await digestImportContent(parent, checkpoint);
	await seal(parent, version);
	const sourceRow = {
		id: "original-file",
		workspaceId: sourceWorkspace,
		parentKind: kind,
		parentId: kind === "comment" ? "archive-comment" : "original-parent",
		keyVersion: 1,
		declaredBytes: 100,
		observedBytes: 100,
		ciphertextSha256: "d".repeat(64),
		thumbnailDeclaredBytes: null,
		thumbnailObservedBytes: null,
		thumbnailCiphertextSha256: null,
		uploadedBy: owner,
		createdAt: "2026-10-05T00:00:00.000Z",
		committedAt: "2026-10-05T00:00:00.000Z",
	};
	const attachment: FrozenImportItem = {
		ordinal: 9,
		collection: "attachments",
		sourceId: sourceRow.id,
		sourceKey: "e".repeat(64),
		itemDigest: "",
		contentDigest: "f".repeat(64),
		targetId: null,
		disposition: "ignored",
		payload: sourceRow,
		codes: ["attachment-content-excluded"],
		phase: null,
		targetPrecondition: null,
		dependencyProof: null,
	};
	await seal(attachment, version);
	const map = {
		targetId: "target-parent",
		workspaceId: workspace,
		contentDigest: parent.contentDigest,
		lastTargetDigest: await digestImportTarget(collection, live, checkpoint),
		lastPlanDigest: job.planDigest,
		collection,
		sourceRowId: parent.sourceId,
	};
	const namespace = "8f63b9c0-6ac5-4a79-98c2-f0582d21056e";
	const historyPayload = {
		collection: "comments",
		targetParentId: "target-parent",
		sourceRef: { namespace, collection: "comments", id: "external-comment" },
		body: "Imported comment",
		createdAt: "2020-01-02T03:04:05.000Z",
		editedAt: null,
		author: { kind: "unknown" },
	};
	const history: HistoryPreviewItem = {
		ordinal: 5,
		collection: "comments",
		sourceId: "archive-comment",
		sourceKey: await hash("ditero-import-historical-source-key-v5", [
			"comments",
			"target-parent",
			namespace,
			"external-comment",
		]),
		itemDigest: "",
		contentDigest: await hash(
			"ditero-import-historical-comments-v5",
			historyPayload,
		),
		targetId: "target-comment",
		disposition: "ensure",
		payload: historyPayload,
		codes: [],
		phase: "history-comments",
		targetPrecondition: {
			kind: "unmapped",
			authorizedTargetId: "target-comment",
		},
		dependencyProof: {
			parent: {
				kind: "task",
				id: "target-parent",
				workspaceId: workspace,
				membershipId: "seat",
				listId: "target-list",
				dependencySourceKey: null,
			},
			ledger: {
				collection: "comments",
				targetParentId: "target-parent",
				sourceNamespace: namespace,
				sourceId: "external-comment",
				sourceIdHash: createHash("sha256")
					.update("external-comment")
					.digest("hex"),
			},
		},
	};
	await seal(history, 5);
	const comment = (
		await projectHistoricalRow(history, owner, "2026-10-05T00:00:00.000Z")
	).row;
	const ledger = {
		targetId: "target-comment",
		contentDigest: history.contentDigest,
	};
	const state = {
		job,
		parent,
		attachment,
		map,
		live,
		history,
		comment,
		ledger,
		parentPresent: true,
		livePresent: true,
		pin: true,
		role: "member",
		ledgerPresent: true,
		commentPresent: true,
		page: [{ ordinal: 9, bytes: 600 }],
	};
	const query = vi.fn(
		async (
			sql: string,
			args: unknown[] = [],
		): Promise<{ rows: unknown[]; rowCount: number }> => {
			const rows = (items: unknown[]) => ({
				rows: items,
				rowCount: items.length,
			});
			if (
				sql === "begin" ||
				sql === "commit" ||
				sql === "rollback" ||
				sql.startsWith("select set_config")
			)
				return rows([]);
			if (sql.includes('from "user"')) return rows([{ id: owner }]);
			if (sql.includes("from import_job j"))
				return rows(args[1] === owner ? [state.job] : []);
			if (sql.includes("collection='attachments'"))
				return rows(
					sql.includes("ordinal=$2")
						? state.page.filter((row) => row.ordinal === args[1])
						: state.page,
				);
			if (sql.includes("ordinal=any")) return rows([state.attachment]);
			if (sql.includes("octet_length(i::text)")) {
				if (!state.parentPresent) return rows([]);
				return rows([{ ordinal: args[1] === "comments" ? 5 : 2, bytes: 500 }]);
			}
			if (sql.includes("from import_item where"))
				return rows([args[1] === 5 ? state.history : state.parent]);
			if (sql.includes("from import_workspace_map"))
				return rows(state.pin ? [{}] : []);
			if (sql.includes("from import_source_map")) return rows([state.map]);
			if (sql.includes("from attachment_migration p")) return rows([]);
			if (sql.includes("from import_history_ledger"))
				return rows(state.ledgerPresent ? [state.ledger] : []);
			if (sql.includes("from list l") || sql.includes("from task t"))
				return rows(state.livePresent ? [state.live] : []);
			if (sql.includes("from comment c"))
				return rows(state.commentPresent ? [state.comment] : []);
			if (sql.includes("from membership m"))
				return rows([{ id: "seat", role: state.role }]);
			throw new Error(`Unexpected query ${sql}`);
		},
	);
	const release = vi.fn();
	const connect = vi.fn(async () => ({ query, release }));
	const pool = { connect } as unknown as Pool;
	return { state, pool, query, connect, release };
}
describe("applied attachment parent discovery", () => {
	it.each([
		"list",
		"task",
	] as const)("resolves same-job %s mapping and exposes bounded provenance, not key permissions", async (kind) => {
		const f = await fixture(kind);
		const result = await getAttachmentMigrationParents(f.pool, owner, jobId);
		expect(result).toMatchObject({
			ownerId: owner,
			jobId,
			sourceId: source,
			documentDigest: "a".repeat(64),
			mappingDigest: "b".repeat(64),
			planDigest: "c".repeat(64),
			nextAfterOrdinal: null,
		});
		expect(result.items[0]).toMatchObject({
			ordinal: 9,
			sourceAttachmentId: "original-file",
			destinationParent: { kind, id: "target-parent", workspaceId: workspace },
			blockedReason: null,
		});
		expect(result.items[0].sourceAttachmentFingerprint).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(result.items[0]).not.toHaveProperty("keyVersion");
		expect(f.release).toHaveBeenCalledOnce();
	});
	it("resolves history comment by archive ID with distinct external sourceRef ledger identity", async () => {
		const f = await fixture("comment");
		const result = await getAttachmentMigrationParents(f.pool, owner, jobId);
		expect(result.items[0]).toMatchObject({
			destinationParent: {
				kind: "comment",
				id: "target-comment",
				workspaceId: workspace,
			},
			blockedReason: null,
		});
		const call = f.query.mock.calls.find(([sql]) =>
			sql.includes("from import_history_ledger"),
		);
		expect(call?.[1]).toEqual([
			"target-parent",
			"8f63b9c0-6ac5-4a79-98c2-f0582d21056e",
			createHash("sha256").update("external-comment").digest("hex"),
			"external-comment",
		]);
	});
	it.each([
		"pending",
		"running",
		"conflict",
	])("rejects %s content run before materializing any attachment payload", async (state) => {
		const f = await fixture();
		f.state.job.state = state;
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "import-run-incomplete",
			status: 409,
		});
		expect(
			f.query.mock.calls.some(([sql]) =>
				sql.includes("collection='attachments'"),
			),
		).toBe(false);
	});
	it.each([
		"viewer",
		"none",
	])("blocks current nonwrite role %s", async (role) => {
		const f = await fixture();
		f.state.role = role;
		expect(
			(await getAttachmentMigrationParents(f.pool, owner, jobId)).items[0]
				.blockedReason,
		).toBe("not-permitted");
	});
	it.each([
		"deleted",
		"edited",
		"remapped",
		"another-plan",
		"workspace",
	])("refuses %s parent evidence while retaining explicit blocked item", async (change) => {
		const f = await fixture();
		if (change === "deleted") f.state.livePresent = false;
		if (change === "edited") f.state.live.title = "Changed";
		if (change === "remapped") f.state.map.targetId = "other-target";
		if (change === "another-plan") f.state.map.lastPlanDigest = "a".repeat(64);
		if (change === "workspace") f.state.pin = false;
		const item = (await getAttachmentMigrationParents(f.pool, owner, jobId))
			.items[0];
		expect(item.destinationParent).toBeNull();
		expect(item.blockedReason).toBe(
			change === "deleted"
				? "parent-unavailable"
				: change === "edited"
					? "parent-changed"
					: change === "workspace"
						? "workspace-mismatch"
						: "parent-unapplied",
		);
	});
	it("rejects malformed frozen attachment even if its item digest is resealed", async () => {
		const f = await fixture();
		f.state.attachment.payload = { bad: "shape" };
		await seal(f.state.attachment, 4);
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "invalid-plan-evidence",
			status: 409,
		});
	});
	it("refuses changed frozen bytes without their original digest", async () => {
		const f = await fixture();
		f.state.attachment.payload = {
			...(f.state.attachment.payload as object),
			observedBytes: 99,
		} as PortableJson;
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "invalid-plan-evidence",
			status: 409,
		});
	});
	it("returns explicit uncommitted source refusal", async () => {
		const f = await fixture();
		f.state.attachment.payload = {
			...(f.state.attachment.payload as object),
			committedAt: null,
		} as PortableJson;
		await seal(f.state.attachment, 4);
		expect(
			(await getAttachmentMigrationParents(f.pool, owner, jobId)).items[0]
				.blockedReason,
		).toBe("uncommitted-source");
	});
	it.each([
		"missing-ledger",
		"different-target",
		"different-content",
		"redacted",
		"missing-comment",
	])("does not fabricate historical authority for %s", async (change) => {
		const f = await fixture("comment");
		if (change === "missing-ledger") f.state.ledgerPresent = false;
		if (change === "different-target") f.state.ledger.targetId = "foreign";
		if (change === "different-content")
			f.state.ledger.contentDigest = "0".repeat(64);
		if (change === "redacted")
			f.state.comment.provenance_redacted_at = "2026-10-05T00:00:00.000Z";
		if (change === "missing-comment") f.state.commentPresent = false;
		const item = (await getAttachmentMigrationParents(f.pool, owner, jobId))
			.items[0];
		expect(item.destinationParent).toBeNull();
		expect(item.blockedReason).toBe(
			change === "redacted"
				? "parent-changed"
				: change === "missing-comment"
					? "parent-unavailable"
					: "historical-proof-unavailable",
		);
	});
	it("uses keyset cursor and size-only lookahead without returning a 65th item", async () => {
		const f = await fixture();
		f.state.page = [
			{ ordinal: 9, bytes: 600 },
			{ ordinal: 10, bytes: 600 },
		];
		const result = await getAttachmentMigrationParents(f.pool, owner, jobId, {
			afterOrdinal: 8,
			limit: 1,
		});
		expect(result.items).toHaveLength(1);
		expect(result.nextAfterOrdinal).toBe(9);
		expect(
			f.query.mock.calls.find(([sql]) =>
				sql.includes("collection='attachments'"),
			)?.[1],
		).toEqual([jobId, 8, 2]);
	});
	it("refuses excess payload size before fetching its JSON", async () => {
		const f = await fixture();
		f.state.page = [{ ordinal: 9, bytes: 3 * 1024 * 1024 }];
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "parent-evidence-too-large",
			status: 413,
		});
		expect(
			f.query.mock.calls.some(([sql]) => sql.includes("ordinal=any")),
		).toBe(false);
	});
	it("rejects invalid limits and preaborted requests before acquiring a connection", async () => {
		const f = await fixture();
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId, { limit: 65 }),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "invalid-parent-discovery",
			status: 400,
		});
		const signal = AbortSignal.abort();
		await expect(
			getAttachmentMigrationParents(f.pool, owner, jobId, { signal }),
		).rejects.toMatchObject({
			name: "ImportPlanStoreError",
			code: "import-cancelled",
			status: 408,
		});
		expect(f.connect).not.toHaveBeenCalled();
	});
});

describe("same-client attachment parent reader", () => {
	it.each([
		-1,
		50_001,
		1.5,
		NaN,
		Infinity,
	])("refuses invalid ordinal %s before SQL", async (ordinal) => {
		const f = await fixture();
		await expect(
			readAttachmentMigrationParentOnClient(
				{ query: f.query } as unknown as PoolClient,
				owner,
				jobId,
				ordinal,
				checkpoint,
			),
		).rejects.toMatchObject({ code: "invalid-parent-discovery" });
		expect(f.query).not.toHaveBeenCalled();
	});
	it("does not fall forward to the next attachment", async () => {
		const f = await fixture();
		await expect(
			readAttachmentMigrationParentOnClient(
				{ query: f.query } as unknown as PoolClient,
				owner,
				jobId,
				8,
				checkpoint,
			),
		).rejects.toMatchObject({ code: "attachment-not-found" });
		expect(
			f.query.mock.calls.find(([sql]) =>
				sql.includes("collection='attachments'"),
			)?.[1],
		).toEqual([jobId, 8]);
	});
	it("requires the completed job's owner", async () => {
		const f = await fixture();
		await expect(
			readAttachmentMigrationParentOnClient(
				{ query: f.query } as unknown as PoolClient,
				"other",
				jobId,
				9,
				checkpoint,
			),
		).rejects.toMatchObject({ code: "plan-not-found" });
	});
	it.each([
		"list",
		"task",
		"comment",
	] as const)("reuses the callback client and checkpoint for %s", async (kind) => {
		const f = await fixture(kind);
		const check = vi.fn();
		const result = await readAttachmentMigrationParentOnClient(
			{ query: f.query } as unknown as PoolClient,
			owner,
			jobId,
			9,
			check,
		);
		expect(result.sourceAttachment).toEqual(f.state.attachment.payload);
		expect(result).toMatchObject({
			ownerId: owner,
			jobId,
			sourceId: source,
			planDigest: jobId,
			state: "completed",
			parent: { ordinal: 9, blockedReason: null },
		});
		expect(check).toHaveBeenCalled();
		expect(f.connect).not.toHaveBeenCalled();
		expect(f.release).not.toHaveBeenCalled();
		expect(
			f.query.mock.calls.some(([sql]) =>
				["begin", "commit", "rollback"].includes(sql),
			),
		).toBe(false);
	});
});
