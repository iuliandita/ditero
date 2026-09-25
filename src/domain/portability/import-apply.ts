import { ImportPlanError, type ImportPlanItem } from "./import-plan.ts";
import type { PortableExportV1, PortableJson, PortableRows } from "./v1.ts";

export type ImportApplyPhase =
	| "folders"
	| "lists"
	| "labels"
	| "root-tasks"
	| "child-tasks"
	| "task-labels"
	| "assignments";

export interface ImportApplyDependency {
	collection: keyof PortableRows;
	sourceId: string;
	sourceKey: string;
}

// Candidates are not sealed plans: eligibility changes invalidate the v1 item digest.
export interface ImportApplyCandidate
	extends Omit<ImportPlanItem, "itemDigest"> {
	phase: ImportApplyPhase | null;
	dependencies: ImportApplyDependency[];
}

// Both inputs must come from the same validated document and buildImportPlan call.
// Live authority, target preconditions and new digests must be frozen separately.
export function projectImportApply(
	document: PortableExportV1,
	planItems: readonly ImportPlanItem[],
	context: {
		plannerVersion?: 2 | 3 | 4;
		signal?: AbortSignal;
		deadline?: number;
	} = {},
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
	checkpoint();
	type Collection = keyof PortableRows;
	const originals = new Map<
		Collection,
		Map<string, PortableRows[Collection]>
	>();
	for (const collection of Object.keys(document.data) as Collection[]) {
		const rows = new Map<string, PortableRows[Collection]>();
		for (const row of document.data[collection]) {
			checkpoint();
			rows.set("id" in row ? row.id : row.userId, row);
		}
		originals.set(collection, rows);
	}
	const indexes = new Map<Collection, Map<string, ImportApplyCandidate>>();
	const items = planItems.map((item): ImportApplyCandidate => {
		checkpoint();
		const { itemDigest: _itemDigest, ...candidate } = item;
		const copy = {
			...structuredClone(candidate),
			phase: null,
			dependencies: [],
		};
		const index =
			indexes.get(item.collection) ?? new Map<string, ImportApplyCandidate>();
		if (index.has(item.sourceId)) throw new ImportPlanError("invalid-graph");
		index.set(item.sourceId, copy);
		indexes.set(item.collection, index);
		return copy;
	});
	const dependents = new Map<ImportApplyCandidate, ImportApplyCandidate[]>();
	function block(item: ImportApplyCandidate, code: string) {
		item.disposition = "blocked";
		if (!item.codes.includes(code)) item.codes.push(code);
	}
	for (const item of items) {
		checkpoint();
		const original = originals.get(item.collection)?.get(item.sourceId);
		if (!original) throw new ImportPlanError("invalid-graph");
		if (item.disposition !== "ensure") continue;
		function dependency(collection: Collection, sourceId: string | null) {
			if (sourceId === null) return;
			const target = indexes.get(collection)?.get(sourceId);
			if (!target) throw new ImportPlanError("invalid-graph");
			item.dependencies.push({
				collection,
				sourceId,
				sourceKey: target.sourceKey,
			});
			const users = dependents.get(target) ?? [];
			users.push(item);
			dependents.set(target, users);
		}
		switch (item.collection) {
			case "folders":
			case "labels":
				item.phase = item.collection;
				break;
			case "lists": {
				const row = original as PortableRows["lists"];
				item.phase = "lists";
				if (row.ownerId !== document.sourceUserId)
					block(item, "foreign-list-owner");
				dependency("folders", row.folderId);
				break;
			}
			case "tasks": {
				const row = original as PortableRows["tasks"];
				item.phase = row.parentId === null ? "root-tasks" : "child-tasks";
				if (
					plannerVersion !== 4 &&
					(row.reminderTime !== null ||
						row.repeatEveryMin !== null ||
						row.maxRepeats !== null ||
						row.fallbackUserId !== null ||
						row.urgent ||
						(!row.done && row.dueAt !== null))
				)
					block(item, "notification-bearing-task");
				dependency("lists", row.listId);
				dependency("tasks", row.parentId);
				break;
			}
			case "taskLabels": {
				const row = original as PortableRows["taskLabels"];
				item.phase = "task-labels";
				dependency("tasks", row.taskId);
				dependency("labels", row.labelId);
				break;
			}
			case "assignments": {
				if (plannerVersion === 2) {
					block(item, "unsupported-collection");
					break;
				}
				const row = original as PortableRows["assignments"];
				const mapped = item.payload;
				if (
					!mapped ||
					typeof mapped !== "object" ||
					Array.isArray(mapped) ||
					typeof mapped.taskId !== "string" ||
					typeof mapped.userId !== "string"
				)
					throw new ImportPlanError("invalid-graph");
				item.phase = "assignments";
				dependency("tasks", row.taskId);
				// Ordinary assign/unassign looks up this pair, not an import hash.
				item.targetId = `${mapped.taskId}:${mapped.userId}`;
				mapped.id = item.targetId;
				break;
			}
			default:
				block(item, "unsupported-collection");
		}
	}
	if (plannerVersion === 4)
		blockV4TasksWithFailedAssignments(document, items, context);
	const queue = items.filter((item) => item.disposition !== "ensure");
	for (let i = 0; i < queue.length; i++) {
		checkpoint();
		for (const dependent of dependents.get(queue[i]) ?? []) {
			checkpoint();
			if (dependent.disposition !== "ensure") continue;
			block(dependent, "blocked-dependency");
			queue.push(dependent);
		}
	}
	const counts = { ensure: 0, ignored: 0, blocked: 0 };
	for (const item of items) {
		checkpoint();
		if (item.disposition === "blocked") {
			item.phase = null;
			item.targetId = null;
			item.payload = structuredClone(
				originals.get(item.collection)?.get(item.sourceId),
			) as PortableJson;
		}
		counts[item.disposition]++;
	}
	checkpoint();
	return { items, counts };
}

// Call after live freeze has marked collisions and missing seats, before its
// ordinary forward closure and before sealing. The source document is required
// because blocked candidates have already restored their original payloads.
export function blockV4TasksWithFailedAssignments(
	document: PortableExportV1,
	items: ImportApplyCandidate[],
	context: { signal?: AbortSignal; deadline?: number } = {},
): void {
	const tasks = new Map(
		items
			.filter((item) => item.collection === "tasks")
			.map((item) => [item.sourceId, item]),
	);
	const sourceTasks = new Map(document.data.tasks.map((row) => [row.id, row]));
	const sourceAssignments = new Map(
		document.data.assignments.map((row) => [row.id, row]),
	);
	for (const item of items) {
		if (context.signal?.aborted)
			throw new ImportPlanError("planning-cancelled");
		if (context.deadline !== undefined && performance.now() >= context.deadline)
			throw new ImportPlanError("planning-timeout");
		if (item.collection !== "assignments" || item.disposition === "ensure")
			continue;
		const assignment = sourceAssignments.get(item.sourceId);
		const task = assignment && sourceTasks.get(assignment.taskId);
		const target = assignment && tasks.get(assignment.taskId);
		if (!assignment || !task || !target)
			throw new ImportPlanError("invalid-graph");
		if (
			target.disposition === "ensure" &&
			(task.reminderTime !== null ||
				task.repeatEveryMin !== null ||
				task.maxRepeats !== null ||
				task.fallbackUserId !== null ||
				task.urgent ||
				(!task.done && task.dueAt !== null))
		) {
			target.disposition = "blocked";
			if (!target.codes.includes("notification-recipient-blocked"))
				target.codes.push("notification-recipient-blocked");
		}
	}
}
