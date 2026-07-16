// Pure matching-set evaluation for tasks/counter panels: the same
// enrich -> scope -> filter -> sort pipeline ViewRenderer runs, minus grouping.
// Generic over the row types so tests use plain literals; panels pass real
// Zero rows through unchanged (TaskRow needs the full Task).
import {
	DEFAULT_PANEL_LIMIT,
	type ResolvedSource,
} from "../../../domain/dashboard.ts";
import {
	type FilterCtx,
	type FilterTask,
	resolveWorkspaceScope,
	taskMatchesFilter,
} from "../../../domain/view-filter.ts";

export type PanelTaskFields = {
	id: string;
	listId: string;
	title: string;
	done?: boolean | null;
	dueAt?: number | null;
	priority?: number | null;
	sortKey: string;
};
export type PanelListFields = {
	id: string;
	workspaceId: string;
	kind?: string | null;
	folderId?: string | null;
};

export type PanelEntry<T, L> = { task: T; kind: string; labels: L[] };

// Base ascending comparators, mirroring ViewRenderer: null due sorts last on
// asc, unknown fields fall back to sortKey order.
function compareBy<T extends PanelTaskFields>(
	a: T,
	b: T,
	field: string,
): number {
	switch (field) {
		case "due": {
			const av = a.dueAt ?? Number.POSITIVE_INFINITY;
			const bv = b.dueAt ?? Number.POSITIVE_INFINITY;
			return av - bv;
		}
		case "priority":
			return (a.priority ?? 0) - (b.priority ?? 0);
		case "title":
			return a.title.localeCompare(b.title);
		default:
			return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
	}
}

export function matchingTasks<
	T extends PanelTaskFields,
	L extends { id: string },
>(
	data: {
		tasks: readonly T[];
		lists: readonly PanelListFields[];
		labels: readonly L[];
		taskLabels: readonly { taskId: string; labelId: string }[];
		assignees: readonly { taskId: string; userId: string }[];
	},
	resolved: ResolvedSource,
	ctx: FilterCtx,
): PanelEntry<T, L>[] {
	const listById = new Map(data.lists.map((l) => [l.id, l]));
	const labelById = new Map(data.labels.map((l) => [l.id, l]));
	const labelIdsByTask = new Map<string, string[]>();
	for (const tl of data.taskLabels) {
		const bucket = labelIdsByTask.get(tl.taskId);
		if (bucket) bucket.push(tl.labelId);
		else labelIdsByTask.set(tl.taskId, [tl.labelId]);
	}
	const assigneeIdsByTask = new Map<string, string[]>();
	for (const a of data.assignees) {
		const bucket = assigneeIdsByTask.get(a.taskId);
		if (bucket) bucket.push(a.userId);
		else assigneeIdsByTask.set(a.taskId, [a.userId]);
	}

	const scope = resolveWorkspaceScope(resolved.workspaceScope, ctx);
	const out: PanelEntry<T, L>[] = [];
	for (const task of data.tasks) {
		const list = listById.get(task.listId);
		if (!list) continue;
		if (!scope.has(list.workspaceId)) continue;
		const labelIds = labelIdsByTask.get(task.id) ?? [];
		const filterTask: FilterTask = {
			id: task.id,
			listId: task.listId,
			workspaceId: list.workspaceId,
			done: task.done ?? false,
			dueAt: task.dueAt == null ? null : new Date(task.dueAt),
			priority: task.priority ?? 0,
			kind: list.kind ?? "tasks",
			folderId: list.folderId ?? null,
			labelIds,
			assigneeIds: assigneeIdsByTask.get(task.id) ?? [],
		};
		if (!taskMatchesFilter(filterTask, resolved.filter, ctx)) continue;
		out.push({
			task,
			kind: list.kind ?? "tasks",
			labels: labelIds
				.map((id) => labelById.get(id))
				.filter((l): l is L => l != null),
		});
	}
	const dir = resolved.sort.dir === "desc" ? -1 : 1;
	return out.sort(
		(a, b) => dir * compareBy(a.task, b.task, resolved.sort.field),
	);
}

// Tasks-panel cap; undefined applies the product default (counter never caps).
export function capEntries<T>(
	entries: readonly T[],
	limit: number | undefined,
): T[] {
	return entries.slice(0, limit ?? DEFAULT_PANEL_LIMIT);
}
