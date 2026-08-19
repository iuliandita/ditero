import { Pencil, Plus, Trash2 } from "lucide-react";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { Folder } from "../../../zero/schema.gen.ts";
import type { RowAction } from "../ui/row-action.ts";

export type FolderActionHandlers = {
	newList: (folderId: string) => void;
	rename: (folder: Folder) => void;
	remove: (folder: Folder) => void;
};

// Plain function, not a hook, for the same reason listActions is one: the
// sidebar builds a descriptor per folder heading inside a render callback.
export function folderActions({
	folder,
	role,
	listCount,
	handlers,
}: {
	folder: Folder;
	role: Role | null;
	listCount: number;
	handlers: FolderActionHandlers;
}): RowAction[] {
	const canWrite = role !== null && WRITE_ROLES.has(role);
	return [
		{
			id: "new-list",
			label: m.action_new_list_here(),
			icon: Plus,
			hidden: !canWrite,
			onSelect: () => handlers.newList(folder.id),
		},
		{
			id: "rename",
			label: m.action_rename(),
			icon: Pencil,
			hidden: !canWrite,
			onSelect: () => handlers.rename(folder),
		},
		{
			id: "delete",
			label: m.action_delete(),
			icon: Trash2,
			destructive: true,
			hidden: !canWrite,
			// folder.delete refuses to orphan lists: the FK is `no action` and it
			// throws "folder not empty". Permission is held and state blocks it, so
			// this is disabled with a reason rather than hidden.
			disabledReason: listCount > 0 ? m.folder_delete_blocked() : undefined,
			onSelect: () => handlers.remove(folder),
		},
	];
}
