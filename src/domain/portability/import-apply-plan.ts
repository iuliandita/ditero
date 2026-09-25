import type { ImportApplyCandidate } from "./import-apply.ts";
import { hashImportValue } from "./import-digest.ts";
import { ImportPlanError } from "./import-plan.ts";
import type { PortableJson } from "./v1.ts";

export type ImportPrincipalSeatProof = {
	sourceUserId: string;
	targetUserId: string;
	workspaceId: string;
	membershipId: string;
};

export type ImportRelationshipEvidence = {
	version: 1;
	workspaceId: string;
	assignees: { userId: string; membershipId: string }[];
	ownerFallback: { userId: string; membershipId: string } | null;
	escalationFallback: { userId: string; membershipId: string } | null;
};

export type ImportTaskActivationProof = {
	kind: "observe" | "transition";
	precondition:
		| { kind: "absent" }
		| {
				kind: "present";
				status: "pending" | "active";
				generation: number;
				owningSourceId: string | null;
				owningJobId: string | null;
				owningOwnerUserId: string | null;
				expectedRelationshipDigest: string;
		  };
	generation: number;
	readinessOrdinal: number;
	expectedRelationships: {
		digest: string;
		count: number;
		bytes: number;
		evidence: ImportRelationshipEvidence;
	};
};

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
	assignee?: ImportPrincipalSeatProof;
	fallback?: ImportPrincipalSeatProof;
	activation?: ImportTaskActivationProof;
	taskActivationGeneration?: number;
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
	plannerVersion: 2 | 3 | 4;
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

export function digestImportExpectedRelationships(
	evidence: ImportRelationshipEvidence,
	checkpoint: () => void,
): Promise<string> {
	return hashImportValue(
		"ditero-import-expected-relationships-v1",
		evidence as unknown as PortableJson,
		checkpoint,
	);
}

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isSafeInteger(value) &&
	value > 0 &&
	value <= 2_147_483_647;
const isNonnegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nonempty = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;
const nullableText = (value: unknown): value is string | null =>
	value === null || nonempty(value);
const exactKeys = (value: object, keys: readonly string[]) =>
	Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const seat = (
	value: unknown,
): value is { userId: string; membershipId: string } =>
	value !== null &&
	typeof value === "object" &&
	exactKeys(value, ["userId", "membershipId"]) &&
	nonempty((value as { userId?: unknown }).userId) &&
	nonempty((value as { membershipId?: unknown }).membershipId);

