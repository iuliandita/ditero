import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	House,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff,
	Trash2,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { randomId } from "../../domain/random-id.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { Folder, List, schema } from "../../zero/schema.gen.ts";
import { DashboardView } from "../components/dashboard/DashboardView.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { FocusTimer } from "../components/focus/FocusTimer.tsx";
import { SortableList } from "../components/list/SortableList.tsx";
import { AppShell } from "../components/shell/AppShell.tsx";
import { BottomNav, type Section } from "../components/shell/BottomNav.tsx";
import { CreateList } from "../components/shell/CreateList.tsx";
import { Fab } from "../components/shell/Fab.tsx";
import { groupLists } from "../components/shell/grouping.ts";
import { ListProgress } from "../components/shell/ListProgress.tsx";
import { RestrictedShell } from "../components/shell/RestrictedShell.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";
import { BackButton } from "../components/ui/back-button.tsx";
import { Button } from "../components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { ViewRenderer } from "../components/views/ViewRenderer.tsx";
import { FocusProvider } from "../focus/useFocusTimer.tsx";
import { useDashboards } from "../hooks/useDashboards.ts";
import { useSyncedTheme } from "../hooks/useSyncedTheme.ts";
import { useUserPref } from "../hooks/useUserPref.ts";
import { useViews } from "../hooks/useViews.ts";
import { useWorkspaceDashboards } from "../hooks/useWorkspaceDashboards.ts";
import { useWorkspaceData } from "../hooks/useWorkspaceData.ts";
import { useWorkspaceRowActions } from "../hooks/useWorkspaceRowActions.ts";
import { useWorkspaceViews } from "../hooks/useWorkspaceViews.ts";
import {
	type CommandHandlers,
	CommandProvider,
} from "../keyboard/CommandContext.tsx";
import {
	actOnFocused,
	focusNext,
	focusPrev,
	openFocused,
} from "../keyboard/roving.ts";
import { canCreateFolder, canCreateList } from "../lib/create-gates.ts";
import { ICONS } from "../lib/list-icon.tsx";
import type { Locale } from "../lib/locale.ts";
import { runMutation } from "../lib/run-mutation.ts";
import { useIsDesktop } from "../lib/use-media-query.ts";
import { BUILTIN_VIEWS, DEFAULT_HOME } from "../views/builtins.ts";
import { dashboardHomeRef, resolveHomeRef } from "../views/home-ref.ts";
import { ListView } from "./ListView.tsx";
import { SettingsSurface } from "./SettingsSurface.tsx";
import { WorkspaceOverlays } from "./WorkspaceOverlays.tsx";
import { workspaceContentReducer } from "./workspace-content.ts";

// A restricted managed ("kid") account gets a wholly separate shell -- never the
// normal workspace UI. Branch here, before any normal-shell hook runs, keying off
// the kid's own managedAccounts row (userId === me && restricted). A normal user
// has no such row, so this is false on the first render regardless of sync state
// and their shell mounts unchanged.
export function Workspace() {
	const zero = useZero<typeof schema>();
	// Above the restricted/normal split so both shells get the synced theme.
	useSyncedTheme();
	const [managed] = useQuery(queries.managedAccounts.mine());
	const restricted = managed.some(
		(row) => row.userId === zero.userID && row.restricted,
	);
	if (restricted) return <RestrictedShell />;
	return <NormalWorkspace />;
}

