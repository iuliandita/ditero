import { useQuery, useZero } from "@rocicorp/zero/react";
import { ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { SortableList } from "../components/list/SortableList.tsx";
import { MembersPanel } from "../components/people/MembersPanel.tsx";
import { QuickAddSheet } from "../components/quickadd/QuickAddSheet.tsx";
import { KeymapSettings } from "../components/settings/KeymapSettings.tsx";
import { AppShell } from "../components/shell/AppShell.tsx";
import { BottomNav, type Section } from "../components/shell/BottomNav.tsx";
import { CreateList } from "../components/shell/CreateList.tsx";
import { Fab } from "../components/shell/Fab.tsx";
import { groupLists } from "../components/shell/grouping.ts";
import { ListProgress } from "../components/shell/ListProgress.tsx";
import { RestrictedShell } from "../components/shell/RestrictedShell.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "../components/ui/sheet.tsx";
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
import { useIsDesktop } from "../lib/use-media-query.ts";
import { ListView } from "./ListView.tsx";
import { SecurityPanel } from "./SecurityPanel.tsx";

// A restricted managed ("kid") account gets a wholly separate shell -- never the
// normal workspace UI. Branch here, before any normal-shell hook runs, keying off
// the kid's own managedAccounts row (userId === me && restricted). A normal user
// has no such row, so this is false on the first render regardless of sync state
// and their shell mounts unchanged.
export function Workspace() {
	const zero = useZero<typeof schema>();
	const [managed] = useQuery(queries.managedAccounts.mine());
	const restricted = managed.some(
		(m) => m.userId === zero.userID && m.restricted,
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
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [folders] = useQuery(queries.folders.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const [labels] = useQuery(queries.labels.mine());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openListId, setOpenListId] = useState<string | null>(null);
	const [openSharedRequested, setOpenSharedRequested] = useState(false);
	const [section, setSection] = useState<Section>("lists");
	const [collapsed, setCollapsed] = useState(false);
	const [quickAddOpen, setQuickAddOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [membersOpen, setMembersOpen] = useState(false);
	const [cheatOpen, setCheatOpen] = useState(false);

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
		setOpenListId(firstList.id);
		setOpenSharedRequested(false);
	}, [openSharedRequested, workspaces, lists, activeId]);

	function selectWorkspace(id: string) {
		setActiveId(id);
		setOpenListId(null);
		setSwitcherOpen(false);
	}
	function openList(id: string) {
		setSection("lists");
		setOpenListId(id);
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
		if (next === "lists") setOpenListId(null);
	}

	const openListRow = openListId
		? (activeLists.find((l) => l.id === openListId) ?? null)
		: null;

	// Command handlers injected into the palette/keyboard system. palette.open and
	// search.open are owned by the provider (it holds the open state). Movement +
	// toggle/delete drive roving DOM focus over [data-kbd-nav] rows, which no-op
	// until Task 12 marks task rows. nav.today/view.new stay stubs (Task 13).
	const commandHandlers = useMemo<CommandHandlers>(
		() => ({
			"task.create": () => setQuickAddOpen(true),
			"settings.open": () => {
				setOpenListId(null);
				setSection("settings");
			},
			"nav.down": () => focusNext(),
			"nav.up": () => focusPrev(),
			"nav.open": () => openFocused(),
			"task.toggleDone": () => actOnFocused("toggle"),
			"task.delete": () => actOnFocused("delete"),
			"help.cheatSheet": () => setCheatOpen(true),
			"nav.today": () => {},
			"view.new": () => {},
		}),
		[],
	);

	let content: React.ReactNode;
	// Mobile keeps Settings on its own tab; desktop pins SecurityPanel to the
	// list-index landing so it is always reachable (the auth-hardening e2e drives
	// it right after signup without navigating).
	if (!isDesktop && section === "settings") {
		content = (
			<div className="p-4">
				<SecurityPanel />
			</div>
		);
	} else if (openListId) {
		content = (
			<div>
				<div className="flex items-center gap-2 border-b p-3 md:hidden">
					<button
						type="button"
						aria-label="Back to lists"
						onClick={() => setOpenListId(null)}
						className="flex size-11 items-center justify-center rounded-lg"
					>
						<ChevronLeft className="size-5" />
					</button>
					<span className="truncate font-medium">
						{openListRow?.title ?? "List"}
					</span>
				</div>
				<div className="p-4 md:p-6">
					<ListView listId={openListId} />
				</div>
			</div>
		);
	} else {
		content = (
			<div className="flex flex-col gap-4 p-4 md:p-6">
				<div className="flex items-center justify-between">
					{isDesktop ? (
						<h1 className="text-lg font-semibold">
							{workspaces.find((w) => w.id === activeId)?.name ?? "Lists"}
						</h1>
					) : (
						// Mobile: the workspace name doubles as the switcher trigger.
						<button
							type="button"
							aria-haspopup="dialog"
							onClick={() => setSwitcherOpen(true)}
							className="text-lg font-semibold"
						>
							{workspaces.find((w) => w.id === activeId)?.name ?? "Lists"}
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
								{group.folder?.name ?? "Lists"}
							</div>
							<SortableList
								items={group.lists}
								onMove={moveList}
								handleLabel="Reorder list"
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
						{/* Keyboard is a desktop feature (design 2.18); the rebind surface
						    lives beside Security on the desktop settings landing only. */}
						<KeymapSettings />
					</div>
				)}
			</div>
		);
	}

	return (
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
							section={section}
							onOpenSettings={() => {
								setOpenListId(null);
								setSection("settings");
							}}
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
						<SheetTitle>Workspaces</SheetTitle>
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
							Open shared
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
							Members
						</button>
					</div>
				</SheetContent>
			</Sheet>

			{activeId && (
				<MembersPanel
					workspaceId={activeId}
					workspaceName={
						workspaces.find((w) => w.id === activeId)?.name ?? "Workspace"
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

			{/* Keyboard system is desktop-only (design 2.18): the global handler,
			    ⌘K palette, and ? cheat-sheet. RestrictedShell never mounts these. */}
			{isDesktop && (
				<>
					<WorkspaceKeyboard />
					<CommandPalette onNavigateList={openList} />
					<CheatSheet open={cheatOpen} onOpenChange={setCheatOpen} />
				</>
			)}
		</CommandProvider>
	);
}
