import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useMemo, useRef } from "react";
import { FLIP_TRANSITION } from "@/lib/motion";
import type { ListKind } from "../../../domain/icon-map.ts";
import { sortTasks } from "../../../domain/task-sort.ts";
import { m } from "../../../paraglide/messages.js";
import type { Label, List, Task } from "../../../zero/schema.gen.ts";
import { useSettling } from "../../hooks/useSettling.ts";
import { HabitCard } from "../habit/HabitCard.tsx";
import { useSnackbar } from "../ui/snackbar.tsx";
import { CompletedSection } from "./CompletedSection.tsx";
import { type ShoppingHandlers, ShoppingRow } from "./ShoppingRow.tsx";
import { SortableTaskList } from "./SortableTaskList.tsx";
import { type RowHandlers, TaskRow } from "./TaskRow.tsx";

const UNCATEGORIZED = ""; // sorts nowhere; rendered last explicitly
const NOTHING_SETTLING: ReadonlySet<string> = new Set();

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
	reordering = false,
	footer,
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
	// Touch reorder mode: drag grips shown instead of kept out of the layout.
	reordering?: boolean;
	// After the open rows, before the completed group: the mobile inline add
	// belongs with the rows it extends.
	footer?: ReactNode;
}) {
	const reduce = useReducedMotion();
	const kind = (list.kind ?? "tasks") as ListKind;
	const mode = list.completedDisplay ?? "sink";
	const rootRef = useRef<HTMLDivElement>(null);
	// A reopen from any path (another device, the detail sheet) retracts a
	// "Completed" snack that no longer describes the row.
	const { dismissKey } = useSnackbar();
	const observed = useSettling(tasks, rootRef, dismissKey);
	// keep mode never moves a completed row, so nothing settles there.
	const settling = mode === "keep" ? NOTHING_SETTLING : observed;
	const { visible, completed } = useMemo(
		() => sortTasks(tasks, mode, (t) => settling.has(t.id)),
		[tasks, mode, settling],
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
				{footer && <li>{footer}</li>}
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
			transition={FLIP_TRANSITION}
			data-settling={settling.has(task.id) || undefined}
			className={task.done ? "opacity-70" : undefined}
		>
			{sortable && kind !== "shopping" && task.done ? (
				<div className="ms-7">{row(task)}</div>
			) : (
				row(task)
			)}
		</motion.li>
	);

	let body: ReactNode;
	if (kind === "shopping") {
		// Checked items stay in their category while settling (and always in
		// keep mode); settled ones collect in the trailing "in cart" group.
		const groups = groupByCategory(visible);
		body = groups.map(([category, items]) => (
			<div key={category} className="mb-2">
				<div className="px-1 py-1 text-xs font-medium text-muted-foreground">
					{category === UNCATEGORIZED ? m.shopping_category_other() : category}
				</div>
				<ul className="flex flex-col">{items.map(item)}</ul>
			</div>
		));
	} else if (sortable) {
		// Non-shopping kinds are drag-sortable; the completed group below never is.
		body = (
			<SortableTaskList
				tasks={visible}
				settling={settling}
				onMove={handlers.onMove}
				renderRow={row}
				reduce={!!reduce}
				reordering={reordering}
			/>
		);
	} else {
		// Reorder disabled (e.g. grouped view): static list, swipe/row actions stay.
		body = <ul className="flex flex-col">{visible.map(item)}</ul>;
	}

	return (
		<div ref={rootRef}>
			<LayoutGroup>
				{body}
				{footer}
				<CompletedSection
					count={completed.length}
					label={
						kind === "shopping"
							? m.list_in_cart_count({ count: completed.length })
							: m.list_completed_count({ count: completed.length })
					}
				>
					<ul className="flex flex-col">{completed.map(item)}</ul>
				</CompletedSection>
			</LayoutGroup>
		</div>
	);
}
