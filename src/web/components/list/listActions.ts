import { FolderInput, Pencil, Save, Trash2 } from "lucide-react";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { Folder, List } from "../../../zero/schema.gen.ts";
import { canActOnOwned, type RowAction } from "../ui/row-action.ts";

export type ListActionHandlers = {
	rename: (list: List) => void;
	moveToFolder: (list: List, folderId: string | null) => void;
	saveAsTemplate: (list: List) => void;
	remove: (list: List) => void;
};

// Plain function, not a hook: it calls none, and the sidebar builds one
// descriptor per row inside a render callback, where a hook would be illegal.
export function listActions({
	list,
	role,
	userId,
	folders,
	handlers,
}: {
	list: List;
	role: Role | null;
	userId: string;
	folders: Folder[];
	handlers: ListActionHandlers;
}): RowAction[] {
	const canWrite = role !== null && WRITE_ROLES.has(role);
	const canDelete = canActOnOwned(role, list.ownerId, userId);
	return [
		{
			id: "rename",
			label: m.action_rename(),
			icon: Pencil,
			hidden: !canWrite,
			onSelect: () => handlers.rename(list),
		},
		{
			id: "move",
			label: m.action_move_to_folder(),
			icon: FolderInput,
			hidden: !canWrite,
			submenu: [
				{
					id: "move-none",
					label: m.action_no_folder(),
					hidden: list.folderId === null,
					onSelect: () => handlers.moveToFolder(list, null),
				},
				...folders.map((folder) => ({
					id: `move-${folder.id}`,
					label: folder.name,
					hidden: folder.id === list.folderId,
					onSelect: () => handlers.moveToFolder(list, folder.id),
				})),
			],
		},
		{
			id: "template",
			label: m.list_save_as_template(),
			icon: Save,
			hidden: !canWrite,
			onSelect: () => handlers.saveAsTemplate(list),
		},
		{
			id: "delete",
			label: m.action_delete(),
			icon: Trash2,
			destructive: true,
			hidden: !canDelete,
			onSelect: () => handlers.remove(list),
		},
	];
}
