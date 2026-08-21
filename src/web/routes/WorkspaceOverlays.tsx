import { m } from "../../paraglide/messages.js";
import type {
	Dashboard,
	Folder,
	Label,
	List,
	Task,
	Workspace,
} from "../../zero/schema.gen.ts";
import {
	type DashboardFormValue,
	DashboardManager,
} from "../components/dashboard/DashboardManager.tsx";
import { TaskDetail } from "../components/list/TaskDetail.tsx";
import { MembersPanel } from "../components/people/MembersPanel.tsx";
import { QuickAddSheet } from "../components/quickadd/QuickAddSheet.tsx";
import { MobileSearch } from "../components/shell/MobileSearch.tsx";
import { NameDialog } from "../components/shell/NameDialog.tsx";
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
import type { SavedView } from "../hooks/useViews.ts";
import { CheatSheet } from "../keyboard/CheatSheet.tsx";
import { useCommands } from "../keyboard/CommandContext.tsx";
import { CommandPalette } from "../keyboard/CommandPalette.tsx";
import { useEffectiveKeymap } from "../keyboard/useEffectiveKeymap.ts";
import { useKeyBindings } from "../keyboard/useKeyBindings.ts";

// Installs the global key handler inside CommandProvider scope so `run` and the
// effective keymap resolve against live provider/pref state. Renders nothing;
// mounted desktop-only (design 2.18).
function WorkspaceKeyboard() {
	const { run } = useCommands();
	const keymap = useEffectiveKeymap();
	useKeyBindings(keymap, run);
	return null;
}