function validateV4Proof(
	candidate: ImportApplyCandidate,
	snapshot: ImportTargetSnapshot,
): void {
	const proof = snapshot.dependencyProof;
	const activation = proof.activation;
	if (candidate.collection === "tasks") {
		const payload = candidate.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload))
			throw new ImportPlanError("invalid-mappings");
		const fallbackId = payload.fallbackUserId;
		if (fallbackId !== null && fallbackId !== undefined) {
			if (
				!proof.fallback ||
				!nonempty(proof.fallback.sourceUserId) ||
				!nonempty(proof.fallback.membershipId) ||
				proof.fallback.targetUserId !== fallbackId ||
				proof.fallback.workspaceId !== proof.workspace.targetId
			)
				throw new ImportPlanError("invalid-mappings");
		} else if (proof.fallback !== undefined)
			throw new ImportPlanError("invalid-mappings");
		if (
			proof.assignee !== undefined ||
			proof.taskActivationGeneration !== undefined
		)
			throw new ImportPlanError("invalid-mappings");
		if (!activation) {
			// An unchanged mapped legacy task with no new source links remains guardless.
			if (snapshot.targetPrecondition.kind !== "mapped")
				throw new ImportPlanError("invalid-mappings");
			return;
		}
		const { precondition, expectedRelationships: relationships } = activation;
		if (
			!isPositiveInteger(activation.generation) ||
			!exactKeys(activation, [
				"kind",
				"precondition",
				"generation",
				"readinessOrdinal",
				"expectedRelationships",
			]) ||
			!isNonnegativeInteger(activation.readinessOrdinal) ||
			activation.readinessOrdinal < candidate.ordinal ||
			!relationships ||
			!exactKeys(relationships, ["digest", "count", "bytes", "evidence"]) ||
			!nonempty(relationships.digest) ||
			!isNonnegativeInteger(relationships.count) ||
			!isPositiveInteger(relationships.bytes) ||
			relationships.count > 50_000 ||
			relationships.bytes > 64 * 1024 * 1024 ||
			!relationships.evidence ||
			!exactKeys(relationships.evidence, [
				"version",
				"workspaceId",
				"assignees",
				"ownerFallback",
				"escalationFallback",
			]) ||
			relationships.evidence.version !== 1 ||
			relationships.evidence.workspaceId !== proof.workspace.targetId ||
			!Array.isArray(relationships.evidence.assignees) ||
			!relationships.evidence.assignees.every(seat) ||
			(relationships.evidence.ownerFallback !== null &&
				!seat(relationships.evidence.ownerFallback)) ||
			(relationships.evidence.escalationFallback !== null &&
				!seat(relationships.evidence.escalationFallback))
		)
			throw new ImportPlanError("invalid-mappings");
		const evidence = relationships.evidence;
		if (
			evidence.assignees.some(
				(entry, index) =>
					index > 0 && evidence.assignees[index - 1].userId >= entry.userId,
			) ||
			new Set(evidence.assignees.map((entry) => entry.membershipId)).size !==
				evidence.assignees.length ||
			(evidence.assignees.length > 0 && evidence.ownerFallback !== null) ||
			(evidence.assignees.length === 0 && evidence.ownerFallback === null) ||
			relationships.count !==
				evidence.assignees.length +
					Number(evidence.ownerFallback !== null) +
					Number(evidence.escalationFallback !== null) ||
			(evidence.escalationFallback?.userId ?? null) !== (fallbackId ?? null) ||
			(evidence.escalationFallback?.membershipId ?? null) !==
				(proof.fallback?.membershipId ?? null)
		)
			throw new ImportPlanError("invalid-mappings");
		if (
			activation.kind === "observe"
				? precondition.kind !== "present" ||
					precondition.status !== "active" ||
					activation.generation !== precondition.generation
				: activation.kind !== "transition" ||
					(precondition.kind === "absent"
						? activation.generation !== 1
						: (precondition.status !== "active" &&
								precondition.status !== "pending") ||
							activation.generation !== precondition.generation + 1)
		)
			throw new ImportPlanError("invalid-mappings");
		if (
			precondition.kind === "present" &&
			(!exactKeys(precondition, [
				"kind",
				"status",
				"generation",
				"owningSourceId",
				"owningJobId",
				"owningOwnerUserId",
				"expectedRelationshipDigest",
			]) ||
				!isPositiveInteger(precondition.generation) ||
				!nonempty(precondition.expectedRelationshipDigest) ||
				!nullableText(precondition.owningSourceId) ||
				!nullableText(precondition.owningJobId) ||
				!nullableText(precondition.owningOwnerUserId))
		)
			throw new ImportPlanError("invalid-mappings");
		if (precondition.kind === "absent" && !exactKeys(precondition, ["kind"]))
			throw new ImportPlanError("invalid-mappings");
		if (
			snapshot.targetPrecondition.kind === "absent" &&
			precondition.kind !== "absent"
		)
			throw new ImportPlanError("invalid-mappings");
		return;
	}
	if (
		proof.fallback !== undefined ||
		proof.activation !== undefined ||
		(candidate.collection !== "assignments" &&
			proof.taskActivationGeneration !== undefined)
	)
		throw new ImportPlanError("invalid-mappings");
}

