import {
	ChevronRight,
	FolderPlus,
	ListPlus,
	type LucideIcon,
	PanelLeft,
	PanelLeftClose,
	Plus,
	Settings,
} from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListIcon } from "@/lib/list-icon";
import { dashboardIcon, FolderIcon, viewIcon } from "@/lib/nav-icon";
import type { NavSection } from "@/lib/nav-sections";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";
import type {
	Dashboard,
	Folder,
	List,
	Workspace,
} from "../../../zero/schema.gen.ts";
import type { SavedView } from "../../hooks/useViews.ts";
import type { BuiltinView } from "../../views/builtins.ts";
import { KeyText } from "../ui/key-text.tsx";
import type { RowAction } from "../ui/row-action.ts";
import { RowActions, useRowContextMenu } from "../ui/row-actions.tsx";
import type { Section } from "./BottomNav.tsx";
import type { ListGroup } from "./grouping.ts";
import { ListProgress } from "./ListProgress.tsx";
import { SyncIndicator } from "./SyncIndicator.tsx";
import { ThemeMenu } from "./ThemeMenu.tsx";
import { WorkspaceSwitcherMenu } from "./WorkspaceSwitcher.tsx";

const ROW =
	"flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm transition-colors duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none";

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
				data-list-id={list.id}
				aria-current={active ? "page" : undefined}
				onClick={onOpen}
				title={list.title}
				className={cn(
					ROW,
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

// A view or dashboard nav row. Both render identically (icon + name + active
// state) and differ only in their glyph and action descriptor, so they share
// one component. Carries `group` for the same reason ListRow does: without it
// RowActions' md:group-hover reveal never fires.
function NavRow({
	name,
	icon: Icon,
	kind,
	active,
	onOpen,
	collapsed,
	actions,
}: {
	name: string;
	icon: LucideIcon;
	kind: "view" | "dashboard";
	active: boolean;
	onOpen: () => void;
	collapsed: boolean;
	actions: RowAction[];
}) {
	const label = m.row_actions_for({ name });
	const { rowProps, menu } = useRowContextMenu(actions, label);
	return (
		<li className="group flex items-center gap-1" {...rowProps}>
			<button
				type="button"
				data-nav-kind={kind}
				aria-current={active ? "page" : undefined}
				onClick={onOpen}
				title={name}
				className={cn(
					ROW,
					active
						? "bg-sidebar-accent font-medium"
						: "hover:bg-sidebar-accent/60",
					collapsed && "justify-center px-0",
				)}
			>
				<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
				{!collapsed && <span className="truncate">{name}</span>}
			</button>
			{!collapsed && <RowActions actions={actions} label={label} />}
			{menu}
		</li>
	);
}

// A folder is a real row with a folder glyph and its lists nested under it, so
// an empty folder never reads as a stray heading. Own component for the same
// reason ListRow is one, and it carries `group` for the same reason.
function FolderRow({
	folder,
	actions,
	children,
}: {
	folder: Folder;
	actions: RowAction[];
	children: ReactNode;
}) {
	const label = m.row_actions_for({ name: folder.name });
	const { rowProps, menu } = useRowContextMenu(actions, label);
	return (
		<li data-folder-id={folder.id}>
			<div className="group flex items-center gap-1" {...rowProps}>
				<span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
					<FolderIcon aria-hidden className="size-4 shrink-0" />
					<span className="truncate">{folder.name}</span>
				</span>
				<RowActions actions={actions} label={label} />
				{menu}
			</div>
			{children}
		</li>
	);
}

// A sidebar section. Views and Dashboards fold away (remembered per user); the
// chevron follows the disclosure rule: closed points along the reading
// direction and mirrors in RTL, open points down and does not.
export function NavGroup({
	title,
	section,
	open = true,
	onToggle,
	hideTitle,
	touch,
	children,
}: {
	title: string;
	section: NavSection | "lists";
	open?: boolean;
	onToggle?: () => void;
	hideTitle?: boolean;
	// Phones: the toggle grows to a 44px target.
	touch?: boolean;
	children: ReactNode;
}) {
	const id = useId();
	const expanded = !onToggle || open;
	return (
		<section
			aria-labelledby={hideTitle ? undefined : id}
			aria-label={hideTitle ? title : undefined}
			data-nav-group={section}
			className="mt-5"
		>
			{!hideTitle &&
				(onToggle ? (
					<button
						type="button"
						id={id}
						aria-expanded={expanded}
						onClick={onToggle}
						className={cn(
							"flex w-full items-center gap-1 rounded-md px-2 py-1 text-start text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:text-foreground motion-reduce:transition-none",
							touch && "min-h-11",
						)}
					>
						<span className="flex-1">{title}</span>
						<ChevronRight
							aria-hidden
							className={cn(
								"size-3.5 shrink-0 transition-transform duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
								expanded ? "rotate-90" : "rtl:rotate-180",
							)}
						/>
					</button>
				) : (
					<div
						id={id}
						className="px-2 py-1 text-xs font-medium text-muted-foreground"
					>
						{title}
					</div>
				))}
			{expanded && children}
		</section>
	);
}

// Persistent desktop rail (280px, collapsible to a 64px icon rail). Top: the
// workspace switcher. Then navigation in order of use: Today and the other
// built-in views, the workspace's lists by folder, then pinned views and
// dashboards (both foldable). Bottom: create, settings, theme, collapse.
export function Sidebar({
	workspaces,
	activeId,
	onSelectWorkspace,
	onManageMembers,
	canManageMembers,
	groups,
	progressByList,
	openListId,
	onOpenList,
	listActions,
	folderActions,
	onNewList,
	onNewListInFolder,
	canCreateList,
	onNewFolder,
	canCreateFolder,
	builtinViews,
	pinnedViews,
	activeViewId,
	onOpenView,
	onNewView,
	viewActions,
	dashboards,
	activeDashboardId,
	onOpenDashboard,
	onNewDashboard,
	dashboardActions,
	isSectionOpen,
	onToggleSection,
	section,
	onOpenSettings,
	onOpenAppearance,
	shortcutHintKey,
	onOpenShortcuts,
	collapsed,
	onToggleCollapsed,
}: {
	workspaces: Workspace[];
	activeId: string | null;
	onSelectWorkspace: (id: string) => void;
	onManageMembers: () => void;
	canManageMembers: boolean;
	groups: ListGroup[];
	progressByList: Map<string, { done: number; total: number }>;
	openListId: string | null;
	onOpenList: (id: string) => void;
	listActions: (list: List) => RowAction[];
	folderActions: (folder: Folder) => RowAction[];
	onNewList: () => void;
	onNewListInFolder: (folderId: string) => void;
	canCreateList: boolean;
	onNewFolder: () => void;
	canCreateFolder: boolean;
	builtinViews: BuiltinView[];
	pinnedViews: SavedView[];
	activeViewId: string | null;
	onOpenView: (id: string) => void;
	onNewView: () => void;
	viewActions: (id: string) => RowAction[];
	dashboards: Dashboard[];
	activeDashboardId: string | null;
	onOpenDashboard: (id: string) => void;
	onNewDashboard: () => void;
	dashboardActions: (dashboard: Dashboard) => RowAction[];
	isSectionOpen: (section: NavSection, hasItems?: boolean) => boolean;
	onToggleSection: (section: NavSection, hasItems?: boolean) => void;
	section: Section;
	onOpenSettings: () => void;
	onOpenAppearance?: () => void;
	/** Keycap for the cheat sheet while its hint is still due; null hides it. */
	shortcutHintKey: string | null;
	onOpenShortcuts: () => void;
	collapsed: boolean;
	onToggleCollapsed: () => void;
}) {
	const focusNewList = useRef(false);
	// A view row is current only on the views surface: no list open, lists section.
	const viewActive = (id: string) =>
		activeViewId === id && openListId == null && section === "lists";
	// Opening a dashboard clears list/view state, so its own id check suffices.
	const dashboardActive = (id: string) =>
		activeDashboardId === id && section === "lists";
	const viewRow = (view: BuiltinView | SavedView) => (
		<NavRow
			key={view.id}
			name={view.name}
			icon={viewIcon(view)}
			kind="view"
			active={viewActive(view.id)}
			onOpen={() => onOpenView(view.id)}
			collapsed={collapsed}
			actions={viewActions(view.id)}
		/>
	);
	const listRow = (l: List) => (
		<ListRow
			key={l.id}
			list={l}
			active={l.id === openListId && section === "lists"}
			onOpen={() => onOpenList(l.id)}
			progress={progressByList.get(l.id)}
			collapsed={collapsed}
			actions={listActions(l)}
		/>
	);
	return (
		<aside
			className={cn(
				"sticky top-0 flex h-dvh flex-col border-e bg-sidebar text-sidebar-foreground",
				collapsed ? "w-16" : "w-[280px]",
			)}
		>
			<div className="p-2">
				<WorkspaceSwitcherMenu
					workspaces={workspaces}
					activeId={activeId}
					onSelect={onSelectWorkspace}
					onManageMembers={onManageMembers}
					canManageMembers={canManageMembers}
					onOpenSettings={onOpenSettings}
					onOpenAppearance={onOpenAppearance}
					collapsed={collapsed}
				/>
			</div>

			<nav
				className="flex-1 overflow-y-auto px-2 pb-3"
				aria-label={m.sidebar_lists_nav_label()}
			>
				<ul className="flex flex-col gap-0.5" data-nav-group="primary">
					{builtinViews.map(viewRow)}
				</ul>

				{(groups.length > 0 || canCreateList) && (
					<NavGroup
						title={m.sidebar_ungrouped_lists()}
						section="lists"
						hideTitle={collapsed}
					>
						<ul className="flex flex-col gap-0.5">
							{groups.map((group) =>
								group.folder ? (
									collapsed ? (
										group.lists.map(listRow)
									) : (
										<FolderRow
											key={group.folder.id}
											folder={group.folder}
											actions={folderActions(group.folder)}
										>
											<ul className="flex flex-col gap-0.5 ps-4">
												{group.lists.map(listRow)}
												{group.lists.length === 0 && (
													<li>
														<EmptyFolder
															canCreate={canCreateList}
															onCreate={() => {
																if (group.folder)
																	onNewListInFolder(group.folder.id);
															}}
														/>
													</li>
												)}
											</ul>
										</FolderRow>
									)
								) : (
									group.lists.map(listRow)
								),
							)}
							{canCreateList && (
								<li>
									<button
										type="button"
										data-testid="create-list-open"
										data-create-list-trigger
										aria-label={m.create_list_new_list()}
										title={collapsed ? m.create_list_new_list() : undefined}
										onClick={onNewList}
										className={cn(
											ROW,
											"w-full text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
											collapsed && "justify-center px-0",
										)}
									>
										<Plus aria-hidden className="size-4 shrink-0" />
										{!collapsed && m.create_list_new_list()}
									</button>
								</li>
							)}
						</ul>
					</NavGroup>
				)}

				{pinnedViews.length > 0 && (
					<NavGroup
						title={m.sidebar_views_heading()}
						section="views"
						open={isSectionOpen("views", pinnedViews.length > 0)}
						onToggle={
							collapsed
								? undefined
								: () => onToggleSection("views", pinnedViews.length > 0)
						}
						hideTitle={collapsed}
					>
						<ul className="flex flex-col gap-0.5">
							{pinnedViews.map(viewRow)}
						</ul>
					</NavGroup>
				)}

				{dashboards.length > 0 && (
					<NavGroup
						title={m.sidebar_dashboards_heading()}
						section="dashboards"
						open={isSectionOpen("dashboards", dashboards.length > 0)}
						onToggle={
							collapsed
								? undefined
								: () => onToggleSection("dashboards", dashboards.length > 0)
						}
						hideTitle={collapsed}
					>
						<ul className="flex flex-col gap-0.5">
							{dashboards.map((d) => (
								<NavRow
									key={d.id}
									name={d.name}
									icon={dashboardIcon(d)}
									kind="dashboard"
									active={dashboardActive(d.id)}
									onOpen={() => onOpenDashboard(d.id)}
									collapsed={collapsed}
									actions={dashboardActions(d)}
								/>
							))}
						</ul>
					</NavGroup>
				)}
			</nav>

			<div className="border-t p-2">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							data-testid="sidebar-create"
							variant="ghost"
							className={cn(
								"h-11 w-full justify-start",
								collapsed && "justify-center px-0",
							)}
							aria-label={m.sidebar_create()}
						>
							<Plus className="size-4" />
							{!collapsed && m.sidebar_create()}
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						side={collapsed ? "right" : "top"}
						align="start"
						onCloseAutoFocus={(event) => {
							if (focusNewList.current) {
								event.preventDefault();
								focusNewList.current = false;
								// Mount after the menu releases its focus trap.
								onNewList();
							}
						}}
					>
						<DropdownMenuItem
							data-testid="new-view"
							className="min-h-11"
							onSelect={onNewView}
						>
							<Plus className="size-4" />
							{m.action_new_view()}
						</DropdownMenuItem>
						<DropdownMenuItem
							data-testid="new-dashboard"
							className="min-h-11"
							onSelect={onNewDashboard}
						>
							<Plus className="size-4" />
							{m.action_new_dashboard()}
						</DropdownMenuItem>
						{canCreateList && (
							<DropdownMenuItem
								data-testid="sidebar-new-list"
								className="min-h-11"
								onSelect={() => {
									focusNewList.current = true;
								}}
							>
								<ListPlus className="size-4" />
								{m.create_list_new_list()}
							</DropdownMenuItem>
						)}
						{canCreateFolder && (
							<DropdownMenuItem
								data-testid="new-folder"
								className="min-h-11"
								onSelect={onNewFolder}
							>
								<FolderPlus className="size-4" />
								{m.action_new_folder()}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{shortcutHintKey && !collapsed && (
					<button
						type="button"
						data-testid="shortcut-hint"
						onClick={onOpenShortcuts}
						className="flex min-h-8 w-full items-center rounded-lg px-3 text-start text-xs text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
					>
						<span>
							<KeyText
								render={(key) => m.shortcut_hint({ key })}
								keyLabel={shortcutHintKey}
							/>
						</span>
					</button>
				)}
			</div>

			<div
				data-reading-sidebar-footer={collapsed ? "collapsed" : "expanded"}
				className={cn(
					"flex items-center gap-1 border-t p-2",
					collapsed && "flex-col",
				)}
			>
				<Button
					data-testid="nav-settings"
					variant={section === "settings" ? "secondary" : "ghost"}
					size="sm"
					className={cn(
						"justify-start",
						collapsed ? "w-full justify-center px-0" : "flex-1",
					)}
					onClick={onOpenSettings}
				>
					<Settings className="size-4" />
					{!collapsed && m.nav_settings()}
				</Button>
				<SyncIndicator placement="sidebar" />
				<ThemeMenu collapsed={collapsed} />
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

// An empty folder keeps a quiet next step under its row instead of vanishing
// into a heading with nothing below it.
export function EmptyFolder({
	canCreate,
	onCreate,
	className,
}: {
	canCreate: boolean;
	onCreate: () => void;
	className?: string;
}) {
	if (!canCreate)
		return (
			<span
				data-testid="folder-empty"
				className={cn(
					"block px-2 py-1 text-xs text-muted-foreground",
					className,
				)}
			>
				{m.sidebar_folder_empty()}
			</span>
		);
	return (
		<button
			type="button"
			data-testid="folder-empty"
			onClick={onCreate}
			className={cn(
				"flex w-full items-center gap-2 rounded-lg px-2 py-1 text-start text-xs text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-sidebar-accent/60 hover:text-foreground motion-reduce:transition-none",
				className,
			)}
		>
			<Plus aria-hidden className="size-3.5 shrink-0" />
			{m.action_new_list_here()}
		</button>
	);
}
