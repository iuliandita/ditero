import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ChevronLeft,
	LayoutDashboard,
	MoreHorizontal,
	Pencil,
	Plus,
	Trash2,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
	type Panel,
	type PanelSize,
	panelsSchema,
} from "../../../domain/dashboard.ts";
import type { Dashboard } from "../../../zero/schema.gen.ts";
import { useIsDesktop } from "../../lib/use-media-query.ts";
import { useReorderSensors } from "../list/SortableList.tsx";
import { Button } from "../ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { PanelFrame } from "./PanelFrame.tsx";
import { PANEL_SPAN_CLASS } from "./panel-span.ts";

// Typed panel-body dispatch; Tasks 7/8 replace the placeholders per type.
function renderPanel(panel: Panel): ReactNode {
	switch (panel.type) {
		case "tasks":
		case "counter":
		case "streak":
		case "focus":
			return (
				<p
					data-testid="panel-body-placeholder"
					className="text-sm text-muted-foreground"
				>
					{panel.type}
				</p>
			);
	}
}

// One drag-sortable grid tile. The dnd transform lives on this wrapper (which
// also carries the column span); the PanelFrame header is the sole activator.
// Under prefers-reduced-motion the reflow transition drops to instant swaps.
function SortablePanel({
	panel,
	onResize,
	onRemove,
}: {
	panel: Panel;
	onResize: (size: PanelSize) => void;
	onRemove: () => void;
}): JSX.Element {
	const reduce = useReducedMotion();
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: panel.id });
	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition: reduce ? undefined : transition,
				zIndex: isDragging ? 10 : undefined,
			}}
			className={cn(PANEL_SPAN_CLASS[panel.size], isDragging && "opacity-90")}
		>
			<PanelFrame
				panel={panel}
				editing
				handle={{ attributes, listeners }}
				onResize={onResize}
				onRemove={onRemove}
			>
				{renderPanel(panel)}
			</PanelFrame>
		</div>
	);
}

// Dashboard surface: page header (name, Edit/Done, actions, mobile back) plus
// the 12-col panel grid (single column below md, array order). Edit mode is
// local state; every panel change round-trips through onUpdate -> dashboard.update.
export function DashboardView({
	dashboard,
	canEdit,
	onUpdate,
	onEditDashboard,
	onDeleteDashboard,
	onBack,
	onAddPanel,
}: {
	dashboard: Dashboard;
	canEdit: boolean;
	onUpdate: (panels: Panel[]) => void;
	onEditDashboard: () => void;
	onDeleteDashboard: () => void;
	onBack: () => void;
	onAddPanel: () => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	// Effective edit mode is gated on canEdit so a mid-edit role revocation
	// drops the surface back to view chrome instead of stranding failing writes.
	const [editRequested, setEditRequested] = useState(false);
	const editing = editRequested && canEdit;
	const sensors = useReorderSensors();
	// Panels are synced JSON a co-member could have corrupted out-of-band; a
	// malformed array renders an inline error block, never a crash.
	const parsed = useMemo(
		() => panelsSchema.safeParse(dashboard.panels),
		[dashboard.panels],
	);
	const panels = parsed.success ? parsed.data : [];

	function resizePanel(id: string, size: PanelSize) {
		onUpdate(panels.map((p) => (p.id === id ? { ...p, size } : p)));
	}
	function removePanel(id: string) {
		onUpdate(panels.filter((p) => p.id !== id));
	}
	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id) return;
		const from = panels.findIndex((p) => p.id === active.id);
		const to = panels.findIndex((p) => p.id === over.id);
		if (from < 0 || to < 0) return;
		onUpdate(arrayMove(panels, from, to));
	}

	let body: ReactNode;
	if (!parsed.success) {
		body = (
			<div
				role="alert"
				data-testid="dashboard-panels-error"
				className="rounded-lg border border-destructive/50 p-4 text-sm text-destructive"
			>
				This dashboard's panel data is invalid and can't be rendered.
			</div>
		);
	} else if (panels.length === 0 && !editing) {
		body = (
			<div
				data-testid="dashboard-empty"
				className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center"
			>
				<LayoutDashboard aria-hidden className="size-8 text-muted-foreground" />
				<p className="text-sm text-muted-foreground">
					Dashboards are pages of panels over your tasks.
				</p>
				{canEdit && (
					<Button
						data-testid="dashboard-empty-add"
						onClick={() => {
							setEditRequested(true);
							onAddPanel();
						}}
					>
						<Plus /> Add panel
					</Button>
				)}
			</div>
		);
	} else {
		const grid = (
			<div
				data-testid="dashboard-grid"
				className="grid grid-cols-1 gap-4 md:grid-cols-12"
			>
				{editing
					? panels.map((p) => (
							<SortablePanel
								key={p.id}
								panel={p}
								onResize={(size) => resizePanel(p.id, size)}
								onRemove={() => removePanel(p.id)}
							/>
						))
					: panels.map((p) => (
							<div key={p.id} className={PANEL_SPAN_CLASS[p.size]}>
								<PanelFrame panel={p} editing={false}>
									{renderPanel(p)}
								</PanelFrame>
							</div>
						))}
				{editing && (
					<button
						type="button"
						data-testid="add-panel"
						onClick={onAddPanel}
						className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:bg-muted/40 md:col-span-3"
					>
						<Plus className="size-4" /> Add panel
					</button>
				)}
			</div>
		);
		body = editing ? (
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={onDragEnd}
			>
				<SortableContext
					items={panels.map((p) => p.id)}
					strategy={rectSortingStrategy}
				>
					{grid}
				</SortableContext>
			</DndContext>
		) : (
			grid
		);
	}

	return (
		<section aria-label={dashboard.name} data-testid="dashboard-surface">
			<div className="mb-3 flex items-center gap-2">
				{!isDesktop && (
					<button
						type="button"
						aria-label="Back"
						onClick={onBack}
						className="flex size-9 shrink-0 items-center justify-center rounded-lg"
					>
						<ChevronLeft className="size-5" />
					</button>
				)}
				<h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
					{dashboard.name}
				</h1>
				{canEdit && (
					<Button
						variant={editing ? "default" : "outline"}
						size="sm"
						data-testid="dashboard-edit"
						aria-pressed={editing}
						onClick={() => setEditRequested(!editing)}
					>
						{editing ? "Done" : "Edit"}
					</Button>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Dashboard actions"
							data-testid="dashboard-actions"
						>
							<MoreHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							data-testid="dashboard-rename"
							onSelect={onEditDashboard}
						>
							<Pencil /> Edit
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							data-testid="dashboard-delete"
							className="text-destructive"
							onSelect={onDeleteDashboard}
						>
							<Trash2 /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{body}
		</section>
	);
}