// Every dialog and sheet the workspace can raise, rendered as a sibling of
// AppShell inside the same providers. Props are wide and explicit on purpose:
// this is the honest list of what the overlay layer reads.
export function WorkspaceOverlays({
	isDesktop,
	activeId,
	openListId,
	workspaces,
	lists,
	activeLists,
	folders,
	labels,
	tasks,
	savedViews,
	dashboards,
	shareable,
	members,
	labelIdsByTask,
	switcherOpen,
	onSwitcherOpenChange,
	onSelectWorkspace,
	onOpenShared,
	membersOpen,
	onMembersOpenChange,
	quickAddOpen,
	onQuickAddOpenChange,
	viewManager,
	onViewManagerClose,
	onSubmitView,
	dashboardManager,
	onDashboardManagerClose,
	onSubmitDashboard,
	renameTarget,
	onRenameClose,
	onSubmitRename,
	folderDialog,
	onFolderDialogClose,
	onSubmitFolderDialog,
	detailTask,
	detailList,
	onDetailClose,
	searchOpen,
	onSearchSelect,
	onSearchClose,
	cheatOpen,
	onCheatOpenChange,
	onOpenList,
	onOpenView,
	onOpenDashboard,
}: {
	isDesktop: boolean;
	activeId: string | null;
	openListId: string | null;
	workspaces: Workspace[];
	lists: List[];
	activeLists: List[];
	folders: Folder[];
	labels: Label[];
	tasks: Task[];
	savedViews: SavedView[];
	dashboards: Dashboard[];
	shareable: Workspace[];
	members: { id: string; name: string }[];
	labelIdsByTask: Map<string, string[]>;
	switcherOpen: boolean;
	onSwitcherOpenChange: (open: boolean) => void;
	onSelectWorkspace: (id: string) => void;
	onOpenShared: () => void;
	membersOpen: boolean;
	onMembersOpenChange: (open: boolean) => void;
	quickAddOpen: boolean;
	onQuickAddOpenChange: (open: boolean) => void;
	viewManager: { mode: "create" } | { mode: "edit"; id: string } | null;
	onViewManagerClose: () => void;
	onSubmitView: (value: ViewFormValue) => void;
	dashboardManager: { mode: "create" } | { mode: "edit"; id: string } | null;
	onDashboardManagerClose: () => void;
	onSubmitDashboard: (value: DashboardFormValue) => void;
	renameTarget: List | null;
	onRenameClose: () => void;
	onSubmitRename: (name: string) => void;
	folderDialog: { mode: "create" } | { mode: "rename"; folder: Folder } | null;
	onFolderDialogClose: () => void;
	onSubmitFolderDialog: (name: string) => void;
	detailTask: Task | null;
	detailList: List | null;
	onDetailClose: () => void;
	searchOpen: boolean;
	onSearchSelect: (taskId: string, listId: string) => void;
	onSearchClose: () => void;
	cheatOpen: boolean;
	onCheatOpenChange: (open: boolean) => void;
	onOpenList: (id: string) => void;
	onOpenView: (id: string) => void;
	onOpenDashboard: (id: string) => void;
}) {
	return (
		<>
			{/* Mobile workspace switcher: Lists-header title tap -> bottom sheet. */}
			<Sheet open={switcherOpen} onOpenChange={onSwitcherOpenChange}>
				<SheetContent side="bottom">
					<SheetHeader>
						<SheetTitle>{m.workspace_switcher_title()}</SheetTitle>
					</SheetHeader>
					<div className="flex flex-col gap-1 p-4 pt-0">
						{workspaces.map((w) => (
							<button
								key={w.id}
								type="button"
								onClick={() => onSelectWorkspace(w.id)}
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
								onOpenShared();
								onSwitcherOpenChange(false);
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
								onSwitcherOpenChange(false);
								onMembersOpenChange(true);
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
					onOpenChange={onMembersOpenChange}
				/>
			)}

			<QuickAddSheet
				open={quickAddOpen}
				onOpenChange={onQuickAddOpenChange}
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
						if (!o) onViewManagerClose();
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
					shareableWorkspaces={shareable.map((w) => ({
						id: w.id,
						name: w.name,
					}))}
					onSubmit={onSubmitView}
				/>
			)}

			{dashboardManager && (
				<DashboardManager
					open
					onOpenChange={(o) => {
						if (!o) onDashboardManagerClose();
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
					shareableWorkspaces={shareable.map((w) => ({
						id: w.id,
						name: w.name,
					}))}
					onSubmit={onSubmitDashboard}
				/>
			)}

			<NameDialog
				open={renameTarget !== null}
				initialName={renameTarget?.title ?? ""}
				title={m.action_rename()}
				fieldLabel={m.field_name()}
				testId="list-rename"
				onSubmit={onSubmitRename}
				onOpenChange={(o) => {
					if (!o) onRenameClose();
				}}
			/>

			<NameDialog
				open={folderDialog !== null}
				initialName={
					folderDialog?.mode === "rename" ? folderDialog.folder.name : ""
				}
				title={
					folderDialog?.mode === "rename"
						? m.folder_rename_title()
						: m.action_new_folder()
				}
				fieldLabel={m.folder_name_label()}
				testId="folder-name"
				onSubmit={onSubmitFolderDialog}
				onOpenChange={(o) => {
					if (!o) onFolderDialogClose();
				}}
			/>

			{/* View onOpenTask reuses the list TaskDetail sheet (design 2.20). */}
			{detailTask && detailList && (
				<TaskDetail
					task={detailTask}
					open
					onOpenChange={(o) => {
						if (!o) onDetailClose();
					}}
					list={detailList}
					allLists={lists}
					allTasks={tasks}
					allLabels={labels}
					taskLabelIds={labelIdsByTask.get(detailTask.id) ?? []}
				/>
			)}

			{/* Touch search: the palette's Search group without its keyboard
		    command registry. Unmounted while closed so a stale layer never
		    claims the Escape aimed at the task detail it just opened. */}
			{!isDesktop && searchOpen && (
				<MobileSearch
					tasks={tasks}
					lists={lists}
					onSelect={onSearchSelect}
					onClose={onSearchClose}
				/>
			)}

			{/* Keyboard system is desktop-only (design 2.18): the global handler,
		    ⌘K palette, and ? cheat-sheet. RestrictedShell never mounts these. */}
			{isDesktop && (
				<>
					<WorkspaceKeyboard />
					<CommandPalette
						onNavigateList={onOpenList}
						onNavigateView={onOpenView}
						onNavigateDashboard={onOpenDashboard}
					/>
					<CheatSheet open={cheatOpen} onOpenChange={onCheatOpenChange} />
				</>
			)}
		</>
	);
}
