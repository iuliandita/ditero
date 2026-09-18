import type { ImportApplyCandidate } from "./import-apply.ts";
import { hashImportValue } from "./import-digest.ts";
import { ImportPlanError } from "./import-plan.ts";
import type { PortableJson } from "./v1.ts";

export type ImportTargetPrecondition =
	| {
			kind: "absent";
			naturalKey:
				| { kind: "label-name"; workspaceId: string; name: string }
				| { kind: "task-label-pair"; taskId: string; labelId: string }
				| { kind: "task-assignee-pair"; taskId: string; userId: string }
				| null;
	  }
	| { kind: "mapped"; mapVersion: number; targetDigest: string };

export type ImportDependencyProof = {
	workspace: { sourceId: string; targetId: string };
	assignee?: {
		sourceUserId: string;
		targetUserId: string;
		workspaceId: string;
		membershipId: string;
	};
	rows: {
		collection: "folders" | "lists" | "tasks" | "labels";
		sourceKey: string;
		itemOrdinal: number;
		id: string;
		workspaceId: string;
		listId?: string;
		parentId?: string | null;
	}[];
};

export type FrozenImportItem = Omit<ImportApplyCandidate, "dependencies"> & {
	contentDigest: string;
	itemDigest: string;
	targetPrecondition: ImportTargetPrecondition | null;
	dependencyProof: ImportDependencyProof | null;
};

export type ImportApplyReport = {
	plannerVersion: 2 | 3;
	applySupported: true;
	counts: { ensure: number; ignored: number; blocked: number };
	findings: { code: string; path: string }[];
};

// The store must acquire and authorize these snapshots in its planning transaction.
export type ImportTargetSnapshot = {
	targetPrecondition: ImportTargetPrecondition;
	dependencyProof: ImportDependencyProof;
};

export function digestImportContent(
	item: Pick<ImportApplyCandidate, "collection" | "targetId" | "payload">,
	checkpoint: () => void,
) {
	return hashImportValue(
		"ditero-import-content-v2",
		{
			collection: item.collection,
			targetId: item.targetId,
			payload: item.payload,
		},
		checkpoint,
	);
}

export async function sealImportApplyPlan(
	candidates: readonly ImportApplyCandidate[],
	snapshots: ReadonlyMap<string, ImportTargetSnapshot>,
	context: {
		plannerVersion?: 2 | 3;
		ownerUserId: string;
		sourceId: string;
		documentDigest: string;
		mappingDigest: string;
		signal?: AbortSignal;
		deadline?: number;
	},
) {
	const plannerVersion = context.plannerVersion ?? 2;
	if (plannerVersion !== 2 && plannerVersion !== 3)
		throw new ImportPlanError("invalid-mappings");
	const deadline = context.deadline ?? performance.now() + 15_000;
	function checkpoint() {
		if (context.signal?.aborted)
			throw new ImportPlanError("planning-cancelled");
		if (performance.now() >= deadline)
			throw new ImportPlanError("planning-timeout");
	}
	const digest = (domain: string, value: PortableJson) =>
		hashImportValue(domain, value, checkpoint);
	checkpoint();
	const report: ImportApplyReport = {
		plannerVersion,
		applySupported: true,
		counts: { ensure: 0, ignored: 0, blocked: 0 },
		findings: [],
	};
	const seen = new Set<string>();
	const items: FrozenImportItem[] = candidates.map((candidate, ordinal) => {
		checkpoint();
		if (candidate.ordinal !== ordinal || seen.has(candidate.sourceKey))
			throw new ImportPlanError("invalid-graph");
		seen.add(candidate.sourceKey);
		const snapshot = snapshots.get(candidate.sourceKey);
		if (
			(candidate.disposition === "ensure" &&
				(!candidate.phase || !candidate.targetId || !snapshot)) ||
			(candidate.disposition !== "ensure" && snapshot)
		)
			throw new ImportPlanError("invalid-mappings");
		if (plannerVersion === 3 && snapshot) {
			const assignee = snapshot.dependencyProof.assignee;
			if (candidate.collection === "assignments") {
				const payload = candidate.payload;
				const precondition = snapshot.targetPrecondition;
				if (
					!assignee?.sourceUserId ||
					!assignee.membershipId ||
					!payload ||
					typeof payload !== "object" ||
					Array.isArray(payload) ||
					typeof payload.taskId !== "string" ||
					typeof payload.userId !== "string" ||
					candidate.phase !== "assignments" ||
					candidate.targetId !== `${payload.taskId}:${payload.userId}` ||
					payload.id !== candidate.targetId ||
					assignee.targetUserId !== payload.userId ||
					assignee.workspaceId !==
						snapshot.dependencyProof.workspace.targetId ||
					(precondition.kind === "absent" &&
						(precondition.naturalKey?.kind !== "task-assignee-pair" ||
							precondition.naturalKey.taskId !== payload.taskId ||
							precondition.naturalKey.userId !== payload.userId))
				)
					throw new ImportPlanError("invalid-mappings");
			} else if (assignee !== undefined)
				throw new ImportPlanError("invalid-mappings");
		}
		report.counts[candidate.disposition]++;
		for (const code of candidate.codes) {
			if (report.findings.length === 1000)
				throw new ImportPlanError("finding-limit");
			report.findings.push({ code, path: `items[${ordinal}]` });
		}
		const dependencyProof = snapshot
			? structuredClone(snapshot.dependencyProof)
			: null;
		const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
		dependencyProof?.rows.sort(
			(a, b) =>
				a.itemOrdinal - b.itemOrdinal ||
				compare(a.collection, b.collection) ||
				compare(a.sourceKey, b.sourceKey) ||
				compare(a.id, b.id),
		);
		const { dependencies: _dependencies, ...content } =
			structuredClone(candidate);
		return {
			...content,
			contentDigest: "",
			itemDigest: "",
			targetPrecondition: snapshot
				? structuredClone(snapshot.targetPrecondition)
				: null,
			dependencyProof,
		};
	});
	if (snapshots.size !== report.counts.ensure)
		throw new ImportPlanError("invalid-mappings");
	for (let offset = 0; offset < items.length; offset += 256) {
		checkpoint();
		const results = await Promise.allSettled(
			items.slice(offset, offset + 256).map(async (item) => {
				// Target snapshots change after apply; source content identity must not.
				item.contentDigest = await digestImportContent(item, checkpoint);
				const { itemDigest: _itemDigest, ...evidence } = item;
				item.itemDigest = await digest(
					`ditero-import-item-v${plannerVersion}`,
					evidence as unknown as PortableJson,
				);
			}),
		);
		for (const result of results)
			if (result.status === "rejected") throw result.reason;
	}
	const planDigest = await digest(`ditero-import-plan-v${plannerVersion}`, {
		ownerUserId: context.ownerUserId,
		sourceId: context.sourceId,
		documentDigest: context.documentDigest,
		mappingDigest: context.mappingDigest,
		items: items.map((item) => item.itemDigest),
		report,
	});
	checkpoint();
	return {
		documentDigest: context.documentDigest,
		mappingDigest: context.mappingDigest,
		planDigest,
		items,
		report,
	};
}
