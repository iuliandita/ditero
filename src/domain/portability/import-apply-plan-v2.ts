import type {
	HistoricalImportItem,
	HistoricalLedgerTuple,
} from "./import-plan-v2.ts";

export type HistoricalTargetSnapshot =
	| { kind: "unmapped"; authorizedTargetId: string }
	| {
			kind: "mapped";
			ledger: HistoricalLedgerTuple;
			semanticDigest: string;
			authorizedTargetId: string;
			ledgerTargetId: string;
			target:
				| { state: "live"; id: string; parentId: string }
				| { state: "tombstone"; id: string };
	  };

export type HistoricalFreezeDecision =
	| { disposition: "create" | "replay" | "tombstone"; targetId: string }
	| {
			disposition: "conflict";
			code:
				| "historical-ledger-tuple-conflict"
				| "historical-content-conflict"
				| "historical-target-conflict";
	  };

function sameTuple(a: HistoricalLedgerTuple, b: HistoricalLedgerTuple) {
	return (
		a.collection === b.collection &&
		a.targetParentId === b.targetParentId &&
		a.sourceNamespace === b.sourceNamespace &&
		a.sourceIdHash === b.sourceIdHash &&
		a.sourceId === b.sourceId
	);
}

// Snapshot acquisition, parent authorization and locking belong to the store.
export function freezeHistoricalImportItem(
	item: HistoricalImportItem,
	snapshot: HistoricalTargetSnapshot,
): HistoricalFreezeDecision {
	if (snapshot.kind === "unmapped") {
		return snapshot.authorizedTargetId
			? { disposition: "create", targetId: snapshot.authorizedTargetId }
			: { disposition: "conflict", code: "historical-target-conflict" };
	}
	if (!sameTuple(item.ledger, snapshot.ledger))
		return {
			disposition: "conflict",
			code: "historical-ledger-tuple-conflict",
		};
	if (item.semanticDigest !== snapshot.semanticDigest)
		return { disposition: "conflict", code: "historical-content-conflict" };
	if (
		!snapshot.ledgerTargetId ||
		snapshot.authorizedTargetId !== snapshot.ledgerTargetId ||
		snapshot.target.id !== snapshot.ledgerTargetId ||
		(snapshot.target.state === "live" &&
			snapshot.target.parentId !== item.ledger.targetParentId)
	)
		return { disposition: "conflict", code: "historical-target-conflict" };
	return {
		disposition: snapshot.target.state === "live" ? "replay" : "tombstone",
		targetId: snapshot.ledgerTargetId,
	};
}
