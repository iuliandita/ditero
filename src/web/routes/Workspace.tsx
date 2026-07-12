import { useQuery } from "@rocicorp/zero/react";
import { ChevronLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { queries } from "../../zero/queries.ts";
import { AppShell } from "../components/shell/AppShell.tsx";
import { BottomNav, type Section } from "../components/shell/BottomNav.tsx";
import { CreateList } from "../components/shell/CreateList.tsx";
import { Fab } from "../components/shell/Fab.tsx";
import { groupLists } from "../components/shell/grouping.ts";
import { ListProgress } from "../components/shell/ListProgress.tsx";
import { Sidebar } from "../components/shell/Sidebar.tsx";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../components/ui/sheet.tsx";
import { useIsDesktop } from "../lib/use-media-query.ts";
import { ListView } from "./ListView.tsx";
import { SecurityPanel } from "./SecurityPanel.tsx";

export function Workspace() {
	const isDesktop = useIsDesktop();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [folders] = useQuery(queries.folders.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openListId, setOpenListId] = useState<string | null>(null);
	const [openSharedRequested, setOpenSharedRequested] = useState(false);
	const [section, setSection] = useState<Section>("lists");
	const [collapsed, setCollapsed] = useState(false);
	const [quickAddOpen, setQuickAddOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);

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
	function changeSection(next: Section) {
		setSection(next);
		if (next === "lists") setOpenListId(null);
	}

	const openListRow = openListId
		? (activeLists.find((l) => l.id === openListId) ?? null)
		: null;

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
					<button
						type="button"
						disabled={isDesktop}
						onClick={() => setSwitcherOpen(true)}
						className="text-lg font-semibold disabled:cursor-default"
					>
						{workspaces.find((w) => w.id === activeId)?.name ?? "Lists"}
					</button>
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
							<ul className="flex flex-col gap-1">
								{group.lists.map((l) => (
									<li key={l.id}>
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
									</li>
								))}
							</ul>
						</div>
					))}
				{isDesktop && (
					<div className="border-t pt-2">
						<SecurityPanel />
					</div>
				)}
			</div>
		);
	}

	return (
		<>
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
					</div>
				</SheetContent>
			</Sheet>

			{/* Quick-add seam: Task 10 replaces this placeholder with the real sheet. */}
			<Sheet open={quickAddOpen} onOpenChange={setQuickAddOpen}>
				<SheetContent side="bottom">
					<SheetHeader>
						<SheetTitle>Quick add</SheetTitle>
						<SheetDescription>Coming soon.</SheetDescription>
					</SheetHeader>
				</SheetContent>
			</Sheet>
		</>
	);
}
