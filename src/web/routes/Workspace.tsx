import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	ChevronLeft,
	House,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Panel } from "../../domain/dashboard.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import type { FilterGroup, ViewDisplay } from "../../domain/view-filter.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import {
	type DashboardFormValue,
	DashboardManager,
} from "../components/dashboard/DashboardManager.tsx";
import { DashboardView } from "../components/dashboard/DashboardView.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { FocusTimer } from "../components/focus/FocusTimer.tsx";
import { KarmaPanel } from "../components/karma/KarmaPanel.tsx";
import { SortableList } from "../components/list/SortableList.tsx";
import { TaskDetail } from "../components/list/TaskDetail.tsx";
import { MembersPanel } from "../components/people/MembersPanel.tsx";
import { QuickAddSheet } from "../components/quickadd/QuickAddSheet.tsx";
import { FocusSettings } from "../components/settings/FocusSettings.tsx";
import { KarmaSettings } from "../components/settings/KarmaSettings.tsx";
import { KeymapSettings } from "../components/settings/KeymapSettings.tsx";
import { LanguageSwitcher } from "../components/settings/LanguageSwitcher.tsx";
import { NotificationSettings } from "../components/settings/NotificationSettings.tsx";
import { AppShell } from "../components/shell/AppShell.tsx";
import { BottomNav, type Section } from "../components/shell/BottomNav.tsx";
import { CreateList } from "../components/shell/CreateList.tsx";
import { Fab } from "../components/shell/Fab.tsx";
import { groupLists } from "../components/shell/grouping.ts";
import { ListProgress } from "../components/shell/ListProgress.tsx";
import { RestrictedShell } from "../components/shell/RestrictedShell.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";
import { Button } from "../components/ui/button.tsx";
import { useConfirm } from "../components/ui/confirm.tsx";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "../components/ui/sheet.tsx";
import {
	type ViewFormValue,
	ViewManager,
} from "../components/views/ViewManager.tsx";
import { ViewRenderer } from "../components/views/ViewRenderer.tsx";
import { FocusProvider } from "../focus/useFocusTimer.tsx";
import { useDashboards } from "../hooks/useDashboards.ts";
import { useUserPref } from "../hooks/useUserPref.ts";
import type { SavedView } from "../hooks/useViews.ts";
import { useViews } from "../hooks/useViews.ts";
import { CheatSheet } from "../keyboard/CheatSheet.tsx";
import {
	type CommandHandlers,
	CommandProvider,
	useCommands,
} from "../keyboard/CommandContext.tsx";
import { CommandPalette } from "../keyboard/CommandPalette.tsx";
import {
	actOnFocused,
	focusNext,
	focusPrev,
	openFocused,
} from "../keyboard/roving.ts";
import { useEffectiveKeymap } from "../keyboard/useEffectiveKeymap.ts";
import { useKeyBindings } from "../keyboard/useKeyBindings.ts";
import { ICONS } from "../lib/list-icon.tsx";
import type { Locale } from "../lib/locale.ts";
import { runMutation } from "../lib/run-mutation.ts";
import { useIsDesktop } from "../lib/use-media-query.ts";
import {
	BUILTIN_VIEWS,
	type BuiltinViewId,
	DEFAULT_HOME,
	getBuiltin,
} from "../views/builtins.ts";
import { dashboardHomeRef, resolveHomeRef } from "../views/home-ref.ts";
import { ListView } from "./ListView.tsx";
import { SecurityPanel } from "./SecurityPanel.tsx";

// Resolved view descriptor: a built-in aggregate or a saved row, unified for the
// renderer/header. `saved` is set only for editable saved views.
type ResolvedView = {
	id: string;
	name: string;
	icon: string | null;
	filter: FilterGroup;
	display: ViewDisplay;
	saved: SavedView | null;
};

// A restricted managed ("kid") account gets a wholly separate shell -- never the
// normal workspace UI. Branch here, before any normal-shell hook runs, keying off
// the kid's own managedAccounts row (userId === me && restricted). A normal user
// has no such row, so this is false on the first render regardless of sync state
// and their shell mounts unchanged.
export function Workspace() {
	const zero = useZero<typeof schema>();
	const [managed] = useQuery(queries.managedAccounts.mine());
	const restricted = managed.some(
		(row) => row.userId === zero.userID && row.restricted,
	);
	if (restricted) return <RestrictedShell />;
	return <NormalWorkspace />;
}

