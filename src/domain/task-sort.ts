import type { completedDisplayEnum } from "../db/schema.ts";

export type SortableTask = {
	// nullable to match the Zero wire shape (optional boolean); null is treated
	// as not-done by the filters below.
	done: boolean | null;
	sortKey: string;
	completedAt: number | null;
};

// Derived from the Drizzle enum (single source of truth). Type-only import is
// fully erased under verbatimModuleSyntax, so no drizzle runtime reaches this
// client+server module.
export type CompletedDisplay = (typeof completedDisplayEnum.enumValues)[number];

// null completedAt shouldn't happen given the task.update invariant (done
// implies completedAt set), but sort defensively: treat as oldest (0) so a
// bad row lands last, not first, among completed.
const byCompletedAtDesc = (a: SortableTask, b: SortableTask) =>
	(b.completedAt ?? 0) - (a.completedAt ?? 0);
const bySortKeyAsc = (a: SortableTask, b: SortableTask) =>
	a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;

// design 2.16: completion never mutates sortKey; this is pure view ordering.
export function sortTasks<T extends SortableTask>(
	tasks: T[],
	mode: CompletedDisplay,
): { visible: T[]; completed: T[] } {
	const open = tasks.filter((t) => !t.done).sort(bySortKeyAsc);
	const done = tasks.filter((t) => t.done).sort(byCompletedAtDesc);

	if (mode === "keep") {
		return { visible: [...tasks].sort(bySortKeyAsc), completed: [] };
	}
	if (mode === "hide") {
		return { visible: open, completed: done };
	}
	// sink: completed sinks to the bottom of the same list.
	return { visible: [...open, ...done], completed: [] };
}

export type FieldSortableTask = {
	title: string;
	sortKey: string;
	dueAt?: number | null;
	priority?: number | null;
};

// Base ascending comparator for view/panel field sorts (the caller flips the
// sign for desc). Null due sorts last on asc; unknown fields fall back to
// sortKey order.
export function compareTasksBy(
	a: FieldSortableTask,
	b: FieldSortableTask,
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