export async function sealImportApplyPlan(
	candidates: readonly ImportApplyCandidate[],
	snapshots: ReadonlyMap<string, ImportTargetSnapshot>,
	context: {
		plannerVersion?: 2 | 3 | 4;
		ownerUserId: string;
		sourceId: string;
		documentDigest: string;
		mappingDigest: string;
		signal?: AbortSignal;
		deadline?: number;
	},
) {
	const plannerVersion = context.plannerVersion ?? 2;
	if (plannerVersion !== 2 && plannerVersion !== 3 && plannerVersion !== 4)
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
		if (plannerVersion >= 3 && snapshot) {
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
		if (snapshot && plannerVersion === 4) validateV4Proof(candidate, snapshot);
		if (
			snapshot &&
			plannerVersion !== 4 &&
			(snapshot.dependencyProof.fallback !== undefined ||
				snapshot.dependencyProof.activation !== undefined ||
				snapshot.dependencyProof.taskActivationGeneration !== undefined)
		)
			throw new ImportPlanError("invalid-mappings");
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
	if (plannerVersion === 4) {
		const tasks = new Map(
			candidates
				.filter(
					(item) =>
						item.collection === "tasks" && item.disposition === "ensure",
				)
				.map((item) => [item.sourceKey, item]),
		);
		const readiness = new Map<string, number>();
		let relationshipCount = 0;
		let relationshipBytes = 0;
		for (const item of candidates) {
			checkpoint();
			if (item.collection !== "assignments" || item.disposition !== "ensure")
				continue;
			const dependency = item.dependencies.find(
				(row) => row.collection === "tasks",
			);
			const task = dependency && tasks.get(dependency.sourceKey);
			const snapshot = snapshots.get(item.sourceKey);
			const taskActivation =
				task && snapshots.get(task.sourceKey)?.dependencyProof.activation;
			const assignmentPayload = item.payload;
			if (
				!task ||
				!snapshot ||
				!assignmentPayload ||
				typeof assignmentPayload !== "object" ||
				Array.isArray(assignmentPayload) ||
				assignmentPayload.taskId !== task.targetId ||
				!snapshot.dependencyProof.rows.some(
					(row) =>
						row.collection === "tasks" &&
						row.sourceKey === task.sourceKey &&
						row.itemOrdinal === task.ordinal &&
						row.id === task.targetId,
				)
			)
				throw new ImportPlanError("invalid-mappings");
			if (
				snapshot.targetPrecondition.kind === "mapped" &&
				!taskActivation &&
				snapshot.dependencyProof.taskActivationGeneration === undefined
			)
				continue;
			if (
				!task ||
				!snapshot ||
				!taskActivation ||
				!isPositiveInteger(snapshot.dependencyProof.taskActivationGeneration) ||
				snapshot.dependencyProof.taskActivationGeneration !==
					taskActivation.generation
			)
				throw new ImportPlanError("invalid-mappings");
			const assignee = snapshot.dependencyProof.assignee;
			if (
				!assignee ||
				!taskActivation.expectedRelationships.evidence.assignees.some(
					(entry) =>
						entry.userId === assignee.targetUserId &&
						entry.membershipId === assignee.membershipId,
				)
			)
				throw new ImportPlanError("invalid-mappings");
			if (
				snapshot.targetPrecondition.kind === "absent" &&
				taskActivation.kind !== "transition"
			)
				throw new ImportPlanError("invalid-mappings");
			if (taskActivation.kind === "transition") {
				readiness.set(
					task.sourceKey,
					Math.max(readiness.get(task.sourceKey) ?? task.ordinal, item.ordinal),
				);
			}
		}
		for (const task of tasks.values()) {
			checkpoint();
			const activation = snapshots.get(task.sourceKey)?.dependencyProof
				.activation;
			if (!activation) {
				if (readiness.has(task.sourceKey))
					throw new ImportPlanError("invalid-mappings");
				continue;
			}
			if (
				activation.readinessOrdinal !==
					(readiness.get(task.sourceKey) ?? task.ordinal) ||
				activation.readinessOrdinal >= candidates.length
			)
				throw new ImportPlanError("invalid-mappings");
			const relationships = activation.expectedRelationships;
			relationshipCount += relationships.count;
			relationshipBytes += relationships.bytes;
			if (relationshipCount > 50_000 || relationshipBytes > 64 * 1024 * 1024)
				throw new ImportPlanError("invalid-mappings");
			const expected = await digestImportExpectedRelationships(
				relationships.evidence,
				checkpoint,
			);
			if (relationships.digest !== expected)
				throw new ImportPlanError("invalid-mappings");
		}
	}
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