// Installs the global key handler inside CommandProvider scope so `run` and the
// effective keymap resolve against live provider/pref state. Renders nothing;
// mounted desktop-only (design 2.18).
function WorkspaceKeyboard() {
	const { run } = useCommands();
	const keymap = useEffectiveKeymap();
	useKeyBindings(keymap, run);
	return null;
}

function NormalWorkspace() {
	const isDesktop = useIsDesktop();
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
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
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [folders] = useQuery(queries.folders.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const [labels] = useQuery(queries.labels.mine());
	const [taskLabels] = useQuery(queries.taskLabels.mine());
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const { views: savedViews } = useViews();
	const { dashboards, loading: dashboardsLoading } = useDashboards();
	const { pref, setPref, loading: prefLoading } = useUserPref();
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openListId, setOpenListId] = useState<string | null>(null);
	// null on the landing (home view); a built-in id or saved view.id otherwise.
	const [openViewId, setOpenViewId] = useState<string | null>(null);
	const [viewManager, setViewManager] = useState<
		{ mode: "create" } | { mode: "edit"; id: string } | null
	>(null);
	// A third content mode besides list/view; exclusive with both.
	const [openDashboardId, setOpenDashboardId] = useState<string | null>(null);
	const [dashboardManager, setDashboardManager] = useState<
		{ mode: "create" } | { mode: "edit"; id: string } | null
	>(null);
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
	const [openSharedRequested, setOpenSharedRequested] = useState(false);
	const [section, setSection] = useState<Section>("lists");
	const [collapsed, setCollapsed] = useState(false);
	const [quickAddOpen, setQuickAddOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [membersOpen, setMembersOpen] = useState(false);
	const [cheatOpen, setCheatOpen] = useState(false);
	// One-shot: a "dashboard:<id>" home ref lands on that dashboard after sync.
	const [homeApplied, setHomeApplied] = useState(false);

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

	useEffect(() => {
		if (!openSharedRequested) return;
		const shared = workspaces.find((w) => w.kind === "shared");
		if (!shared) return;
		if (activeId !== shared.id) {
			setActiveId(shared.id);
			setOpenListId(null);
		}
		const firstList = lists.find((l) => l.workspaceId === shared.id);
		if (!firstList) return;
		setSection("lists");
		setOpenDashboardId(null);
		setOpenListId(firstList.id);
		setOpenSharedRequested(false);
	}, [openSharedRequested, workspaces, lists, activeId]);

	function selectWorkspace(id: string) {
		setActiveId(id);
		setOpenListId(null);
		setOpenViewId(null);
		setOpenDashboardId(null);
		setSwitcherOpen(false);
	}
	function openList(id: string) {
		setSection("lists");
		setOpenViewId(null);
		setOpenDashboardId(null);
		setDetailTaskId(null);
		setOpenListId(id);
	}
	// Alternate content mode to a list: a view (built-in or saved) clears the open
	// list and vice-versa (they never render together). useCallback (setters only)
	// so the command-handler memo can depend on these.
	const openView = useCallback((id: string) => {
		setSection("lists");
		setOpenListId(null);
		setOpenDashboardId(null);
		setDetailTaskId(null);
		setOpenViewId(id);
	}, []);
	// Third exclusive content mode: a dashboard clears list/view and vice-versa.
	const openDashboard = useCallback((id: string) => {
		setSection("lists");
		setOpenListId(null);
		setOpenViewId(null);
		setDetailTaskId(null);
		setOpenDashboardId(id);
	}, []);
	function openSettings() {
		setOpenListId(null);
		setOpenViewId(null);
		setOpenDashboardId(null);
		setSection("settings");
	}
	// Flat drag-reorder within a folder group / ungrouped bucket writes only the
	// dragged list's sortKey (design 2.8). Cross-folder + folder ordering are out
	// of M1a scope: each group is its own DndContext, so a list can't leave it.
	function moveList(id: string, sortKey: string) {
		zero
			.mutate(mutators.list.update({ id, sortKey }))
			.client.catch((e) => console.error("list reorder failed", e));
	}
	function changeSection(next: Section) {
		setSection(next);
		if (next === "lists") {
			setOpenListId(null);
			setOpenViewId(null);
			setOpenDashboardId(null);
		}
	}

	const openListRow = openListId
		? (activeLists.find((l) => l.id === openListId) ?? null)
		: null;

	// --- Views wiring ---------------------------------------------------------
	// Members for the renderer/filter-builder pickers: one entry per co-member.
	const members = useMemo(() => {
		const seen = new Set<string>();
		const out: { id: string; name: string }[] = [];
		for (const row of memberships) {
			if (row.user && !seen.has(row.userId)) {
				seen.add(row.userId);
				out.push({ id: row.userId, name: row.user.name });
			}
		}
		return out;
	}, [memberships]);
	// The renderer scopes to workspaces the user actually belongs to.
	const membershipWorkspaceIds = useMemo(
		() => workspaces.map((w) => w.id),
		[workspaces],
	);
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
		if (openListId || openViewId || openDashboardId) return;
		if (section !== "lists") return;
		setDetailTaskId(null);
		setOpenDashboardId(homeTarget.id);
	}, [
		homeApplied,
		prefLoading,
		dashboardsLoading,
		homeTarget,
		openListId,
		openViewId,
		openDashboardId,
		section,
	]);
	const pinnedViews = useMemo(() => {
		const set = new Set(pref.pinnedViews);
		return savedViews
			.filter((v) => set.has(v.id))
			.sort((a, b) =>
				a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
			);
	}, [savedViews, pref.pinnedViews]);

	function resolveView(id: string): ResolvedView | null {
		const b = getBuiltin(id as BuiltinViewId);
		if (b)
			return {
				id,
				name: b.name,
				icon: b.icon,
				filter: b.filter,
				display: b.display,
				saved: null,
			};
		const s = savedViews.find((v) => v.id === id);
		if (s)
			return {
				id,
				name: s.name,
				icon: s.icon ?? null,
				filter: s.filter,
				display: s.display,
				saved: s,
			};
		return null;
	}

	const isPinned = (id: string) => pref.pinnedViews.includes(id);
	function togglePin(id: string) {
		setPref({
			pinnedViews: isPinned(id)
				? pref.pinnedViews.filter((v) => v !== id)
				: [...pref.pinnedViews, id],
		});
	}
	function setHome(id: string) {
		setPref({ homeViewRef: id });
	}
	function deleteView(id: string) {
		void zero
			.mutate(mutators.view.delete({ id }))
			.client.catch((e) => console.error("view.delete failed", e));
		// Drop it from pins, and fall the home ref back to the default if it pointed
		// here (both are one pref write when both apply).
		const patch: Parameters<typeof setPref>[0] = {};
		if (isPinned(id))
			patch.pinnedViews = pref.pinnedViews.filter((v) => v !== id);
		if (pref.homeViewRef === id) patch.homeViewRef = null;
		if (Object.keys(patch).length) setPref(patch);
		setOpenViewId(null);
	}

	function submitView(value: ViewFormValue) {
		if (viewManager?.mode === "edit") {
			void zero
				.mutate(
					mutators.view.update({
						id: viewManager.id,
						name: value.name,
						icon: value.icon,
						filter: value.filter as ReadonlyJSONValue,
						display: value.display as ReadonlyJSONValue,
					}),
				)
				.client.catch((e) => console.error("view.update failed", e));
		} else {
			const id = crypto.randomUUID();
			const lastKey = pinnedViews.reduce<string | null>(
				(max, v) => (max == null || v.sortKey > max ? v.sortKey : max),
				null,
			);
			void zero
				.mutate(
					mutators.view.create({
						id,
						name: value.name,
						...(value.icon != null ? { icon: value.icon } : {}),
						scope: value.scope,
						workspaceId: value.workspaceId,
						filter: value.filter as ReadonlyJSONValue,
						display: value.display as ReadonlyJSONValue,
						sortKey: keyBetween(lastKey, null),
					}),
				)
				.client.catch((e) => console.error("view.create failed", e));
			// Pin so it appears in the sidebar, and land on it.
			setPref({ pinnedViews: [...pref.pinnedViews, id] });
			openView(id);
		}
		setViewManager(null);
	}

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
		setOpenDashboardId(null);
	}, [openDashboardRow, dashboardsLoading, openDashboardId]);

	// Mirrors requireDashboardEdit in the mutators: personal -> owner only,
	// workspace -> role in the write set. The server re-checks on write.
	const canEditDashboard = useMemo(() => {
		if (!openDashboardRow) return false;
		if (openDashboardRow.scope === "personal")
			return openDashboardRow.ownerId === zero.userID;
		return memberships.some(
			(row) =>
				row.userId === zero.userID &&
				row.workspaceId === openDashboardRow.workspaceId &&
				(row.role === "owner" || row.role === "admin" || row.role === "member"),
		);
	}, [openDashboardRow, memberships, zero.userID]);

	function updateDashboardPanels(id: string, panels: Panel[]) {
		void zero
			.mutate(
				mutators.dashboard.update({
					id,
					panels: panels as ReadonlyJSONValue,
				}),
			)
			.client.catch((e) => console.error("dashboard.update failed", e));
	}

	async function deleteDashboard(id: string) {
		const ok = await confirm({
			body: m.dashboard_delete_confirm(),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.dashboard.delete({ id }))
			.client.catch((e) => console.error("dashboard.delete failed", e));
		// Mirror deleteView: never leave the home ref dangling.
		if (pref.homeViewRef === dashboardHomeRef(id))
			setPref({ homeViewRef: null });
		setOpenDashboardId(null);
	}

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

	function submitDashboard(value: DashboardFormValue) {
		if (dashboardManager?.mode === "edit") {
			void zero
				.mutate(
					mutators.dashboard.update({
						id: dashboardManager.id,
						name: value.name,
						icon: value.icon,
					}),
				)
				.client.catch((e) => console.error("dashboard.update failed", e));
		} else {
			const id = crypto.randomUUID();
			const lastKey = dashboards.at(-1)?.sortKey ?? null;
			void zero
				.mutate(
					mutators.dashboard.create({
						id,
						name: value.name,
						...(value.icon != null ? { icon: value.icon } : {}),
						scope: value.scope,
						workspaceId: value.workspaceId,
						panels: [],
						sortKey: keyBetween(lastKey, null),
					}),
				)
				.client.catch((e) => console.error("dashboard.create failed", e));
			openDashboard(id);
		}
		setDashboardManager(null);
	}

	// Label ids per task -> TaskDetail (view onOpenTask reuses the list sheet).
	const labelIdsByTask = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const tl of taskLabels) {
			const bucket = map.get(tl.taskId);
			if (bucket) bucket.push(tl.labelId);
			else map.set(tl.taskId, [tl.labelId]);
		}
		return map;
	}, [taskLabels]);
	const detailTask = detailTaskId
		? (tasks.find((t) => t.id === detailTaskId) ?? null)
		: null;
	const detailList = detailTask
		? (lists.find((l) => l.id === detailTask.listId) ?? null)
		: null;

	// The view shown when no list or dashboard is open: an explicitly opened one,
	// else home.
	const activeViewId =
		openListId || openDashboardId ? null : (openViewId ?? homeRef);

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
			"settings.open": () => {
				setOpenListId(null);
				setOpenViewId(null);
				setOpenDashboardId(null);
				setSection("settings");
			},
			"nav.down": () => focusNext(),
			"nav.up": () => focusPrev(),
			"nav.open": () => openFocused(),
			"task.toggleDone": () => actOnFocused("toggle"),
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
		[firstDashboardId, openView, openDashboard],
	);

	const activeView = activeViewId ? resolveView(activeViewId) : null;
	// Object.hasOwn guards the client-controlled icon key: a prototype key
	// ("constructor"/"__proto__") must not resolve to a non-component and throw.
	const HeaderIcon =
		activeView?.icon && Object.hasOwn(ICONS, activeView.icon)
			? ICONS[activeView.icon]
			: null;

	let content: React.ReactNode;
	// Mobile keeps Settings on its own tab; desktop pins SecurityPanel to the
	// list-index landing so it is always reachable (the auth-hardening e2e drives
	// it right after signup without navigating).
	if (!isDesktop && section === "settings") {
		content = (
			<div className="p-4">
				<SecurityPanel />
				<KarmaPanel />
				<KarmaSettings />
				<LanguageSwitcher persistLocale={persistLocale} />
				<FocusSettings />
				<NotificationSettings />
			</div>
		);
	} else if (openListId) {
		content = (
			<div>
				<div className="flex items-center gap-2 border-b p-3 md:hidden">
					<button
						type="button"
						aria-label={m.list_back_to_lists()}
						onClick={() => setOpenListId(null)}
						className="flex size-11 items-center justify-center rounded-lg"
					>
						<ChevronLeft className="size-5" />
					</button>
					<span className="truncate font-medium">
						{openListRow?.title ?? m.list_untitled_fallback()}
					</span>
				</div>
				<div className="p-4 md:p-6">
					<ListView listId={openListId} />
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
						onReset={() => setOpenDashboardId(null)}
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
							onDeleteDashboard={() =>
								void deleteDashboard(openDashboardRow.id)
							}
							onSetHome={() => setHome(dashboardHomeRef(openDashboardRow.id))}
							isHome={
								pref.homeViewRef === dashboardHomeRef(openDashboardRow.id)
							}
							onBack={() => setOpenDashboardId(null)}
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
		// view on the landing). On the landing the list-index/create/settings
		// controls stay rendered below so those flows remain reachable.
		const isLanding = openViewId == null;
		content = (
			<div className="flex flex-col gap-6 p-4 md:p-6">
				{activeView ? (
					<section aria-label={activeView.name} data-testid="view-surface">
						<div className="mb-3 flex items-center gap-2">
							{!isDesktop && !isLanding && (
								<button
									type="button"
									aria-label={m.action_back()}
									onClick={() => setOpenViewId(null)}
									className="flex size-9 shrink-0 items-center justify-center rounded-lg"
								>
									<ChevronLeft className="size-5" />
								</button>
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
												onSelect={() => deleteView(activeView.id)}
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
							onReset={() => setOpenViewId(null)}
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
							workspaceId={activeId ?? ""}
							lists={activeLists}
							folders={activeFolders}
							templates={activeTemplates}
						/>
						{/* Desktop nav lives in the sidebar; render the list index only on
						    mobile so a list title never appears twice at once. */}
						{!isDesktop &&
							groups.map((group) => (
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
						{isDesktop && (
							<div className="border-t pt-2">
								<SecurityPanel />
								<KarmaPanel />
								<KarmaSettings />
								<LanguageSwitcher persistLocale={persistLocale} />
								{/* Keyboard is a desktop feature (design 2.18); the rebind
								    surface lives beside Security on the desktop landing. */}
								<KeymapSettings />
								<FocusSettings />
								<NotificationSettings />
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
								builtinViews={BUILTIN_VIEWS}
								pinnedViews={pinnedViews}
								activeViewId={activeViewId}
								onOpenView={openView}
								onNewView={() => setViewManager({ mode: "create" })}
								dashboards={dashboards}
								activeDashboardId={openDashboardId}
								onOpenDashboard={openDashboard}
								onNewDashboard={() => setDashboardManager({ mode: "create" })}
								section={section}
								onOpenSettings={openSettings}
								collapsed={collapsed}
								onToggleCollapsed={() => setCollapsed((c) => !c)}
							/>
						) : null
					}
					bottomNav={<BottomNav section={section} onSection={changeSection} />}
					fab={<Fab onOpen={() => setQuickAddOpen(true)} />}
				>
					{content}
				</AppShell>

				{/* Mobile workspace switcher: Lists-header title tap -> bottom sheet. */}
				<Sheet open={switcherOpen} onOpenChange={setSwitcherOpen}>
					<SheetContent side="bottom">
						<SheetHeader>
							<SheetTitle>{m.workspace_switcher_title()}</SheetTitle>
						</SheetHeader>
						<div className="flex flex-col gap-1 p-4 pt-0">
							{workspaces.map((w) => (
								<button
									key={w.id}
									type="button"
									onClick={() => selectWorkspace(w.id)}
									className={`rounded-lg px-3 py-2 text-start ${
										w.id === activeId ? "bg-muted font-medium" : ""
									}`}
								>
									{w.name}
								</button>
							))}
							<button
								type="button"
								onClick={() => {
									setOpenSharedRequested(true);
									setSwitcherOpen(false);
								}}
								className="rounded-lg px-3 py-2 text-start text-muted-foreground"
							>
								{m.sidebar_open_shared()}
							</button>
							<button
								type="button"
								data-testid="open-members"
								disabled={!activeId}
								onClick={() => {
									setSwitcherOpen(false);
									setMembersOpen(true);
								}}
								className="rounded-lg px-3 py-2 text-start text-muted-foreground disabled:opacity-50"
							>
								{m.sidebar_members()}
							</button>
						</div>
					</SheetContent>
				</Sheet>

				{activeId && (
					<MembersPanel
						workspaceId={activeId}
						workspaceName={
							workspaces.find((w) => w.id === activeId)?.name ??
							m.workspace_name_fallback()
						}
						open={membersOpen}
						onOpenChange={setMembersOpen}
					/>
				)}

				<QuickAddSheet
					open={quickAddOpen}
					onOpenChange={setQuickAddOpen}
					lists={activeLists}
					labels={labels}
					tasks={tasks}
					currentListId={openListId}
					workspaceId={activeId ?? ""}
				/>

				{viewManager && (
					<ViewManager
						open
						onOpenChange={(o) => {
							if (!o) setViewManager(null);
						}}
						mode={viewManager.mode}
						initial={
							viewManager.mode === "edit"
								? (() => {
										const s = savedViews.find((v) => v.id === viewManager.id);
										return s
											? {
													name: s.name,
													icon: s.icon ?? null,
													scope: s.scope ?? "personal",
													workspaceId: s.workspaceId,
													filter: s.filter,
													display: s.display,
												}
											: undefined;
									})()
								: undefined
						}
						lists={lists.map((l) => ({ id: l.id, title: l.title }))}
						folders={folders.map((f) => ({ id: f.id, name: f.name }))}
						labels={labels.map((l) => ({
							id: l.id,
							name: l.name,
							color: l.color ?? undefined,
						}))}
						members={members}
						workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
						onSubmit={submitView}
					/>
				)}

				{dashboardManager && (
					<DashboardManager
						open
						onOpenChange={(o) => {
							if (!o) setDashboardManager(null);
						}}
						mode={dashboardManager.mode}
						initial={
							dashboardManager.mode === "edit"
								? (() => {
										const d = dashboards.find(
											(row) => row.id === dashboardManager.id,
										);
										return d
											? {
													name: d.name,
													icon: d.icon ?? null,
													scope: d.scope ?? "personal",
													workspaceId: d.workspaceId ?? null,
												}
											: undefined;
									})()
								: undefined
						}
						workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
						onSubmit={submitDashboard}
					/>
				)}

				{/* View onOpenTask reuses the list TaskDetail sheet (design 2.20). */}
				{detailTask && detailList && (
					<TaskDetail
						task={detailTask}
						open
						onOpenChange={(o) => {
							if (!o) setDetailTaskId(null);
						}}
						list={detailList}
						allLists={lists}
						allTasks={tasks}
						allLabels={labels}
						taskLabelIds={labelIdsByTask.get(detailTask.id) ?? []}
					/>
				)}

				{/* Keyboard system is desktop-only (design 2.18): the global handler,
			    ⌘K palette, and ? cheat-sheet. RestrictedShell never mounts these. */}
				{isDesktop && (
					<>
						<WorkspaceKeyboard />
						<CommandPalette
							onNavigateList={openList}
							onNavigateView={openView}
							onNavigateDashboard={openDashboard}
						/>
						<CheatSheet open={cheatOpen} onOpenChange={setCheatOpen} />
					</>
				)}

				<FocusTimer />
			</CommandProvider>
		</FocusProvider>
	);
}
