import { describe, expect, test } from "vitest";
import {
	freezeHistoricalImportItem,
	type HistoricalTargetSnapshot,
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
