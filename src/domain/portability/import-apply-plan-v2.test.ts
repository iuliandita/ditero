import { describe, expect, test } from "vitest";
import {
	freezeHistoricalImportItem,
	type HistoricalFrozenTarget,
	type HistoricalTargetSnapshot,
	sealHistoryPreviewPlan,
} from "./import-apply-plan-v2.ts";
import type { HistoricalImportItem } from "./import-plan-v2.ts";

const item: HistoricalImportItem = {
	collection: "comments",
	archiveRowId: "archive-local-id",
	archiveParentId: "source-task",
	parentKind: "task",
	ledger: {
		collection: "comments",
		targetParentId: "target-task",
		sourceNamespace: "8f63b9c0-6ac5-4a79-98c2-f0582d21056e",
		sourceIdHash: "source-id-sha256",
		sourceId: "",
	},
	semanticPayload: { body: "Original" },
	semanticDigest: "original-digest",
};

function mapped(): Extract<HistoricalTargetSnapshot, { kind: "mapped" }> {
	return {
		kind: "mapped",
		ledger: structuredClone(item.ledger),
		semanticDigest: item.semanticDigest,
		authorizedTargetId: "saved-target",
		ledgerTargetId: "saved-target",
		target: { state: "live", id: "saved-target", parentId: "target-task" },
	};
}

describe("v5 historical freeze decisions", () => {
	test("creates only from an authorized unmapped snapshot", () => {
		expect(
			freezeHistoricalImportItem(item, {
				kind: "unmapped",
				authorizedTargetId: "new-target",
			}),
		).toEqual({ disposition: "create", targetId: "new-target" });
		expect(
			freezeHistoricalImportItem(item, {
				kind: "unmapped",
				authorizedTargetId: "",
			}),
		).toEqual({ disposition: "conflict", code: "historical-target-conflict" });
	});

	test("replays only matching live tuples, digests and targets", () => {
		expect(freezeHistoricalImportItem(item, mapped())).toEqual({
			disposition: "replay",
			targetId: "saved-target",
		});
		const changed = mapped();
		changed.semanticDigest = "changed-payload";
		expect(freezeHistoricalImportItem(item, changed)).toEqual({
			disposition: "conflict",
			code: "historical-content-conflict",
		});
	});

	test("never recreates a tombstoned original target", () => {
		const gone = mapped();
		gone.target = { state: "tombstone", id: "saved-target" };
		expect(freezeHistoricalImportItem(item, gone)).toEqual({
			disposition: "tombstone",
			targetId: "saved-target",
		});
	});

	test("checks exact tuples even if source hashes collide", () => {
		const collision = mapped();
		collision.ledger.sourceId = "other-id";
		expect(freezeHistoricalImportItem(item, collision)).toEqual({
			disposition: "conflict",
			code: "historical-ledger-tuple-conflict",
		});
		const otherParent = mapped();
		otherParent.ledger.targetParentId = "other-parent";
		expect(freezeHistoricalImportItem(item, otherParent)).toEqual({
			disposition: "conflict",
			code: "historical-ledger-tuple-conflict",
		});
	});

	test("rejects conflicting frozen target and moved live target", () => {
		const changedId = mapped();
		changedId.authorizedTargetId = "different-target";
		expect(freezeHistoricalImportItem(item, changedId)).toEqual({
			disposition: "conflict",
			code: "historical-target-conflict",
		});
		const moved = mapped();
		if (moved.target.state !== "live") throw new Error("fixture");
		moved.target.parentId = "another-task";
		expect(freezeHistoricalImportItem(item, moved)).toEqual({
			disposition: "conflict",
			code: "historical-target-conflict",
		});
	});
});

describe("sealed history previews", () => {
	const context = {
		ownerUserId: "owner",
		sourceId: "source",
		documentDigest: "document",
		mappingDigest: "mappings",
	};
	const frozen = (): HistoricalFrozenTarget => ({
		parent: {
			kind: "task",
			id: "target-task",
			workspaceId: "space",
			membershipId: "seat",
			listId: "list",
			dependencySourceKey: null,
		},
		snapshot: mapped(),
		decision: { disposition: "replay", targetId: "saved-target" },
	});
	const key = JSON.stringify([item.collection, item.archiveRowId]);
	test("retains normalized history and exact parent evidence without enabling apply", async () => {
		const value = frozen();
		const first = await sealHistoryPreviewPlan(
			[],
			[item],
			new Map([[key, value]]),
			context,
		);
		const second = await sealHistoryPreviewPlan(
			[],
			[item],
			new Map([[key, value]]),
			context,
		);
		expect(first).toEqual(second);
		expect(first.report).toMatchObject({
			plannerVersion: 5,
			applySupported: false,
			applyBlockedReason: "history-apply-unsupported",
			counts: { ensure: 1, ignored: 0, blocked: 0 },
		});
		expect(first.items[0]).toMatchObject({
			ordinal: 0,
			sourceId: item.archiveRowId,
			payload: { body: "Original" },
			targetId: "saved-target",
			targetPrecondition: mapped(),
			dependencyProof: { parent: value.parent, ledger: item.ledger },
		});
		const changed = frozen();
		changed.parent.membershipId = "replacement-seat";
		expect(
			(
				await sealHistoryPreviewPlan(
					[],
					[item],
					new Map([[key, changed]]),
					context,
				)
			).planDigest,
		).not.toBe(first.planDigest);
	});
	test("reports blocked parents and immutable-content conflicts separately", async () => {
		const blocked = await sealHistoryPreviewPlan(
			[],
			[item],
			new Map(),
			context,
		);
		expect(blocked.items[0]).toMatchObject({
			disposition: "blocked",
			codes: ["blocked-dependency"],
			targetId: null,
		});
		const value = frozen();
		if (value.snapshot.kind !== "mapped") throw new Error("fixture");
		value.snapshot.semanticDigest = "changed";
		const conflict = await sealHistoryPreviewPlan(
			[],
			[item],
			new Map([[key, value]]),
			context,
		);
		expect(conflict.items[0]).toMatchObject({
			disposition: "blocked",
			codes: ["historical-content-conflict"],
		});
	});
	test("rejects mismatched parent authority and invented absent-parent dependencies", async () => {
		const value = frozen();
		value.parent.id = "other-task";
		await expect(
			sealHistoryPreviewPlan([], [item], new Map([[key, value]]), context),
		).rejects.toMatchObject({ code: "invalid-mappings" });
		value.parent.id = item.ledger.targetParentId;
		value.parent.dependencySourceKey = "invented";
		await expect(
			sealHistoryPreviewPlan([], [item], new Map([[key, value]]), context),
		).rejects.toMatchObject({ code: "invalid-mappings" });
	});
});
