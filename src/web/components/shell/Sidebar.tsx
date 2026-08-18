import {
	List as ListFallback,
	PanelLeft,
	PanelLeftClose,
	Plus,
	Settings,
	Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ICONS, ListIcon } from "@/lib/list-icon";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";
import type { Dashboard, List, Workspace } from "../../../zero/schema.gen.ts";
import type { SavedView } from "../../hooks/useViews.ts";
import type { BuiltinView } from "../../views/builtins.ts";
import type { RowAction } from "../ui/row-action.ts";
import { RowActions, useRowContextMenu } from "../ui/row-actions.tsx";
import type { Section } from "./BottomNav.tsx";
import type { ListGroup } from "./grouping.ts";
import { ListProgress } from "./ListProgress.tsx";

// View row icon: built-ins carry a lucide key; saved views/dashboards may have
// none. Object.hasOwn guards the client-controlled key so a prototype key
// ("constructor"/"__proto__") on a shared row can't resolve to a non-component
// and crash the sidebar for every co-member.
function ViewIcon({ icon }: { icon?: string | null }) {
	const Icon =
		(icon && Object.hasOwn(ICONS, icon) && ICONS[icon]) || ListFallback;
	return <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

// One list row. Its own component because useRowContextMenu is a hook and the
// rows are built in a map. The <li> carries `group`: that is what RowActions'
// md:group-hover reveal keys off, and nothing else in the tree provides it.
function ListRow({
	list,
	active,
	onOpen,
	progress,
	collapsed,
	actions,
}: {
	list: List;
	active: boolean;
	onOpen: () => void;
	progress: { done: number; total: number } | undefined;
	collapsed: boolean;
	actions: RowAction[];
}) {
	const { rowProps, menu } = useRowContextMenu(
		actions,
		m.row_actions_for({ name: list.title }),
	);
	return (
		<li className="group flex items-center gap-1" {...rowProps}>
			<button
				type="button"
				aria-current={active ? "page" : undefined}
				onClick={onOpen}
				title={list.title}
				className={cn(
					"flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm",
					active
						? "bg-sidebar-accent font-medium"
						: "hover:bg-sidebar-accent/60",
					collapsed && "justify-center px-0",
				)}
			>
				<ListIcon
					icon={list.icon}
					kind={(list.kind ?? "tasks") as ListKind}
					title={list.title}
				/>
				{!collapsed && (
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate">{list.title}</span>
						{list.kind === "project" && progress && (
							<ListProgress done={progress.done} total={progress.total} />
						)}
					</span>
				)}
			</button>
			{!collapsed && (
				<RowActions
					actions={actions}
					label={m.row_actions_for({ name: list.title })}
				/>
			)}
			{menu}
		</li>
	);
}

// Persistent desktop rail (280px, collapsible to a 64px icon rail). Top:
// workspace switcher. Then Views (built-in aggregates + pinned saved views).
// Middle: folder/list tree with per-kind icons + accent. Bottom: Settings.
export function Sidebar({
	workspaces,
	activeId,
	onSelectWorkspace,
	onOpenShared,
	onOpenMembers,
	groups,
	progressByList,
	openListId,
	onOpenList,
	listActions,
	builtinViews,
	pinnedViews,
	activeViewId,
	onOpenView,
	onNewView,
	dashboards,
	activeDashboardId,
	onOpenDashboard,
	onNewDashboard,
	section,
	onOpenSettings,
	collapsed,
	onToggleCollapsed,
}: {
	workspaces: Workspace[];
	activeId: string | null;
	onSelectWorkspace: (id: string) => void;
	onOpenShared: () => void;
	onOpenMembers: () => void;
	groups: ListGroup[];
	progressByList: Map<string, { done: number; total: number }>;
	openListId: string | null;
	onOpenList: (id: string) => void;
	listActions: (list: List) => RowAction[];
	builtinViews: BuiltinView[];
	pinnedViews: SavedView[];
	activeViewId: string | null;
	onOpenView: (id: string) => void;
	onNewView: () => void;
	dashboards: Dashboard[];
	activeDashboardId: string | null;
	onOpenDashboard: (id: string) => void;
	onNewDashboard: () => void;
	section: Section;
	onOpenSettings: () => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
}) {
	// A view row is current only on the views surface: no list open, lists section.
	const viewActive = (id: string) =>
		activeViewId === id && openListId == null && section === "lists";
	// Opening a dashboard clears list/view state, so its own id check suffices.
	const dashboardActive = (id: string) =>
		activeDashboardId === id && section === "lists";
	const viewRow = (id: string, name: string, icon?: string | null) => (
		<li key={id}>
			<button
				type="button"
				aria-current={viewActive(id) ? "page" : undefined}
				onClick={() => onOpenView(id)}
				title={name}
				className={cn(
					"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm",
					viewActive(id)
						? "bg-sidebar-accent font-medium"
						: "hover:bg-sidebar-accent/60",
					collapsed && "justify-center px-0",
				)}
			>
				<ViewIcon icon={icon} />
				{!collapsed && <span className="truncate">{name}</span>}
			</button>
		</li>
	);
	return (
		<aside
			className={cn(
				"sticky top-0 flex h-dvh flex-col border-e bg-sidebar text-sidebar-foreground",
				collapsed ? "w-16" : "w-[280px]",
			)}
		>
			<div className="flex flex-col gap-1 border-b p-2">
				{!collapsed &&
					workspaces.map((w) => (
						<button
							key={w.id}
							type="button"
							aria-current={w.id === activeId ? "true" : undefined}
							onClick={() => onSelectWorkspace(w.id)}
							className={cn(
								"truncate rounded-lg px-2 py-1.5 text-start text-sm",
								w.id === activeId
									? "bg-sidebar-accent font-medium"
									: "text-muted-foreground hover:bg-sidebar-accent/60",
							)}
						>
							{w.name}
						</button>
					))}
				<Button
					data-testid="open-shared"
					variant="ghost"
					size="sm"
					className={cn("justify-start", collapsed && "justify-center px-0")}
					aria-label={m.sidebar_open_shared()}
					onClick={onOpenShared}
				>
					{collapsed ? m.sidebar_open_shared_short() : m.sidebar_open_shared()}
				</Button>
				{/* Workspace-level Members entry (UX doc section 1). The list-header
				    "Share list" flow, which spins up a shared workspace from a personal
				    list, is deferred: it needs a workspace-create + list-move mutator
				    (M1b follow-up), not a UI-only change. */}
				<Button
					data-testid="open-members"
					variant="ghost"
					size="sm"
					className={cn("justify-start", collapsed && "justify-center px-0")}
					aria-label={m.sidebar_members()}
					disabled={!activeId}
					onClick={onOpenMembers}
				>
					<Users className="size-4" />
					{!collapsed && m.sidebar_members()}
				</Button>
			</div>

			<nav
				className="flex-1 overflow-y-auto p-2"
				aria-label={m.sidebar_lists_nav_label()}
			>
				<div className="mb-3">
					{!collapsed && (
						<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
							{m.sidebar_views_heading()}
						</div>
					)}
					<ul className="flex flex-col gap-0.5">
						{builtinViews.map((v) => viewRow(v.id, v.name, v.icon))}
						{pinnedViews.map((v) => viewRow(v.id, v.name, v.icon))}
						<li>
							<button
								type="button"
								data-testid="new-view"
								onClick={onNewView}
								title={m.action_new_view()}
								className={cn(
									"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm text-muted-foreground hover:bg-sidebar-accent/60",
									collapsed && "justify-center px-0",
								)}
							>
								<Plus className="size-4 shrink-0" />
								{!collapsed && m.action_new_view()}
							</button>
						</li>
					</ul>
				</div>

				<div className="mb-3">
					{!collapsed && (
						<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
							{m.sidebar_dashboards_heading()}
						</div>
					)}
					<ul className="flex flex-col gap-0.5">
						{dashboards.map((d) => (
							<li key={d.id}>
								<button
									type="button"
									aria-current={dashboardActive(d.id) ? "page" : undefined}
									onClick={() => onOpenDashboard(d.id)}
									title={d.name}
									className={cn(
										"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm",
										dashboardActive(d.id)
											? "bg-sidebar-accent font-medium"
											: "hover:bg-sidebar-accent/60",
										collapsed && "justify-center px-0",
									)}
								>
									<ViewIcon icon={d.icon} />
									{!collapsed && <span className="truncate">{d.name}</span>}
								</button>
							</li>
						))}
						<li>
							<button
								type="button"
								data-testid="new-dashboard"
								onClick={onNewDashboard}
								title={m.action_new_dashboard()}
								className={cn(
									"flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm text-muted-foreground hover:bg-sidebar-accent/60",
									collapsed && "justify-center px-0",
								)}
							>
								<Plus className="size-4 shrink-0" />
								{!collapsed && m.action_new_dashboard()}
							</button>
						</li>
					</ul>
				</div>

				{groups.map((group) => (
					<div key={group.folder?.id ?? "__ungrouped__"} className="mb-3">
						{!collapsed && (
							<div className="px-2 py-1 text-xs font-medium text-muted-foreground">
								{group.folder?.name ?? m.sidebar_ungrouped_lists()}
							</div>
						)}
						<ul className="flex flex-col gap-0.5">
							{group.lists.map((l) => (
								<ListRow
									key={l.id}
									list={l}
									active={l.id === openListId && section === "lists"}
									onOpen={() => onOpenList(l.id)}
									progress={progressByList.get(l.id)}
									collapsed={collapsed}
									actions={listActions(l)}
								/>
							))}
						</ul>
					</div>
				))}
			</nav>

			<div className="flex items-center gap-1 border-t p-2">
				<Button
					variant={section === "settings" ? "secondary" : "ghost"}
					size="sm"
					className={cn(
						"flex-1 justify-start",
						collapsed && "justify-center px-0",
					)}
					onClick={onOpenSettings}
				>
					<Settings className="size-4" />
					{!collapsed && m.nav_settings()}
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={collapsed ? m.sidebar_expand() : m.sidebar_collapse()}
					onClick={onToggleCollapsed}
				>
					{collapsed ? (
						<PanelLeft className="size-4" />
					) : (
						<PanelLeftClose className="size-4" />
					)}
				</Button>
			</div>
		</aside>
	);
}
