import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useMemo } from "react";
import type { ListKind } from "../../../domain/icon-map.ts";
import { sortTasks } from "../../../domain/task-sort.ts";
import type { Label, List, Task } from "../../../zero/schema.gen.ts";
import { HabitCard } from "../habit/HabitCard.tsx";
import { CompletedSection } from "./CompletedSection.tsx";
import { type ShoppingHandlers, ShoppingRow } from "./ShoppingRow.tsx";
import { SortableTaskList } from "./SortableTaskList.tsx";
import { type RowHandlers, TaskRow } from "./TaskRow.tsx";

const UNCATEGORIZED = ""; // sorts nowhere; rendered last explicitly

export type TaskListHandlers = RowHandlers &
	ShoppingHandlers & { onMove: (id: string, sortKey: string) => void };

// First-seen category order among (already sort-key-ordered) tasks; the
// uncategorized bucket is always emitted last.
function groupByCategory(tasks: Task[]): [string, Task[]][] {
	const map = new Map<string, Task[]>();
	for (const t of tasks) {
		const key = t.category?.trim() ? t.category : UNCATEGORIZED;
		const bucket = map.get(key);
		if (bucket) bucket.push(t);
		else map.set(key, [t]);
	}
	const entries = [...map.entries()];
	entries.sort((a, b) => {
		if (a[0] === UNCATEGORIZED) return 1;
		if (b[0] === UNCATEGORIZED) return -1;
		return 0;
	});
	return entries;
}

export function TaskList({
	list,
	tasks,
	subtasksByParent,
	labelsByTask,
	handlers,
	sortable = true,
}: {
	list: List;
	tasks: Task[];
	subtasksByParent: Map<string, Task[]>;
	labelsByTask: Map<string, Label[]>;
	handlers: TaskListHandlers;
	// Drag reorder is only coherent against the full ungrouped list: fractional
	// keys are computed from in-view neighbors, so a filtered subset (e.g. one
	// assignee group) would reorder relative to hidden rows. Callers rendering a
	// subset pass sortable={false} to fall back to a static list.
	sortable?: boolean;
}) {
	const reduce = useReducedMotion();
	const kind = (list.kind ?? "tasks") as ListKind;
	const mode = list.completedDisplay ?? "sink";
	const { visible, completed } = useMemo(
		() => sortTasks(tasks, mode),
		[tasks, mode],
	);

	// habits render as a vertical stack of cards, not task rows: completion is
	// per-occurrence (habit_log), so the done/sink/hide flow and swipe rows don't
	// apply here (shell doc 2).
	if (kind === "habits") {
		return (
			<ul className="flex flex-col gap-2" data-testid="habit-list">
				{tasks.map((task) => (
					<li key={task.id}>
						<HabitCard
							task={task}
							list={list}
							onOpenDetail={handlers.onOpenDetail}
						/>
					</li>
				))}
			</ul>
		);
	}

	const row = (task: Task): ReactNode => {
		if (kind === "shopping") {
			return <ShoppingRow task={task} handlers={handlers} />;
		}
		return (
			<TaskRow
				task={task}
				kind={kind}
				subtasks={subtasksByParent.get(task.id) ?? []}
				labels={labelsByTask.get(task.id) ?? []}
				handlers={handlers}
			/>
		);
	};

	// motion FLIP: layout on each row so a completed task slides to its new
	// position (sink) instead of jumping. Disabled under prefers-reduced-motion.
	// A plain render fn (not a nested component) so React keeps row state by key
	// instead of remounting the subtree each render.
	const item = (task: Task): ReactNode => (
		<motion.li
			key={task.id}
			layout={!reduce}
			transition={{ duration: 0.18, ease: "easeOut" }}
			className={task.done ? "opacity-70" : undefined}
		>
			{row(task)}
		</motion.li>
	);

	let body: ReactNode;
	if (kind === "shopping") {
		// keep: completed stay in place within their category (sortKey order, as
		// sortTasks already left them). sink/hide pull completed to a trailing
		// group so categories show only open items.
		const grouped = mode === "keep" ? visible : visible.filter((t) => !t.done);
		const doneVisible = mode === "keep" ? [] : visible.filter((t) => t.done);
		const groups = groupByCategory(grouped);
		body = (
			<>
				{groups.map(([category, items]) => (
					<div key={category} className="mb-2">
						<div className="px-1 py-1 text-xs font-medium text-muted-foreground">
							{category === UNCATEGORIZED ? "Other" : category}
						</div>
						<ul className="flex flex-col">{items.map(item)}</ul>
					</div>
				))}
				{doneVisible.length > 0 && (
					<ul className="flex flex-col">{doneVisible.map(item)}</ul>
				)}
			</>
		);
	} else if (sortable) {
		// Non-shopping kinds are drag-sortable; the completed group below never is.
		body = (
			<SortableTaskList
				tasks={visible}
				onMove={handlers.onMove}
				renderRow={row}
				reduce={!!reduce}
			/>
		);
	} else {
		// Reorder disabled (e.g. grouped view): static list, swipe/row actions stay.
		body = <ul className="flex flex-col">{visible.map(item)}</ul>;
	}

	return (
		<LayoutGroup>
			{body}
			{/* hide mode: completed collapse into a section (all kinds). */}
			<CompletedSection count={completed.length}>
				<ul className="flex flex-col">{completed.map(item)}</ul>
			</CompletedSection>
		</LayoutGroup>
	);
}
