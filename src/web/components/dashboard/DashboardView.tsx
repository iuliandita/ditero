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
	House,
	LayoutDashboard,
	MoreHorizontal,
	Pencil,
	Plus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
	MAX_PANELS,
	type Panel,
	type PanelSize,
	panelsSchema,
	type ResolvedSource,
	resolvePanelSource,
} from "../../../domain/dashboard.ts";
import type {
	Dashboard,
	Folder,
	Task,
	Workspace,
} from "../../../zero/schema.gen.ts";
import type { SavedView } from "../../hooks/useViews.ts";
import { useIsDesktop } from "../../lib/use-media-query.ts";
import { useReorderSensors } from "../list/SortableList.tsx";
import { Button } from "../ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { AddPanelDialog } from "./AddPanelDialog.tsx";
import { CounterPanel } from "./CounterPanel.tsx";
import { FocusPanel } from "./FocusPanel.tsx";
import { PanelFrame, panelLabel } from "./PanelFrame.tsx";
import type { PanelData, PanelIds } from "./panel-shared.tsx";
import { PANEL_SPAN_CLASS } from "./panel-span.ts";
import { StreakPanel } from "./StreakPanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";

type PanelDialogState = { mode: "add" } | { mode: "edit"; panel: Panel } | null;

// Dangling view ref (shell doc §4): explicit warning, never silently empty.
// "Replace view" opens the panel editor for canEdit users regardless of the
// surface edit mode; viewers get the text only.
function ViewMissing({
	canEdit,
	onReplace,
}: {
	canEdit: boolean;
	onReplace: () => void;
}): JSX.Element {
	return (
		<div
			data-testid="panel-view-missing"
			className="flex flex-col items-start gap-2 text-sm text-muted-foreground"
		>
			<p className="flex items-start gap-1.5">
				<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
				This panel's saved view was deleted or isn't shared with you.
			</p>
			{canEdit && (
				<Button
					variant="outline"
					size="sm"
					data-testid="panel-replace-view"
					onClick={onReplace}
				>
					Replace view
				</Button>
			)}
		</div>
	);
}