function NormalWorkspace() {
	const isDesktop = useIsDesktop();
	const zero = useZero<typeof schema>();
	const persistLocale = useCallback(
		(locale: Locale) => {
			// Best-effort by design, not a swallowed error: changeLocale() already
			// applied the strategy chain + document locale before this runs, so a
			// failed write only means cross-device sync doesn't happen yet -- Zero
			// replays the queued mutation after reload/reconnect.
			void runMutation(
				zero.mutate(mutators.userPref.set({ locale })),
				(message) => console.error("userPref.set failed", message),
			);
		},
		[zero],
	);
	const {
		workspaces,
		lists,
		folders,
		templates,
		tasks,
		labels,
		taskLabels,
		assignees,
		memberships,
		viewRowsLoading,
		roleByWorkspace,
		shareable,
		members,
		membershipWorkspaceIds,
		labelIdsByTask,
	} = useWorkspaceData();
	const { views: savedViews } = useViews();
	const { dashboards, loading: dashboardsLoading } = useDashboards();
	const { pref, setPref, loading: prefLoading } = useUserPref();
	const [activeId, setActiveId] = useState<string | null>(null);
	const [contentState, dispatchContent] = useReducer(workspaceContentReducer, {
		kind: "home",
	});
	const openListId = contentState.kind === "list" ? contentState.id : null;
	const openDashboardId =
		contentState.kind === "dashboard" ? contentState.id : null;
	const section: Section =
		contentState.kind === "settings" ? "settings" : "lists";
	const [viewManager, setViewManager] = useState<
		{ mode: "create" } | { mode: "edit"; id: string } | null
	>(null);
	const [dashboardManager, setDashboardManager] = useState<
		{ mode: "create" } | { mode: "edit"; id: string } | null
	>(null);
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
	const [openSharedRequested, setOpenSharedRequested] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(false);
	const [quickAddOpen, setQuickAddOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [membersOpen, setMembersOpen] = useState(false);
	const [cheatOpen, setCheatOpen] = useState(false);
	// One-shot: a "dashboard:<id>" home ref lands on that dashboard after sync.
	const [homeApplied, setHomeApplied] = useState(false);
	// Rename target for the list row-action; null when the dialog is closed.
	const [renameTarget, setRenameTarget] = useState<List | null>(null);
	// Folder create/rename dialog target; null when closed.
	const [folderDialog, setFolderDialog] = useState<
		{ mode: "create" } | { mode: "rename"; folder: Folder } | null
	>(null);
	// "New list here": preselects the folder in the create-list form. The nonce
	// keys a remount, so picking the same folder twice re-seeds the select even
	// after the user changed it by hand.
	const [newListFolder, setNewListFolder] = useState<{
		id: string | null;
		nonce: number;
	} | null>(null);
	const openHome = useCallback(() => dispatchContent({ kind: "home" }), []);
	const closeList = useCallback(
		(id: string) => dispatchContent({ kind: "close", target: "list", id }),
		[],
	);
	const closeView = useCallback(
		(id: string) => dispatchContent({ kind: "close", target: "view", id }),
		[],
	);
	const closeDashboard = useCallback(
		(id: string) => dispatchContent({ kind: "close", target: "dashboard", id }),
		[],
	);

	// Sidebar "New list": the create-list form lives on the lists index, so land
	// there first (same move as the folder row's "New list here", minus the
	// preselected folder). The nonce remounts the form so it focuses even when
	// the index is already the open section.
	const startNewList = () => {
		openHome();
		setNewListFolder({ id: null, nonce: Date.now() });
	};

	// Default active workspace is the user's personal one, so new lists stay private.
	useEffect(() => {
		if (activeId) return;
		const personal = workspaces.find((w) => w.kind === "personal");
		if (personal) setActiveId(personal.id);
		else if (workspaces.length) setActiveId(workspaces[0].id);
	}, [workspaces, activeId]);

	const activeLists = useMemo(
		() => lists.filter((l) => l.workspaceId === activeId),
		[lists, activeId],
	);
	const activeFolders = useMemo(
		() => folders.filter((f) => f.workspaceId === activeId),
		[folders, activeId],
	);
	const activeTemplates = useMemo(
		() => templates.filter((t) => t.workspaceId === activeId),
		[templates, activeId],
	);
	const groups = useMemo(
		() => groupLists(activeFolders, activeLists),
		[activeFolders, activeLists],
	);
	// Aggregate completion per project list for the index progress bars.
	const progressByList = useMemo(() => {
		const map = new Map<string, { done: number; total: number }>();
		for (const l of activeLists) {
			if (l.kind === "project") map.set(l.id, { done: 0, total: 0 });
		}
		for (const t of tasks) {
			const entry = map.get(t.listId);
			if (!entry) continue;
			entry.total++;
			if (t.done) entry.done++;
		}
		return map;
	}, [tasks, activeLists]);

	// --- List row actions -----------------------------------------------------
	const activeRole = activeId ? (roleByWorkspace.get(activeId) ?? null) : null;

	function submitRename(next: string) {
		const target = renameTarget;
		setRenameTarget(null);
		if (!target || next === target.title) return;
		void zero
			.mutate(mutators.list.update({ id: target.id, title: next }))
			.client.catch((e) => console.error("list.update failed", e));
	}

	// --- Folder row actions ---------------------------------------------------
	function createFolder(name: string) {
		if (!activeId) return;
		const lastKey = activeFolders.reduce<string | null>(
			(max, f) => (max == null || f.sortKey > max ? f.sortKey : max),
			null,
		);
		void zero
			.mutate(
				mutators.folder.create({
					id: randomId(),
					workspaceId: activeId,
					name,
					sortKey: keyBetween(lastKey, null),
				}),
			)
			.client.catch((e) => console.error("folder.create failed", e));
	}

	function renameFolder(folder: Folder, name: string) {
		if (name === folder.name) return;
		void zero
			.mutate(mutators.folder.update({ id: folder.id, name }))
			.client.catch((e) => console.error("folder.update failed", e));
	}

	function submitFolderDialog(name: string) {
		const target = folderDialog;
		setFolderDialog(null);
		if (!target) return;
		if (target.mode === "create") createFolder(name);
		else renameFolder(target.folder, name);
	}

	useEffect(() => {
		if (!openSharedRequested) return;
		const shared = workspaces.find((w) => w.kind === "shared");
		if (!shared) return;
		if (activeId !== shared.id) {
			setActiveId(shared.id);
			openHome();
		}
		const firstList = lists.find((l) => l.workspaceId === shared.id);
		if (!firstList) return;
		dispatchContent({ kind: "list", id: firstList.id });
		setOpenSharedRequested(false);
	}, [openSharedRequested, workspaces, lists, activeId, openHome]);

	function selectWorkspace(id: string) {
		setActiveId(id);
		openHome();
		setSwitcherOpen(false);
	}
	const openList = useCallback((id: string) => {
		setDetailTaskId(null);
		dispatchContent({ kind: "list", id });
	}, []);
	const openView = useCallback((id: string) => {
		setDetailTaskId(null);
		dispatchContent({ kind: "view", id });
	}, []);
	const openDashboard = useCallback((id: string) => {
		setDetailTaskId(null);
		dispatchContent({ kind: "dashboard", id });
	}, []);
	const openSettings = useCallback(() => {
		setDetailTaskId(null);
		dispatchContent({ kind: "settings" });
	}, []);
	// Flat drag-reorder within a folder group / ungrouped bucket writes only the
	// dragged list's sortKey (design 2.8). Cross-folder + folder ordering are out
	// of M1a scope: each group is its own DndContext, so a list can't leave it.
	function moveList(id: string, sortKey: string) {
		zero
			.mutate(mutators.list.update({ id, sortKey }))
			.client.catch((e) => console.error("list reorder failed", e));
	}
	function changeSection(next: Section) {
		dispatchContent({ kind: next === "settings" ? "settings" : "home" });
	}

	const openListRow = openListId
		? (activeLists.find((l) => l.id === openListId) ?? null)
		: null;

	// --- Views wiring ---------------------------------------------------------
	// Home ref resolution: builtin/saved view, "dashboard:<id>", or (dangling/
	// garbage) DEFAULT_HOME — pure helper, unit-tested.
	const homeTarget = useMemo(
		() =>
			resolveHomeRef(pref.homeViewRef, {
				savedViewIds: savedViews.map((v) => v.id),
				dashboardIds: dashboards.map((d) => d.id),
			}),
		[pref.homeViewRef, savedViews, dashboards],
	);
	// The view surface's home: a dashboard home falls back to DEFAULT_HOME here
	// (used pre-sync and after backing out of the home dashboard).
	const homeRef = homeTarget.kind === "view" ? homeTarget.id : DEFAULT_HOME;

	// Land on the home dashboard once both prefs and dashboards have synced (a
	// dangling ref already resolved to a view above). One-shot and gated on the
	// exclusive modes + section so it never hijacks navigation (e.g. Settings
	// opened before sync) or re-opens after Back.
	useEffect(() => {
		if (homeApplied || prefLoading || dashboardsLoading) return;
		setHomeApplied(true);
		if (homeTarget.kind !== "dashboard") return;
		if (contentState.kind !== "home") return;
		setDetailTaskId(null);
		dispatchContent({ kind: "dashboard", id: homeTarget.id });
	}, [homeApplied, prefLoading, dashboardsLoading, homeTarget, contentState]);
	const {
		pinnedViews,
		resolveView,
		isPinned,
		togglePin,
		setHome,
		deleteView,
		submitView,
	} = useWorkspaceViews({
		savedViews,
		pref,
		setPref,
		viewManager,
		setViewManager,
		onCloseView: closeView,
		openView,
	});

	// --- Dashboards wiring ------------------------------------------------------
	const openDashboardRow = openDashboardId
		? (dashboards.find((d) => d.id === openDashboardId) ?? null)
		: null;

	// Self-heal: if the open dashboard vanishes from the synced set (deleted by a
	// co-member, or opened from a stale cache right after a delete), fall back to
	// the home view instead of stranding the surface on "Dashboard not found".
	// Only after the row was seen once for this id — a fresh create's optimistic
	// row can land a render after openDashboard(id) and must not be kicked out.
	const seenDashboardId = useRef<string | null>(null);
	useEffect(() => {
		if (openDashboardRow) {
			seenDashboardId.current = openDashboardRow.id;
			return;
		}
		if (dashboardsLoading || !openDashboardId) return;
		if (seenDashboardId.current !== openDashboardId) return;
		closeDashboard(openDashboardId);
	}, [openDashboardRow, dashboardsLoading, openDashboardId, closeDashboard]);

	const {
		canEditDashboard,
		updateDashboardPanels,
		deleteDashboard,
		submitDashboard,
	} = useWorkspaceDashboards({
		dashboards,
		openDashboardRow,
		memberships,
		pref,
		setPref,
		dashboardManager,
		setDashboardManager,
		onCloseDashboard: closeDashboard,
		openDashboard,
	});

	// Stable prop objects for DashboardView's panel evaluation (same synced sets
	// the ViewRenderer surface consumes).
	const panelData = useMemo(
		() => ({ tasks, lists, labels, taskLabels, assignees }),
		[tasks, lists, labels, taskLabels, assignees],
	);
	const panelIds = useMemo(
		() => ({ currentUserId: zero.userID ?? "", membershipWorkspaceIds }),
		[zero.userID, membershipWorkspaceIds],
	);

	const {
		buildListActions,
		buildFolderActions,
		buildViewActions,
		buildDashboardActions,
	} = useWorkspaceRowActions({
		tasks,
		activeLists,
		activeFolders,
		roleByWorkspace,
		savedViews,
		onOpenHome: openHome,
		onCloseList: closeList,
		setNewListFolder,
		setRenameTarget,
		setFolderDialog,
		setViewManager,
		setDashboardManager,
		setHome,
		onDeleteView: (view) => void deleteView(view),
		onDeleteDashboard: (dashboard) => void deleteDashboard(dashboard),
	});

	const detailTask = detailTaskId
		? (tasks.find((t) => t.id === detailTaskId) ?? null)
		: null;
	const detailList = detailTask
		? (lists.find((l) => l.id === detailTask.listId) ?? null)
		: null;

	// The view shown when no list, dashboard or settings surface is open: an
	// explicitly opened one, else home.
	const activeViewId =
		contentState.kind === "home"
			? homeRef
			: contentState.kind === "view"
				? contentState.id
				: null;

	// Command handlers injected into the palette/keyboard system. palette.open and
	// search.open are owned by the provider (it holds the open state). Movement +
	// toggle drive roving DOM focus over the [data-kbd-nav] task rows TaskRow marks.
	// Nav handlers route through the canonical open* helpers (useCallback,
	// stable); the provider keeps the map in a ref, so identity churn from
	// firstDashboardId changes is harmless.
	const firstDashboardId = dashboards[0]?.id ?? null;
	const commandHandlers = useMemo<CommandHandlers>(
		() => ({
			"task.create": () => setQuickAddOpen(true),
			"settings.open": () => openSettings(),
			"nav.down": () => focusNext(),
			"nav.up": () => focusPrev(),
			"nav.open": () => openFocused(),
			"task.toggleDone": () => actOnFocused("toggle"),
			"task.delete": () => actOnFocused("delete"),
			"row.menu": () => actOnFocused("menu"),
			"help.cheatSheet": () => setCheatOpen(true),
			"nav.today": () => openView("today"),
			"view.new": () => setViewManager({ mode: "create" }),
			// First dashboard in sidebar (sortKey) order; silent no-op when none
			// exist (matches the movement handlers' posture — no toast idiom).
			"nav.dashboard": () => {
				if (firstDashboardId) openDashboard(firstDashboardId);
			},
			"dashboard.new": () => setDashboardManager({ mode: "create" }),
		}),
		[firstDashboardId, openView, openDashboard, openSettings],
	);

	const activeView = activeViewId ? resolveView(activeViewId) : null;
	// Object.hasOwn guards the client-controlled icon key: a prototype key
	// ("constructor"/"__proto__") must not resolve to a non-component and throw.
	const HeaderIcon =
		activeView?.icon && Object.hasOwn(ICONS, activeView.icon)
			? ICONS[activeView.icon]
			: null;

	let content: React.ReactNode;
	if (contentState.kind === "settings") {
		content = (
			<SettingsSurface
				activeId={activeId}
				activeRole={activeRole}
				isDesktop={isDesktop}
				persistLocale={persistLocale}
				onBack={() => changeSection("lists")}
				onOpenList={openList}
			/>
		);
	} else if (openListId) {
		content = (
			<div>
				<div className="flex items-center gap-2 border-b p-3 md:hidden">
					<BackButton
						aria-label={m.list_back_to_lists()}
						onClick={() => closeList(openListId)}
					/>
					<span className="truncate font-medium">
						{openListRow?.title ?? m.list_untitled_fallback()}
					</span>
				</div>
				<div className="p-4 md:p-6">
					<ListView listId={openListId} listActions={buildListActions} />
				</div>
			</div>
		);
	} else if (openDashboardId) {
		content = (
			<div className="flex flex-col gap-6 p-4 md:p-6">
				{openDashboardRow ? (
					// Keyed so edit mode never carries over between dashboards. The
					// boundary keeps a panel-body throw (e.g. a bad rrule) inline
					// instead of white-screening; resetKey clears it on switch.
					<ErrorBoundary
						key={openDashboardRow.id}
						resetKey={openDashboardRow.id}
						onReset={() => closeDashboard(openDashboardRow.id)}
					>
						<DashboardView
							dashboard={openDashboardRow}
							canEdit={canEditDashboard}
							onUpdate={(panels) =>
								updateDashboardPanels(openDashboardRow.id, panels)
							}
							onEditDashboard={() =>
								setDashboardManager({ mode: "edit", id: openDashboardRow.id })
							}
							onDeleteDashboard={() => void deleteDashboard(openDashboardRow)}
							onSetHome={() => setHome(dashboardHomeRef(openDashboardRow.id))}
							isHome={
								pref.homeViewRef === dashboardHomeRef(openDashboardRow.id)
							}
							onBack={() => closeDashboard(openDashboardRow.id)}
							data={panelData}
							ids={panelIds}
							views={savedViews}
							folders={folders}
							members={members}
							workspaces={workspaces}
							onOpenTask={(t) => setDetailTaskId(t.id)}
							onOpenView={openView}
						/>
					</ErrorBoundary>
				) : (
					<p className="text-sm text-muted-foreground">
						{m.dashboard_not_found()}
					</p>
				)}
			</div>
		);
	} else {
		// No list open: the view surface (an explicitly opened view, or the home
		// view on the landing). On the landing the workspace heading, create-list
		// form and (mobile) navigation index stay rendered below.
		const isLanding = contentState.kind === "home";
		content = (
			<div className="flex flex-col gap-6 p-4 md:p-6">
				{activeView ? (
					<section aria-label={activeView.name} data-testid="view-surface">
						<div className="mb-3 flex items-center gap-2">
							{!isDesktop && !isLanding && (
								<BackButton
									size="compact"
									onClick={() => closeView(activeView.id)}
								/>
							)}
							{HeaderIcon && (
								<HeaderIcon
									aria-hidden
									className="size-5 shrink-0 text-muted-foreground"
								/>
							)}
							<h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
								{activeView.name}
							</h1>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={m.view_actions()}
										data-testid="view-actions"
									>
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuCheckboxItem
										data-testid="view-set-home"
										checked={
											homeTarget.kind === "view" &&
											activeView.id === homeTarget.id
										}
										onSelect={() => setHome(activeView.id)}
									>
										<House /> {m.view_set_home()}
									</DropdownMenuCheckboxItem>
									{activeView.saved && (
										<>
											<DropdownMenuItem
												data-testid="view-pin"
												onSelect={() => togglePin(activeView.id)}
											>
												{isPinned(activeView.id) ? (
													<>
														<PinOff /> {m.view_unpin()}
													</>
												) : (
													<>
														<Pin /> {m.view_pin()}
													</>
												)}
											</DropdownMenuItem>
											<DropdownMenuItem
												data-testid="view-edit"
												onSelect={() =>
													setViewManager({ mode: "edit", id: activeView.id })
												}
											>
												<Pencil /> {m.view_menu_edit()}
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												data-testid="view-delete"
												className="text-destructive"
												onSelect={() => {
													if (activeView.saved)
														void deleteView(activeView.saved);
												}}
											>
												<Trash2 /> {m.view_menu_delete()}
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						{/* A malformed synced view (a co-member's bad filter/display) can
						    throw in the renderer; the boundary keeps it inline instead of
						    white-screening. resetKey clears the error on view switch. */}
						<ErrorBoundary
							resetKey={activeView.id}
							onReset={() => closeView(activeView.id)}
						>
							<ViewRenderer
								filter={activeView.filter}
								display={activeView.display}
								tasks={tasks}
								lists={lists}
								folders={folders}
								labels={labels}
								taskLabels={taskLabels}
								assignees={assignees}
								members={members}
								currentUserId={zero.userID ?? ""}
								membershipWorkspaceIds={membershipWorkspaceIds}
								loading={viewRowsLoading}
								onOpenTask={(t) => setDetailTaskId(t.id)}
							/>
						</ErrorBoundary>
					</section>
				) : (
					<p className="text-sm text-muted-foreground">{m.view_not_found()}</p>
				)}

				{isLanding && (
					<div className="flex flex-col gap-4">
						{/* Mobile has no sidebar; surface built-ins + pinned views here so
						    they are reachable and open the renderer on mobile too. */}
						{!isDesktop && (
							<nav
								aria-label={m.views_nav_label()}
								className="flex flex-col gap-0.5"
							>
								<div className="px-1 py-1 text-xs font-medium text-muted-foreground">
									{m.sidebar_views_heading()}
								</div>
								{[...BUILTIN_VIEWS, ...pinnedViews].map((v) => (
									<button
										key={v.id}
										type="button"
										aria-current={activeViewId === v.id ? "page" : undefined}
										onClick={() => openView(v.id)}
										className="rounded-lg px-2 py-2 text-start text-sm hover:bg-muted"
									>
										{v.name}
									</button>
								))}
								<button
									type="button"
									data-testid="new-view"
									onClick={() => setViewManager({ mode: "create" })}
									className="rounded-lg px-2 py-2 text-start text-sm text-muted-foreground hover:bg-muted"
								>
									+ {m.action_new_view()}
								</button>
							</nav>
						)}
						{/* Dashboards mirror the Views block so they are reachable on
						    mobile too (desktop nav lives in the sidebar). */}
						{!isDesktop && (
							<nav
								aria-label={m.dashboards_nav_label()}
								className="flex flex-col gap-0.5"
							>
								<div className="px-1 py-1 text-xs font-medium text-muted-foreground">
									{m.sidebar_dashboards_heading()}
								</div>
								{dashboards.map((d) => (
									<button
										key={d.id}
										type="button"
										onClick={() => openDashboard(d.id)}
										className="rounded-lg px-2 py-2 text-start text-sm hover:bg-muted"
									>
										{d.name}
									</button>
								))}
								<button
									type="button"
									data-testid="new-dashboard"
									onClick={() => setDashboardManager({ mode: "create" })}
									className="rounded-lg px-2 py-2 text-start text-sm text-muted-foreground hover:bg-muted"
								>
									+ {m.action_new_dashboard()}
								</button>
							</nav>
						)}
						<div className="flex items-center justify-between">
							{isDesktop ? (
								<h2 className="text-base font-semibold">
									{workspaces.find((w) => w.id === activeId)?.name ??
										m.workspace_name_fallback()}
								</h2>
							) : (
								// Mobile: the workspace name doubles as the switcher trigger.
								<button
									type="button"
									aria-haspopup="dialog"
									onClick={() => setSwitcherOpen(true)}
									className="text-base font-semibold"
								>
									{workspaces.find((w) => w.id === activeId)?.name ??
										m.workspace_name_fallback()}
								</button>
							)}
						</div>
						<CreateList
							key={newListFolder?.nonce ?? "default"}
							autoFocus={newListFolder !== null}
							initialFolderId={newListFolder?.id ?? null}
							workspaceId={activeId ?? ""}
							lists={activeLists}
							folders={activeFolders}
							templates={activeTemplates}
						/>
						{/* Desktop nav lives in the sidebar; render the list index only on
						    mobile so a list title never appears twice at once. */}
						{!isDesktop && (
							<div data-testid="list-index" className="flex flex-col gap-4">
								{groups.map((group) => (
									<div key={group.folder?.id ?? "__ungrouped__"}>
										<div className="mb-1 px-1 text-xs font-medium text-muted-foreground">
											{group.folder?.name ?? m.sidebar_ungrouped_lists()}
										</div>
										<SortableList
											items={group.lists}
											onMove={moveList}
											handleLabel={m.list_reorder_handle()}
											handleTestId="list-drag"
											className="gap-1"
											renderItem={(l) => (
												<button
													type="button"
													onClick={() => openList(l.id)}
													className="w-full rounded-lg border p-3 text-start"
												>
													{l.title}
													{l.kind === "project" && progressByList.has(l.id) && (
														<ListProgress
															done={progressByList.get(l.id)?.done ?? 0}
															total={progressByList.get(l.id)?.total ?? 0}
														/>
													)}
												</button>
											)}
										/>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<FocusProvider>
			<CommandProvider handlers={commandHandlers}>
				<AppShell
					sidebar={
						// Render (not CSS-hide) per viewport so a list title never exists
						// twice in the DOM — the mobile index renders the same titles.
						isDesktop ? (
							<Sidebar
								workspaces={workspaces}
								activeId={activeId}
								onSelectWorkspace={selectWorkspace}
								onOpenShared={() => setOpenSharedRequested(true)}
								onOpenMembers={() => setMembersOpen(true)}
								groups={groups}
								progressByList={progressByList}
								openListId={openListId}
								onOpenList={openList}
								listActions={buildListActions}
								folderActions={buildFolderActions}
								onNewList={startNewList}
								canCreateList={canCreateList(activeRole)}
								onNewFolder={() => setFolderDialog({ mode: "create" })}
								canCreateFolder={canCreateFolder(activeRole)}
								builtinViews={BUILTIN_VIEWS}
								pinnedViews={pinnedViews}
								activeViewId={activeViewId}
								onOpenView={openView}
								onNewView={() => setViewManager({ mode: "create" })}
								viewActions={buildViewActions}
								dashboards={dashboards}
								activeDashboardId={openDashboardId}
								onOpenDashboard={openDashboard}
								onNewDashboard={() => setDashboardManager({ mode: "create" })}
								dashboardActions={buildDashboardActions}
								section={section}
								onOpenSettings={openSettings}
								collapsed={collapsed}
								onToggleCollapsed={() => setCollapsed((c) => !c)}
							/>
						) : null
					}
					bottomNav={
						<BottomNav
							section={section}
							onSection={changeSection}
							onSearch={() => setSearchOpen(true)}
						/>
					}
					fab={<Fab onOpen={() => setQuickAddOpen(true)} />}
				>
					{content}
				</AppShell>

				<WorkspaceOverlays
					isDesktop={isDesktop}
					activeId={activeId}
					openListId={openListId}
					workspaces={workspaces}
					lists={lists}
					activeLists={activeLists}
					folders={folders}
					labels={labels}
					tasks={tasks}
					savedViews={savedViews}
					dashboards={dashboards}
					shareable={shareable}
					members={members}
					labelIdsByTask={labelIdsByTask}
					switcherOpen={switcherOpen}
					onSwitcherOpenChange={setSwitcherOpen}
					onSelectWorkspace={selectWorkspace}
					onOpenShared={() => setOpenSharedRequested(true)}
					membersOpen={membersOpen}
					onMembersOpenChange={setMembersOpen}
					quickAddOpen={quickAddOpen}
					onQuickAddOpenChange={setQuickAddOpen}
					viewManager={viewManager}
					onViewManagerClose={() => setViewManager(null)}
					onSubmitView={submitView}
					dashboardManager={dashboardManager}
					onDashboardManagerClose={() => setDashboardManager(null)}
					onSubmitDashboard={submitDashboard}
					renameTarget={renameTarget}
					onRenameClose={() => setRenameTarget(null)}
					onSubmitRename={submitRename}
					folderDialog={folderDialog}
					onFolderDialogClose={() => setFolderDialog(null)}
					onSubmitFolderDialog={submitFolderDialog}
					detailTask={detailTask}
					detailList={detailList}
					onDetailClose={() => setDetailTaskId(null)}
					searchOpen={searchOpen}
					onSearchSelect={(taskId, listId) => {
						setSearchOpen(false);
						openList(listId);
						setDetailTaskId(taskId);
					}}
					onSearchClose={() => setSearchOpen(false)}
					cheatOpen={cheatOpen}
					onCheatOpenChange={setCheatOpen}
					onOpenList={openList}
					onOpenView={openView}
					onOpenDashboard={openDashboard}
				/>
				<FocusTimer />
			</CommandProvider>
		</FocusProvider>
	);
}
