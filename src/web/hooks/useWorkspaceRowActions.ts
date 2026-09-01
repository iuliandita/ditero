import { useZero } from "@rocicorp/zero/react";
import { House, Pencil, Trash2 } from "lucide-react";
import type { ListKind } from "../../domain/icon-map.ts";
import { randomId } from "../../domain/random-id.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import { snapshotList } from "../../domain/template.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type {
	Dashboard,
	Folder,
	List,
	schema,
	Task,
} from "../../zero/schema.gen.ts";
import {
	type ListActionHandlers,
	listActions,
} from "../components/list/listActions.ts";
import {
	type FolderActionHandlers,
	folderActions,
} from "../components/shell/folderActions.ts";
import { useConfirm } from "../components/ui/confirm.tsx";
import { canActOnOwned, type RowAction } from "../components/ui/row-action.ts";
import type { SavedView } from "../hooks/useViews.ts";
import { dashboardHomeRef } from "../views/home-ref.ts";

type ManagerState = { mode: "create" } | { mode: "edit"; id: string };

// The four row-action descriptor builders and the mutations only they reach.
// Every menu here mirrors a server-side gate; the mutators re-check on write.
export function useWorkspaceRowActions({
	tasks,
	activeLists,
	activeFolders,
	roleByWorkspace,
	savedViews,
	onOpenHome,
	onCloseList,
	setNewListFolder,
	setRenameTarget,
	setFolderDialog,
	setViewManager,
	setDashboardManager,
	setHome,
	onDeleteView,
	onDeleteDashboard,
}: {
	tasks: Task[];
	activeLists: List[];
	activeFolders: Folder[];
	roleByWorkspace: Map<string, Role>;
	savedViews: SavedView[];
	onOpenHome: () => void;
	onCloseList: (id: string) => void;
	setNewListFolder: (value: { id: string; nonce: number } | null) => void;
	setRenameTarget: (list: List | null) => void;
	setFolderDialog: (
		value: { mode: "create" } | { mode: "rename"; folder: Folder } | null,
	) => void;
	setViewManager: (value: ManagerState | null) => void;
	setDashboardManager: (value: ManagerState | null) => void;
	setHome: (id: string) => void;
	onDeleteView: (view: SavedView) => void;
	onDeleteDashboard: (dashboard: Dashboard) => void;
}) {
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();

	function moveListToFolder(list: List, folderId: string | null) {
		void zero
			.mutate(mutators.list.update({ id: list.id, folderId }))
			.client.catch((e) => console.error("list.update failed", e));
	}

	function saveListAsTemplate(list: List) {
		const rows = tasks.filter((t) => t.listId === list.id);
		const parents = rows.filter((t) => t.parentId == null);
		const content = snapshotList(
			{ kind: (list.kind ?? "tasks") as ListKind, icon: list.icon },
			parents.map((p) => ({
				...p,
				subtasks: rows
					.filter((t) => t.parentId === p.id)
					.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)),
			})),
		);
		void zero
			.mutate(
				mutators.template.save({
					id: randomId(),
					workspaceId: list.workspaceId,
					name: list.title,
					kind: "list",
					content,
					...(list.icon != null ? { icon: list.icon } : {}),
				}),
			)
			.client.catch((e) => console.error("template.save failed", e));
	}

	async function deleteList(list: List) {
		// list.delete removes every task in the list, subtasks included, so the
		// count is over all of them -- the copy says "items", not "tasks".
		const count = tasks.filter((t) => t.listId === list.id).length;
		const ok = await confirm({
			title: m.list_delete_title(),
			body: m.list_delete_confirm({ title: list.title, count }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.list.delete({ id: list.id }))
			.client.catch((e) => console.error("list.delete failed", e));
		onCloseList(list.id);
	}

	const listActionHandlers: ListActionHandlers = {
		rename: setRenameTarget,
		moveToFolder: moveListToFolder,
		saveAsTemplate: saveListAsTemplate,
		remove: (list) => void deleteList(list),
	};

	const buildListActions = (list: List) =>
		listActions({
			list,
			role: roleByWorkspace.get(list.workspaceId) ?? null,
			userId: zero.userID ?? "",
			folders: activeFolders,
			handlers: listActionHandlers,
		});

	async function deleteFolder(folder: Folder) {
		// Only reachable on an empty folder: folder.delete refuses a non-empty one,
		// and the menu item carries that reason disabled, so the body states no count.
		const ok = await confirm({
			title: m.folder_delete_title(),
			body: m.folder_delete_confirm({ name: folder.name }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.folder.delete({ id: folder.id }))
			.client.catch((e) => console.error("folder.delete failed", e));
	}

	const folderActionHandlers: FolderActionHandlers = {
		newList: (folderId) => {
			// The create-list form lives on the lists index, so land there first.
			onOpenHome();
			setNewListFolder({ id: folderId, nonce: Date.now() });
		},
		rename: (folder) => setFolderDialog({ mode: "rename", folder }),
		remove: (folder) => void deleteFolder(folder),
	};

	const buildFolderActions = (folder: Folder) =>
		folderActions({
			folder,
			role: roleByWorkspace.get(folder.workspaceId) ?? null,
			listCount: activeLists.filter((l) => l.folderId === folder.id).length,
			handlers: folderActionHandlers,
		});

	// Mirrors requireViewEdit / the inlined view.delete gate in the mutators:
	// personal is the owner's alone at both levels; workspace edit needs a write
	// role, and workspace delete is admin-or-creator (canActOnOwned). "Set as
	// home" is never gated -- it writes only the caller's own user_pref row, which
	// every role including Viewer may do. Built-ins (no saved row) offer only that.
	const buildViewActions = (id: string): RowAction[] => {
		const saved = savedViews.find((v) => v.id === id) ?? null;
		const isPersonal = saved?.scope === "personal";
		const role = saved?.workspaceId
			? (roleByWorkspace.get(saved.workspaceId) ?? null)
			: null;
		const userId = zero.userID ?? "";
		const canEdit = isPersonal
			? saved?.ownerId === userId
			: role !== null && WRITE_ROLES.has(role);
		const canDelete = isPersonal
			? saved?.ownerId === userId
			: canActOnOwned(role, saved?.ownerId ?? null, userId);
		return [
			{
				id: "edit",
				label: m.view_menu_edit(),
				icon: Pencil,
				hidden: !saved || !canEdit,
				onSelect: () => setViewManager({ mode: "edit", id }),
			},
			{
				id: "set-home",
				label: m.view_set_home(),
				icon: House,
				onSelect: () => setHome(id),
			},
			{
				id: "delete",
				label: m.view_menu_delete(),
				icon: Trash2,
				destructive: true,
				hidden: !saved || !canDelete,
				onSelect: () => {
					if (saved) onDeleteView(saved);
				},
			},
		];
	};

	// Twin of buildViewActions, against requireDashboardEdit and the inlined
	// dashboard.delete gate.
	const buildDashboardActions = (dashboard: Dashboard): RowAction[] => {
		const isPersonal = dashboard.scope === "personal";
		const role = dashboard.workspaceId
			? (roleByWorkspace.get(dashboard.workspaceId) ?? null)
			: null;
		const userId = zero.userID ?? "";
		const canEdit = isPersonal
			? dashboard.ownerId === userId
			: role !== null && WRITE_ROLES.has(role);
		const canDelete = isPersonal
			? dashboard.ownerId === userId
			: canActOnOwned(role, dashboard.ownerId, userId);
		return [
			{
				id: "edit",
				label: m.dashboard_menu_edit(),
				icon: Pencil,
				hidden: !canEdit,
				onSelect: () => setDashboardManager({ mode: "edit", id: dashboard.id }),
			},
			{
				id: "set-home",
				label: m.dashboard_set_home(),
				icon: House,
				onSelect: () => setHome(dashboardHomeRef(dashboard.id)),
			},
			{
				id: "delete",
				label: m.dashboard_delete(),
				icon: Trash2,
				destructive: true,
				hidden: !canDelete,
				onSelect: () => onDeleteDashboard(dashboard),
			},
		];
	};

	return {
		buildListActions,
		buildFolderActions,
		buildViewActions,
		buildDashboardActions,
	};
}