// One drag-sortable grid tile. The dnd transform lives on this wrapper (which
// also carries the column span); the PanelFrame header is the sole activator.
// Under prefers-reduced-motion the reflow transition drops to instant swaps.
function SortablePanel({
	panel,
	viewName,
	onEdit,
	onResize,
	onRemove,
	children,
}: {
	panel: Panel;
	viewName: string | null;
	onEdit?: () => void;
	onResize: (size: PanelSize) => void;
	onRemove: () => void;
	children: ReactNode;
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
				viewName={viewName}
				onEdit={onEdit}
				onResize={onResize}
				onRemove={onRemove}
			>
				{children}
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
	onSetHome,
	isHome,
	onBack,
	data,
	ids,
	views,
	folders,
	members,
	workspaces,
	onOpenTask,
	onOpenView,
}: {
	dashboard: Dashboard;
	canEdit: boolean;
	onUpdate: (panels: Panel[]) => void;
	onEditDashboard: () => void;
	onDeleteDashboard: () => void;
	onSetHome: () => void;
	isHome: boolean;
	onBack: () => void;
	data: PanelData;
	ids: PanelIds;
	views: SavedView[];
	folders: Folder[];
	members: { id: string; name: string }[];
	workspaces: Workspace[];
	onOpenTask: (task: Task) => void;
	onOpenView: (viewId: string) => void;
}): JSX.Element {
	const isDesktop = useIsDesktop();
	// Effective edit mode is gated on canEdit so a mid-edit role revocation
	// drops the surface back to view chrome instead of stranding failing writes.
	const [editRequested, setEditRequested] = useState(false);
	const [panelDialog, setPanelDialog] = useState<PanelDialogState>(null);
	const sensors = useReorderSensors();
	// Panels are synced JSON a co-member could have corrupted out-of-band; a
	// malformed array renders an inline error block, never a crash. The Edit
	// toggle stays absent in that state (nothing on the surface is editable).
	const parsed = useMemo(
		() => panelsSchema.safeParse(dashboard.panels),
		[dashboard.panels],
	);
	const panels = parsed.success ? parsed.data : [];
	const editing = editRequested && canEdit && parsed.success;

	const viewsById = useMemo(
		() => new Map(views.map((v) => [v.id, v])),
		[views],
	);
	const atCap = panels.length >= MAX_PANELS;

	// Habit tasks = tasks on lists of kind "habits" (same mechanics HabitCard's
	// surface uses); feeds the streak-panel multi-pick.
	const habitTasks = useMemo(() => {
		const habitListIds = new Set(
			data.lists.filter((l) => l.kind === "habits").map((l) => l.id),
		);
		return data.tasks
			.filter((t) => habitListIds.has(t.listId))
			.map((t) => ({ id: t.id, title: t.title }));
	}, [data.lists, data.tasks]);

	// resolvePanelSource returns a fresh object per call; resolving once per
	// panels/views change keeps each panel's `resolved` prop referentially
	// stable so usePanelEntries' memo holds across parent renders.
	const resolvedById = useMemo(() => {
		const map = new Map<string, ResolvedSource>();
		for (const p of panels) {
			if (p.type !== "tasks" && p.type !== "counter") continue;
			const resolved = resolvePanelSource(p.source, viewsById);
			if (resolved) map.set(p.id, resolved);
		}
		return map;
	}, [panels, viewsById]);

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
	function submitPanel(panel: Panel) {
		if (panelDialog?.mode === "edit") {
			onUpdate(panels.map((p) => (p.id === panel.id ? panel : p)));
		} else {
			onUpdate([...panels, panel]);
		}
		setPanelDialog(null);
	}

	// The referenced view's name feeds the derived header label (shell doc §1)
	// and the expand-dialog title; null for inline sources and dangling refs.
	function panelViewName(panel: Panel): string | null {
		if (panel.type !== "tasks" && panel.type !== "counter") return null;
		if (panel.source.kind !== "view") return null;
		return viewsById.get(panel.source.viewId)?.name ?? null;
	}

	// Typed panel-body dispatch.
	function renderPanel(panel: Panel): ReactNode {
		switch (panel.type) {
			case "tasks":
			case "counter": {
				const resolved = resolvedById.get(panel.id) ?? null;
				if (resolved === null) {
					return (
						<ViewMissing
							canEdit={canEdit}
							onReplace={() => setPanelDialog({ mode: "edit", panel })}
						/>
					);
				}
				const label = panelLabel(panel, panelViewName(panel));
				return panel.type === "tasks" ? (
					<TasksPanel
						panel={panel}
						resolved={resolved}
						label={label}
						data={data}
						ids={ids}
						onOpenTask={onOpenTask}
						onOpenView={onOpenView}
					/>
				) : (
					<CounterPanel
						panel={panel}
						resolved={resolved}
						label={label}
						data={data}
						ids={ids}
						onOpenTask={onOpenTask}
						onOpenView={onOpenView}
					/>
				);
			}
			case "streak":
				return (
					<StreakPanel panel={panel} data={data} onOpenTask={onOpenTask} />
				);
			case "focus":
				return <FocusPanel panel={panel} />;
			default:
				return panel satisfies never;
		}
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
							setPanelDialog({ mode: "add" });
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
								viewName={panelViewName(p)}
								onEdit={() => setPanelDialog({ mode: "edit", panel: p })}
								onResize={(size) => resizePanel(p.id, size)}
								onRemove={() => removePanel(p.id)}
							>
								{renderPanel(p)}
							</SortablePanel>
						))
					: panels.map((p) => (
							<div key={p.id} className={PANEL_SPAN_CLASS[p.size]}>
								<PanelFrame
									panel={p}
									editing={false}
									viewName={panelViewName(p)}
								>
									{renderPanel(p)}
								</PanelFrame>
							</div>
						))}
				{editing &&
					(atCap ? (
						<p
							data-testid="panel-limit-reached"
							className="flex min-h-28 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground md:col-span-3"
						>
							Panel limit reached
						</p>
					) : (
						<button
							type="button"
							data-testid="add-panel"
							onClick={() => setPanelDialog({ mode: "add" })}
							className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground hover:bg-muted/40 md:col-span-3"
						>
							<Plus className="size-4" /> Add panel
						</button>
					))}
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
				{canEdit && parsed.success && (
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
						<DropdownMenuCheckboxItem
							data-testid="dashboard-set-home"
							checked={isHome}
							onSelect={onSetHome}
						>
							<House /> Set as home
						</DropdownMenuCheckboxItem>
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
			{panelDialog && (
				<AddPanelDialog
					// Remount per target so edit prefill never leaks between panels.
					key={panelDialog.mode === "edit" ? panelDialog.panel.id : "add"}
					open
					onOpenChange={(o) => {
						if (!o) setPanelDialog(null);
					}}
					mode={panelDialog.mode}
					atCap={atCap}
					initial={panelDialog.mode === "edit" ? panelDialog.panel : undefined}
					views={views.map((v) => ({ id: v.id, name: v.name }))}
					lists={data.lists.map((l) => ({ id: l.id, title: l.title }))}
					folders={folders.map((f) => ({ id: f.id, name: f.name }))}
					labels={data.labels.map((l) => ({
						id: l.id,
						name: l.name,
						color: l.color ?? undefined,
					}))}
					members={members}
					workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
					habitTasks={habitTasks}
					onSubmit={submitPanel}
				/>
			)}
		</section>
	);
}
