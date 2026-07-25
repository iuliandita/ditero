import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	useDroppable,
} from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMemo } from "react";
import { reorderSortKey } from "@/lib/reorder";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { SortableRow, useReorderSensors } from "../list/SortableList.tsx";
import { type RowHandlers, TaskRow } from "../list/TaskRow.tsx";
import type { ViewEntry, ViewEntryGroup } from "./ViewRenderer.tsx";

const COL_PREFIX = "col:";

function Card({
	entry,
	handlers,
}: {
	entry: ViewEntry;
	handlers: RowHandlers;
}) {
	return (
		<TaskRow
			task={entry.task}
			kind={entry.kind}
			subtasks={[]}
			labels={entry.labels}
			handlers={handlers}
		/>
	);
}

function ColumnShell({
	group,
	setNodeRef,
	isOver,
	children,
}: {
	group: ViewEntryGroup;
	setNodeRef?: (node: HTMLElement | null) => void;
	isOver?: boolean;
	children: React.ReactNode;
}) {
	const count = group.entries.length;
	return (
		<section
			ref={setNodeRef}
			aria-label={group.label || m.board_column_untitled()}
			className={cn(
				"flex w-64 shrink-0 flex-col rounded-lg bg-muted/40",
				isOver && "ring-2 ring-ring",
			)}
		>
			<header className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-lg bg-muted/80 px-3 py-2 backdrop-blur">
				<span className="truncate text-xs font-medium">
					{group.label || m.board_column_untitled()}
				</span>
				<span className="shrink-0 text-xs text-muted-foreground">
					{m.board_column_count({ count })}
				</span>
			</header>
			<div className="flex flex-col gap-1 p-2">{children}</div>
		</section>
	);
}

// Droppable + sortable column (used when the board supports drag).
function DroppableColumn({
	group,
	handlers,
}: {
	group: ViewEntryGroup;
	handlers: RowHandlers;
}) {
	const { setNodeRef, isOver } = useDroppable({
		id: `${COL_PREFIX}${group.key}`,
	});
	return (
		<ColumnShell group={group} setNodeRef={setNodeRef} isOver={isOver}>
			<SortableContext
				items={group.entries.map((e) => e.task.id)}
				strategy={verticalListSortingStrategy}
			>
				{group.entries.map((e) => (
					<div key={e.task.id} className="rounded-md border bg-card p-1">
						<SortableRow
							id={e.task.id}
							label={m.board_move_card()}
							testId="board-card-handle"
						>
							<Card entry={e} handlers={handlers} />
						</SortableRow>
					</div>
				))}
			</SortableContext>
		</ColumnShell>
	);
}

function StaticColumn({
	group,
	handlers,
}: {
	group: ViewEntryGroup;
	handlers: RowHandlers;
}) {
	return (
		<ColumnShell group={group}>
			{group.entries.map((e) => (
				<div key={e.task.id} className="rounded-md border bg-card p-1">
					<Card entry={e} handlers={handlers} />
				</div>
			))}
		</ColumnShell>
	);
}

// Kanban board: one column per group. Within-column reorder writes a single
// sortKey; a cross-column drop regroups (priority/status only) by writing that
// column's scalar. Fan-out group-bys (assignee/label) render static columns.
export function BoardLayout({
	groups,
	handlers,
	reorderable,
	regroupable,
	onReorder,
	onRegroup,
}: {
	groups: ViewEntryGroup[];
	handlers: RowHandlers;
	reorderable: boolean;
	regroupable: boolean;
	onReorder: (id: string, sortKey: string) => void;
	onRegroup: (id: string, columnKey: string) => void;
}) {
	const sensors = useReorderSensors();
	// Cards drag when either interaction is possible; within-column reorder is
	// gated on `reorderable`, cross-column regroup on `regroupable`, so a
	// scalar-sorted priority/status board still drags (to regroup) without
	// writing a stray sortKey.
	const dndEnabled = reorderable || regroupable;

	// Card id -> its column key, so a drop resolves the source/target columns.
	const colByCard = useMemo(() => {
		const map = new Map<string, string>();
		for (const g of groups)
			for (const e of g.entries) map.set(e.task.id, g.key);
		return map;
	}, [groups]);

	function columnOfOver(overId: string): string | null {
		if (overId.startsWith(COL_PREFIX)) return overId.slice(COL_PREFIX.length);
		return colByCard.get(overId) ?? null;
	}

	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over) return;
		const activeId = String(active.id);
		const overId = String(over.id);
		const from = colByCard.get(activeId);
		const to = columnOfOver(overId);
		if (from == null || to == null) return;

		if (from === to) {
			// Within-column reorder only when the view is in sortKey order.
			if (!reorderable || activeId === overId) return;
			const column = groups.find((g) => g.key === from);
			if (!column) return;
			const ordered = column.entries.map((en) => ({
				id: en.task.id,
				sortKey: en.task.sortKey,
			}));
			const key = reorderSortKey(ordered, activeId, overId);
			if (key) onReorder(activeId, key);
			return;
		}
		// Cross-column drop: regroup only where the column maps to one scalar.
		if (regroupable) onRegroup(activeId, to);
	}

	const board = (
		<div className="flex gap-3 overflow-x-auto pb-2">
			{groups.map((g) =>
				dndEnabled ? (
					<DroppableColumn key={g.key || "all"} group={g} handlers={handlers} />
				) : (
					<StaticColumn key={g.key || "all"} group={g} handlers={handlers} />
				),
			)}
		</div>
	);

	if (!dndEnabled) return board;
	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			onDragEnd={onDragEnd}
		>
			{board}
		</DndContext>
	);
}
