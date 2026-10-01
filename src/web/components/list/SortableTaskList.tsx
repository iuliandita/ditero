import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { FLIP_TRANSITION } from "@/lib/motion";
import { reorderSortKey } from "@/lib/reorder";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { useTaskImportActivationMap } from "../../hooks/useTaskImportActivation.ts";
import { SortableRow, useReorderSensors } from "./SortableList.tsx";

// Open tasks are drag-sortable; completed rows render statically and are never
// part of the sortable set (design: reorder never touches the completed group).
// A settling row is done but keeps its SortableRow wrapper (disabled) until it
// leaves, so checking it does not remount the row and drop keyboard focus.
// The dnd transform lives on the inner SortableRow so it never fights the outer
// motion.li FLIP layout animation; on touch the row body owns the swipe and
// long-press gestures and the grip, the sole drag activator, shows only in the
// list's explicit reorder mode, so the gestures never collide.
export function SortableTaskList({
	tasks,
	settling,
	onMove,
	renderRow,
	reduce,
	reordering,
}: {
	tasks: Task[];
	settling: ReadonlySet<string>;
	onMove: (id: string, sortKey: string) => void;
	renderRow: (task: Task) => ReactNode;
	reduce: boolean;
	reordering: boolean;
}) {
	const activation = useTaskImportActivationMap();
	const inPlace = (t: Task) => !t.done || settling.has(t.id);
	const sortable = tasks.filter(inPlace);
	const sortableIds = sortable.map((t) => t.id);
	const sensors = useReorderSensors();

	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		if (!activation.canWriteTask(String(active.id))) return;
		const key = reorderSortKey(sortable, String(active.id), String(over.id));
		if (key) onMove(String(active.id), key);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={onDragEnd}
		>
			<SortableContext
				items={sortableIds}
				strategy={verticalListSortingStrategy}
			>
				<ul className="flex flex-col">
					{tasks.map((task) => (
						<motion.li
							key={task.id}
							layout={!reduce}
							transition={FLIP_TRANSITION}
							data-settling={settling.has(task.id) || undefined}
							className={task.done ? "opacity-70" : undefined}
						>
							{!inPlace(task) ? (
								<div className="ms-7">{renderRow(task)}</div>
							) : (
								<SortableRow
									id={task.id}
									disabled={
										settling.has(task.id) || !activation.canWriteTask(task.id)
									}
									label={m.task_reorder_handle()}
									testId="task-drag"
									revealHandle
									touch={reordering ? "reorder" : "hidden"}
								>
									{renderRow(task)}
								</SortableRow>
							)}
						</motion.li>
					))}
				</ul>
			</SortableContext>
		</DndContext>
	);
}
