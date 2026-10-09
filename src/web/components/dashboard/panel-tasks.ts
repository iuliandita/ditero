// Pure matching-set evaluation for tasks/counter panels: the same
// enrich -> scope -> filter -> sort pipeline ViewRenderer runs, minus grouping.
// Generic over the row types so tests use plain literals; panels pass real
// Zero rows through unchanged (TaskRow needs the full Task).
import {
	DEFAULT_PANEL_LIMIT,
	type ResolvedSource,
} from "../../../domain/dashboard.ts";
import { compareTasksBy } from "../../../domain/task-sort.ts";
import {
	type FilterCtx,
	type FilterTask,
	resolveWorkspaceScope,
} from "../../../domain/view-filter.ts";
import {
	type HabitOccurrence,
	habitOccurrence,
	matchesOccurrenceFilter,
	type OccurrenceLog,
} from "../../views/habit-occurrence.ts";
import type { TaskSourceWorkspace } from "../list/TaskSourceContext.tsx";

export type PanelTaskFields = {
	id: string;
	listId: string;
	title: string;
	done?: boolean | null;
	dueAt?: number | null;
	priority?: number | null;
	sortKey: string;
	rrule?: string | null;
};
export type PanelListFields = {
	id: string;
	workspaceId: string;
	kind?: string | null;
	folderId?: string | null;
};

export type PanelEntry<T, L> = {
	task: T;
	kind: string;
	labels: L[];
	occurrence?: HabitOccurrence;
	sourceContext?: string;
	sourceWorkspace?: TaskSourceWorkspace;
};

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
		habitLogs?: readonly OccurrenceLog[];
		timeZone?: string;
		currentDay?: string;
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
		const occurrence =
			list.kind === "habits"
				? habitOccurrence(
						task,
						data.habitLogs ?? [],
						ctx.now,
						data.timeZone ?? "UTC",
						data.currentDay,
					)
				: undefined;
		const effectiveDue = occurrence ? occurrence.dueAt : task.dueAt;
		const filterTask: FilterTask = {
			id: task.id,
			listId: task.listId,
			workspaceId: list.workspaceId,
			done: occurrence ? occurrence.done : (task.done ?? false),
			dueAt: effectiveDue == null ? null : new Date(effectiveDue),
			priority: task.priority ?? 0,
			kind: list.kind ?? "tasks",
			folderId: list.folderId ?? null,
			labelIds,
			assigneeIds: assigneeIdsByTask.get(task.id) ?? [],
		};
		if (
			!matchesOccurrenceFilter(
				filterTask,
				resolved.filter,
				ctx,
				occurrence,
				data.timeZone ?? "UTC",
				data.currentDay,
			)
		)
			continue;
		out.push({
			task,
			occurrence,
			kind: list.kind ?? "tasks",
			labels: labelIds
				.map((id) => labelById.get(id))
				.filter((l): l is L => l != null),
		});
	}
	const dir = resolved.sort.dir === "desc" ? -1 : 1;
	return out.sort(
		(a, b) =>
			dir *
			compareTasksBy(
				{
					...a.task,
					...(a.occurrence
						? { dueAt: a.occurrence.dueAt, done: a.occurrence.done }
						: {}),
				},
				{
					...b.task,
					...(b.occurrence
						? { dueAt: b.occurrence.dueAt, done: b.occurrence.done }
						: {}),
				},
				resolved.sort.field,
			),
	);
}

// Tasks-panel cap; undefined applies the product default (counter never caps).
export function capEntries<T>(
	entries: readonly T[],
	limit: number | undefined,
): T[] {
	return entries.slice(0, limit ?? DEFAULT_PANEL_LIMIT);
}
