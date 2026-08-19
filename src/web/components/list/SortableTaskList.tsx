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
import { SortableRow, useReorderSensors } from "./SortableList.tsx";

// Open tasks are drag-sortable; completed rows render statically and are never
// part of the sortable set (design: reorder never touches the completed group).
// The dnd transform lives on the inner SortableRow so it never fights the outer
// motion.li FLIP layout animation; on touch the row body owns the swipe gesture
// and the grip is the sole drag activator, so the two never collide.
export function SortableTaskList({
	tasks,
	onMove,
	renderRow,
	reduce,
}: {
	tasks: Task[];
	onMove: (id: string, sortKey: string) => void;
	renderRow: (task: Task) => ReactNode;
	reduce: boolean;
}) {
	const sortable = tasks.filter((t) => !t.done);
	const sortableIds = sortable.map((t) => t.id);
	const sensors = useReorderSensors();

	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
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
							className={task.done ? "opacity-70" : undefined}
						>
							{task.done ? (
								renderRow(task)
							) : (
								<SortableRow
									id={task.id}
									label={m.task_reorder_handle()}
									testId="task-drag"
									revealHandle
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
