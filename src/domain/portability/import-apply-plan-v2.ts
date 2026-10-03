import type { FrozenImportItem } from "./import-apply-plan.ts";
import { hashImportValue } from "./import-digest.ts";
import { ImportPlanError } from "./import-plan.ts";
import type {
	HistoricalImportItem,
	HistoricalLedgerTuple,
} from "./import-plan-v2.ts";
import type { PortableJson } from "./v1.ts";

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

export type HistoricalParentProof = {
	kind: "task" | "workspace";
	id: string;
	workspaceId: string;
	membershipId: string;
	listId: string | null;
	dependencySourceKey: string | null;
};
export type HistoricalFrozenTarget = {
	parent: HistoricalParentProof;
	snapshot: HistoricalTargetSnapshot;
	decision: HistoricalFreezeDecision;
};
export type HistoryPreviewReport = {
	plannerVersion: 5;
	applySupported: false;
	applyBlockedReason: "history-apply-unsupported";
	counts: { ensure: number; ignored: number; blocked: number };
	findings: { code: string; path: string }[];
};
export type HistoryApplyReport = Omit<
	HistoryPreviewReport,
	"applySupported" | "applyBlockedReason"
> & { applySupported: true };
export type HistoryPreviewItem = {
	ordinal: number;
	collection: HistoricalImportItem["collection"];
	sourceId: string;
	sourceKey: string;
	itemDigest: string;
	contentDigest: string;
	targetId: string | null;
	disposition: "ensure" | "blocked";
	payload: PortableJson;
	codes: string[];
	phase: string | null;
	targetPrecondition: HistoricalTargetSnapshot | null;
	dependencyProof: {
		parent: HistoricalParentProof;
		ledger: HistoricalLedgerTuple;
	} | null;
};

// Ordinary v4 evidence stays intact, including activation readiness ordinals.
export async function sealHistoryPreviewPlan(
	ordinary: readonly FrozenImportItem[],
	history: readonly HistoricalImportItem[],
	snapshots: ReadonlyMap<string, HistoricalFrozenTarget>,
	context: {
		ownerUserId: string;
		sourceId: string;
		documentDigest: string;
		mappingDigest: string;
		signal?: AbortSignal;
		deadline?: number;
		historyApply?: boolean;
	},
) {
	const checkpoint = () => {
		if (context.signal?.aborted)
			throw new ImportPlanError("planning-cancelled");
		if (context.deadline !== undefined && performance.now() >= context.deadline)
			throw new ImportPlanError("planning-timeout");
	};
	checkpoint();
	const previewReport: HistoryPreviewReport = {
		plannerVersion: 5,
		applySupported: false,
		applyBlockedReason: "history-apply-unsupported",
		counts: { ensure: 0, ignored: 0, blocked: 0 },
		findings: [],
	};
	const report: HistoryPreviewReport | HistoryApplyReport = context.historyApply
		? {
				plannerVersion: 5,
				applySupported: true,
				counts: previewReport.counts,
				findings: previewReport.findings,
			}
		: previewReport;
	const items: (FrozenImportItem | HistoryPreviewItem)[] = ordinary.map(
		(item) => structuredClone(item),
	);
	for (const item of history) {
		checkpoint();
		const frozen = snapshots.get(
			JSON.stringify([item.collection, item.archiveRowId]),
		);
		if (
			frozen &&
			(frozen.parent.kind !== item.parentKind ||
				frozen.parent.id !== item.ledger.targetParentId ||
				!frozen.parent.workspaceId ||
				!frozen.parent.membershipId)
		)
			throw new ImportPlanError("invalid-mappings");
		if (
			frozen?.parent.dependencySourceKey &&
			!ordinary.some(
				(row) =>
					row.collection === "tasks" &&
					row.disposition === "ensure" &&
					row.targetId === frozen.parent.id &&
					row.sourceKey === frozen.parent.dependencySourceKey &&
					row.targetPrecondition?.kind === "absent" &&
					row.dependencyProof?.workspace.targetId === frozen.parent.workspaceId,
			)
		)
			throw new ImportPlanError("invalid-mappings");
		const decision = frozen
			? freezeHistoricalImportItem(item, frozen.snapshot)
			: undefined;
		const sourceKey = await hashImportValue(
			"ditero-import-historical-source-key-v5",
			[
				item.collection,
				item.ledger.targetParentId,
				item.ledger.sourceNamespace,
				item.ledger.sourceId,
			],
			checkpoint,
		);
		const blocked = !frozen || decision?.disposition === "conflict";
		items.push({
			ordinal: items.length,
			collection: item.collection,
			sourceId: item.archiveRowId,
			sourceKey,
			itemDigest: "",
			contentDigest: item.semanticDigest,
			targetId:
				!blocked && decision && "targetId" in decision
					? decision.targetId
					: null,
			disposition: blocked ? "blocked" : "ensure",
			payload: structuredClone(item.semanticPayload),
			codes: !frozen
				? ["blocked-dependency"]
				: decision?.disposition === "conflict"
					? [decision.code]
					: [],
			phase: blocked ? null : `history-${item.collection}`,
			targetPrecondition: frozen ? structuredClone(frozen.snapshot) : null,
			dependencyProof: frozen
				? {
						parent: structuredClone(frozen.parent),
						ledger: structuredClone(item.ledger),
					}
				: null,
		});
	}
	const seen = new Set<string>();
	for (const item of items) {
		checkpoint();
		if (item.ordinal !== seen.size || seen.has(item.sourceKey))
			throw new ImportPlanError("invalid-graph");
		seen.add(item.sourceKey);
		report.counts[item.disposition]++;
		for (const code of item.codes) {
			if (report.findings.length === 1000)
				throw new ImportPlanError("finding-limit");
			report.findings.push({ code, path: `items[${item.ordinal}]` });
		}
		const { itemDigest: _digest, ...evidence } = item;
		item.itemDigest = await hashImportValue(
			"ditero-import-item-v5",
			evidence as unknown as PortableJson,
			checkpoint,
		);
	}
	const planDigest = await hashImportValue(
		"ditero-import-plan-v5",
		{
			ownerUserId: context.ownerUserId,
			sourceId: context.sourceId,
			documentDigest: context.documentDigest,
			mappingDigest: context.mappingDigest,
			items: items.map((item) => item.itemDigest),
			report,
		},
		checkpoint,
	);
	return {
		documentDigest: context.documentDigest,
		mappingDigest: context.mappingDigest,
		planDigest,
		items,
		report,
	};
}
