import { expect, test } from "vitest";
import type { HistoryPreviewItem } from "./import-apply-plan-v2.ts";
import { hashImportValue } from "./import-digest.ts";
import { projectHistoricalRow } from "./import-history-row.ts";
import type { HistoricalCollection } from "./import-plan-v2.ts";
import type { PortableJson } from "./v1.ts";

const namespace = "8f63b9c0-6ac5-4a79-98c2-f0582d21056e";
const ingestion = "2026-10-03T10:00:00.000Z";
const occurred = "2020-01-02T03:04:05.000Z";
const author = {
	kind: "source_claim",
	sourceNamespace: namespace,
	sourcePrincipalId: "foreign-author",
	displayName: "Archive author",
};
async function fixture(
	collection: HistoricalCollection = "comments",
	changes: Record<string, PortableJson> = {},
): Promise<HistoryPreviewItem> {
	const payload = {
		collection,
		targetParentId: "parent",
		sourceRef: { namespace, collection, id: "" },
		...(collection === "comments"
			? { body: "Original", createdAt: occurred, editedAt: null, author }
			: collection === "templates"
				? {
						kind: "task",
						name: "Reusable",
						icon: null,
						content: { kind: "task", task: { title: "Original" } },
						creator: author,
					}
				: {
						occurredAt: occurred,
						action: "habit_unlog",
						habitDate: "2020-01-02",
						beforeHabitStatus: "done",
						afterHabitStatus: null,
						actor: author,
						origin: { kind: "unknown" },
					}),
		...changes,
	} as PortableJson;
	return {
		ordinal: 3,
		collection,
		sourceId: "archive-id",
		sourceKey: await hashImportValue(
			"ditero-import-historical-source-key-v5",
			[collection, "parent", namespace, ""],
			() => {},
		),
		itemDigest: "sealed-elsewhere",
		contentDigest: await hashImportValue(
			`ditero-import-historical-${collection}-v5`,
			payload,
			() => {},
		),
		targetId: "local-target",
		disposition: "ensure",
		payload,
		codes: [],
		phase: `history-${collection}`,
		targetPrecondition: {
			kind: "unmapped",
			authorizedTargetId: "local-target",
		},
		dependencyProof: {
			parent: {
				kind: collection === "templates" ? "workspace" : "task",
				id: "parent",
				workspaceId: "space",
				membershipId: "seat",
				listId: collection === "templates" ? null : "list",
				dependencySourceKey: null,
			},
			ledger: {
				collection,
				targetParentId: "parent",
				sourceNamespace: namespace,
				sourceId: "",
				sourceIdHash:
					"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			},
		},
	};
}

test("projects imported comments with source claims and original historical times", async () => {
	const value = await projectHistoricalRow(
		await fixture(),
		"operator",
		ingestion,
	);
	expect(value.table).toBe("comment");
	expect(value.row).toEqual({
		id: "local-target",
		task_id: "parent",
		author_id: null,
		body: "Original",
		created_at: occurred,
		edited_at: null,
		source_namespace: namespace,
		source_row_id: "",
		historical_author_kind: "source_claim",
		historical_author_namespace: namespace,
		historical_author_principal_id: "foreign-author",
		historical_author_name: "Archive author",
		imported_at: ingestion,
		provenance_redacted_at: null,
	});
});
test("keeps template operator ownership separate from historical creator", async () => {
	const value = await projectHistoricalRow(
		await fixture("templates"),
		"operator",
		ingestion,
	);
	expect(value.table).toBe("template");
	expect(value.row).toMatchObject({
		workspace_id: "parent",
		created_by: "operator",
		historical_creator_principal_id: "foreign-author",
		content: { kind: "task", task: { title: "Original" } },
	});
});
test("projects habit events into the imported table with explicit absent task fields", async () => {
	const value = await projectHistoricalRow(
		await fixture("completionEvents"),
		"operator",
		ingestion,
	);
	expect(value.table).toBe("imported_completion_event");
	expect(value.row).toMatchObject({
		action: "habit_unlog",
		occurred_at: occurred,
		ingested_at: ingestion,
		before_due_at: null,
		before_due_all_day: null,
		before_done: null,
		after_due_at: null,
		after_done: null,
		habit_date: "2020-01-02",
		before_habit_status: "done",
		after_habit_status: null,
		origin_kind: "unknown",
		origin_mechanism: null,
		origin_label: null,
	});
});
test.each([
	["comments", { author: { kind: "native_user", principalId: "operator" } }],
	["templates", { creator: { kind: "native_user", principalId: "operator" } }],
	[
		"completionEvents",
		{ actor: { kind: "native_user", principalId: "operator" } },
	],
	[
		"completionEvents",
		{ origin: { kind: "native", mechanism: "member_mutation" } },
	],
	["comments", { unexpected: "unsealed field" }],
	["completionEvents", { afterHabitStatus: "done" }],
] as const)("refuses unnormalized or invalid %s evidence", async (collection, changes) => {
	await expect(
		projectHistoricalRow(
			await fixture(collection, changes),
			"operator",
			ingestion,
		),
	).rejects.toThrow("invalid-plan-evidence");
});
test.each([
	"content",
	"source",
	"parent",
	"phase",
	"tuple",
])("refuses changed %s evidence before a writer is selected", async (change) => {
	const item = await fixture();
	if (change === "content") item.contentDigest = "changed";
	if (change === "source") item.sourceKey = "changed";
	if (change === "parent" && item.dependencyProof)
		item.dependencyProof.parent.id = "other-parent";
	if (change === "phase") item.phase = "comments";
	if (change === "tuple" && item.dependencyProof)
		item.dependencyProof.ledger.sourceId = "different";
	await expect(
		projectHistoricalRow(item, "operator", ingestion),
	).rejects.toThrow("invalid-plan-evidence");
});
