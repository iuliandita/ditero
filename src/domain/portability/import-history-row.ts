import type { HistoryPreviewItem } from "./import-apply-plan-v2.ts";
import { hashImportValue } from "./import-digest.ts";
import type { HistoricalImportItem } from "./import-plan-v2.ts";
import type { PortableJson } from "./v1.ts";
import type { PortableAuthorV2, PortableOriginV2 } from "./v2.ts";
import { portableTimestamp, unchanged } from "./validate.ts";
import { portableHistoryRowsV2 } from "./validate-v2.ts";

export class HistoricalRowError extends Error {
	constructor() {
		super("invalid-plan-evidence");
	}
}
function fail(): never {
	throw new HistoricalRowError();
}
function claim(author: PortableAuthorV2, prefix: string) {
	if (author.kind === "native_user") fail();
	if (
		author.kind === "source_claim" &&
		author.sourceNamespace !== author.sourceNamespace.toLowerCase()
	)
		fail();
	return {
		[`${prefix}_kind`]: author.kind,
		[`${prefix}_namespace`]:
			author.kind === "source_claim" ? author.sourceNamespace : null,
		[`${prefix}_principal_id`]:
			author.kind === "source_claim" ? author.sourcePrincipalId : null,
		[`${prefix}_name`]:
			author.kind === "source_claim" ? author.displayName : null,
	};
}
function origin(origin: PortableOriginV2) {
	if (origin.kind === "native") fail();
	return {
		origin_kind: origin.kind,
		origin_mechanism: origin.kind === "source_claim" ? origin.mechanism : null,
		origin_label: origin.kind === "source_claim" ? origin.label : null,
	};
}

// Revalidate persisted evidence before selecting any writer or SQL projection.
export async function projectHistoricalRow(
	frozen: HistoryPreviewItem,
	ownerId: string,
	ingestedAt: string,
	checkpoint: () => void = () => {},
): Promise<{
	historical: HistoricalImportItem;
	table: "comment" | "template" | "imported_completion_event";
	row: Record<string, PortableJson>;
}> {
	checkpoint();
	const payload = frozen.payload;
	const proof = frozen.dependencyProof;
	if (
		!ownerId ||
		!portableTimestamp.safeParse(ingestedAt).success ||
		!frozen.targetId ||
		frozen.disposition !== "ensure" ||
		!proof ||
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!Object.hasOwn(portableHistoryRowsV2, frozen.collection)
	)
		fail();
	const { collection, targetParentId, ...content } = payload;
	const tuple = proof.ledger;
	if (
		collection !== frozen.collection ||
		targetParentId !== tuple.targetParentId ||
		proof.parent.id !== targetParentId ||
		proof.parent.kind !==
			(frozen.collection === "templates" ? "workspace" : "task") ||
		tuple.collection !== frozen.collection ||
		tuple.sourceNamespace !== tuple.sourceNamespace.toLowerCase() ||
		frozen.phase !== `history-${frozen.collection}`
	)
		fail();
	const candidate = {
		...content,
		id: frozen.targetId,
		[frozen.collection === "templates" ? "workspaceId" : "taskId"]:
			targetParentId,
	};
	const parsed = portableHistoryRowsV2[frozen.collection].safeParse(candidate);
	if (!parsed.success || !unchanged(candidate, parsed.data)) fail();
	const source = parsed.data.sourceRef;
	const rawHash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(source.id),
	);
	const sourceHash = Array.from(new Uint8Array(rawHash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (
		source.namespace !== tuple.sourceNamespace ||
		source.id !== tuple.sourceId ||
		sourceHash !== tuple.sourceIdHash ||
		(await hashImportValue(
			`ditero-import-historical-${frozen.collection}-v5`,
			payload,
			checkpoint,
		)) !== frozen.contentDigest ||
		(await hashImportValue(
			"ditero-import-historical-source-key-v5",
			[frozen.collection, targetParentId, source.namespace, source.id],
			checkpoint,
		)) !== frozen.sourceKey
	)
		fail();
	const historical: HistoricalImportItem = {
		collection: frozen.collection,
		archiveRowId: frozen.sourceId,
		archiveParentId: "",
		parentKind: proof.parent.kind,
		ledger: structuredClone(tuple),
		semanticPayload: structuredClone(payload),
		semanticDigest: frozen.contentDigest,
	};
	const common = {
		id: frozen.targetId,
		source_namespace: source.namespace,
		source_row_id: source.id,
		provenance_redacted_at: null,
	};
	if ("author" in parsed.data) {
		const row = parsed.data;
		return {
			historical,
			table: "comment",
			row: {
				...common,
				task_id: row.taskId,
				author_id: null,
				body: row.body,
				created_at: row.createdAt,
				edited_at: row.editedAt,
				imported_at: ingestedAt,
				...claim(row.author, "historical_author"),
			},
		};
	}
	if ("creator" in parsed.data) {
		const row = parsed.data;
		return {
			historical,
			table: "template",
			row: {
				...common,
				workspace_id: row.workspaceId,
				kind: row.kind,
				name: row.name,
				icon: row.icon,
				content: row.content,
				created_by: ownerId,
				imported_at: ingestedAt,
				...claim(row.creator, "historical_creator"),
			},
		};
	}
	const row = parsed.data;
	return {
		historical,
		table: "imported_completion_event",
		row: {
			...common,
			task_id: row.taskId,
			occurred_at: row.occurredAt,
			ingested_at: ingestedAt,
			action: row.action,
			before_due_at: "beforeDueAt" in row ? row.beforeDueAt : null,
			before_due_all_day: "beforeDueAllDay" in row ? row.beforeDueAllDay : null,
			before_done: "beforeDone" in row ? row.beforeDone : null,
			after_due_at: "afterDueAt" in row ? row.afterDueAt : null,
			after_done: "afterDone" in row ? row.afterDone : null,
			habit_date: "habitDate" in row ? row.habitDate : null,
			before_habit_status:
				"beforeHabitStatus" in row ? row.beforeHabitStatus : null,
			after_habit_status:
				"afterHabitStatus" in row ? row.afterHabitStatus : null,
			...claim(row.actor, "actor"),
			...origin(row.origin),
		},
	};
}
