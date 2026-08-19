import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	MouseSensor,
	type SensorDescriptor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { reorderSortKey } from "@/lib/reorder";
import { cn } from "@/lib/utils";

// Shared drag sensors for every reorderable list: mouse drags immediately, a
// touch needs a 150ms press-delay (so a quick horizontal touch stays a swipe,
// not a drag), and the keyboard sensor keeps reorder accessible (space to lift,
// arrows to move, space to drop).
export function useReorderSensors(): SensorDescriptor<object>[] {
	return useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 150, tolerance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);
}

// One drag-sortable row. The dnd-kit transform lives on this node; the grip is
// the sole drag activator so a row body stays free for other gestures (e.g. the
// task-row swipe) and the handle remains keyboard-focusable for a11y.
export function SortableRow({
	id,
	label,
	testId,
	revealHandle,
	children,
}: {
	id: string;
	label: string;
	testId: string;
	// Reveal the grip on hover/focus like RowActions' kebab. Below md there is no
	// hover, so it stays visible there.
	revealHandle?: boolean;
	children: ReactNode;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });
	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				zIndex: isDragging ? 10 : undefined,
			}}
			className={cn(
				"flex items-start gap-1",
				revealHandle && "group",
				isDragging && "opacity-90",
			)}
		>
			<button
				type="button"
				data-testid={testId}
				aria-label={label}
				className={cn(
					"mt-1.5 flex size-6 shrink-0 touch-none items-center justify-center rounded text-muted-foreground/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
					revealHandle &&
						"transition-opacity motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
				)}
				{...attributes}
				{...listeners}
			>
				<GripVertical className="size-4" />
			</button>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

// Generic flat drag-reorder list. Every item is sortable and on drop only the
// dragged row's sortKey is written (design 2.8); the caller's synced query
// re-sorts from that single write.
export function SortableList<T extends { id: string; sortKey: string }>({
	items,
	onMove,
	renderItem,
	handleLabel,
	handleTestId,
	className,
}: {
	items: T[];
	onMove: (id: string, sortKey: string) => void;
	renderItem: (item: T) => ReactNode;
	handleLabel: string;
	handleTestId: string;
	className?: string;
}) {
	const sensors = useReorderSensors();

	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		const key = reorderSortKey(items, String(active.id), String(over.id));
		if (key) onMove(String(active.id), key);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragEnd={onDragEnd}
		>
			<SortableContext
				items={items.map((i) => i.id)}
				strategy={verticalListSortingStrategy}
			>
				<ul className={cn("flex flex-col", className)}>
					{items.map((item) => (
						<li key={item.id}>
							<SortableRow
								id={item.id}
								label={handleLabel}
								testId={handleTestId}
								revealHandle
							>
								{renderItem(item)}
							</SortableRow>
						</li>
					))}
				</ul>
			</SortableContext>
		</DndContext>
	);
}
