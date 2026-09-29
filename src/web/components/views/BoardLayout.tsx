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
import { Flag } from "lucide-react";
import { useMemo } from "react";
import { reorderSortKey } from "@/lib/reorder";
import { priorityMeta } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { useTaskImportActivationMap } from "../../hooks/useTaskImportActivation.ts";
import { splitCompleted } from "../../views/group.ts";
import { CompletedSection } from "../list/CompletedSection.tsx";
import { SortableRow, useReorderSensors } from "../list/SortableList.tsx";
import { type RowHandlers, TaskRow } from "../list/TaskRow.tsx";
import type { ViewEntry, ViewEntryGroup } from "./ViewRenderer.tsx";

const COL_PREFIX = "col:";

// One surface per card: the border and fill live on this node only, and the
// row inside paints the same card fill, so nothing reads as a box in a box.
const CARD_SURFACE =
	"rounded-lg border bg-card p-1 transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:border-control-border/60 motion-reduce:transition-none";

type CardOptions = { handlers: RowHandlers; spansLists: boolean };

function CardBody({
	entry,
	handlers,
	spansLists,
}: CardOptions & { entry: ViewEntry }) {
	return (
		<TaskRow
			task={entry.task}
			kind={entry.kind}
			subtasks={[]}
			labels={entry.labels}
			handlers={handlers}
			variant="card"
			list={
				spansLists ? { title: entry.listTitle, icon: entry.listIcon } : null
			}
		/>
	);
}

function StaticCard(props: CardOptions & { entry: ViewEntry }) {
	return (
		<div data-testid="board-card" className={CARD_SURFACE}>
			<CardBody {...props} />
		</div>
	);
}

function SortableCard(props: CardOptions & { entry: ViewEntry }) {
	const activation = useTaskImportActivationMap();
	const id = props.entry.task.id;
	return (
		<div data-testid="board-card">
			<SortableRow
				disabled={!activation.canWriteTask(id)}
				id={id}
				label={m.board_move_card()}
				testId="board-card-handle"
				revealHandle
				// Dragging is the board's own gesture, so touch gets a full 44px grip;
				// a long press on the card body still opens the row menu.
				touch="reorder"
				// A slim grip keeps the card's start edge close to its checkbox.
				className={cn(CARD_SURFACE, "gap-0")}
				handleClassName="mt-2 w-4"
			>
				<CardBody {...props} />
			</SortableRow>
		</div>
	);
}

function ColumnShell({
	group,
	priorityColumns,
	collapseCompleted,
	options,
	setNodeRef,
	isOver,
	renderOpen,
}: {
	group: ViewEntryGroup;
	priorityColumns: boolean;
	collapseCompleted: boolean;
	options: CardOptions;
	setNodeRef?: (node: HTMLElement | null) => void;
	isOver?: boolean;
	renderOpen: (entries: ViewEntry[]) => React.ReactNode;
}) {
	const { open, done } = collapseCompleted
		? splitCompleted(group.entries)
		: { open: group.entries, done: [] };
	const label = group.label || m.board_column_untitled();
	const tone = priorityColumns ? priorityMeta(Number(group.key)) : null;
	return (
		<section
			ref={setNodeRef}
			aria-label={label}
			data-testid="board-column"
			className={cn(
				"flex w-66 shrink-0 flex-col rounded-xl bg-muted",
				isOver && "ring-2 ring-ring",
			)}
		>
			<header
				data-testid="board-column-header"
				className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-xl bg-muted px-3 py-2"
			>
				<span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
					{tone && (
						<Flag
							aria-hidden
							className={cn("size-3.5 shrink-0 fill-current", tone.color)}
						/>
					)}
					<span className="truncate">{label}</span>
				</span>
				<span className="shrink-0 text-xs text-muted-foreground">
					{m.board_column_count({ count: open.length })}
				</span>
			</header>
			<div className="flex flex-col gap-2 px-2 pb-2">{renderOpen(open)}</div>
			{done.length > 0 && (
				<div className="px-2 pb-2 [&>div]:mt-0">
					<CompletedSection
						count={done.length}
						label={m.list_completed_count({ count: done.length })}
					>
						<div className="flex flex-col gap-2">
							{done.map((e) => (
								<StaticCard key={e.task.id} entry={e} {...options} />
							))}
						</div>
					</CompletedSection>
				</div>
			)}
		</section>
	);
}

type ColumnProps = {
	group: ViewEntryGroup;
	priorityColumns: boolean;
	collapseCompleted: boolean;
	options: CardOptions;
};

// Droppable + sortable column (used when the board supports drag). Completed
// cards stay out of the sortable set, like a list's completed group.
function DroppableColumn(props: ColumnProps) {
	const { setNodeRef, isOver } = useDroppable({
		id: `${COL_PREFIX}${props.group.key}`,
	});
	return (
		<ColumnShell
			{...props}
			setNodeRef={setNodeRef}
			isOver={isOver}
			renderOpen={(open) => (
				<SortableContext
					items={open.map((e) => e.task.id)}
					strategy={verticalListSortingStrategy}
				>
					{open.map((e) => (
						<SortableCard key={e.task.id} entry={e} {...props.options} />
					))}
				</SortableContext>
			)}
		/>
	);
}

function StaticColumn(props: ColumnProps) {
	return (
		<ColumnShell
			{...props}
			renderOpen={(open) =>
				open.map((e) => (
					<StaticCard key={e.task.id} entry={e} {...props.options} />
				))
			}
		/>
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
	priorityColumns,
	collapseCompleted,
	spansLists,
	onReorder,
	onRegroup,
}: {
	groups: ViewEntryGroup[];
	handlers: RowHandlers;
	reorderable: boolean;
	regroupable: boolean;
	priorityColumns: boolean;
	collapseCompleted: boolean;
	spansLists: boolean;
	onReorder: (id: string, sortKey: string) => void;
	onRegroup: (id: string, columnKey: string) => void;
}) {
	const sensors = useReorderSensors();
	const activation = useTaskImportActivationMap();
	// Cards drag when either interaction is possible; within-column reorder is
	// gated on `reorderable`, cross-column regroup on `regroupable`, so a
	// scalar-sorted priority/status board still drags (to regroup) without
	// writing a stray sortKey.
	const dndEnabled = reorderable || regroupable;
	const options = { handlers, spansLists };

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
		if (!activation.canWriteTask(activeId)) return;
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

	const Column = dndEnabled ? DroppableColumn : StaticColumn;
	const board = (
		// Wider than its container once the columns outgrow it, so the scroller
		// itself takes focus: keyboard users scroll it with the arrow keys.
		<section
			aria-label={m.view_layout_board()}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to be keyboard-scrollable
			tabIndex={0}
			className="flex gap-3 overflow-x-auto rounded-xl pb-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{groups.map((g) => (
				<Column
					key={g.key || "all"}
					group={g}
					priorityColumns={priorityColumns}
					collapseCompleted={collapseCompleted}
					options={options}
				/>
			))}
		</section>
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
