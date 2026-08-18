import { Palette, Pencil, Trash2 } from "lucide-react";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { Label } from "../../../zero/schema.gen.ts";
import type { RowAction } from "../ui/row-action.ts";

export type LabelActionHandlers = {
	rename: (label: Label) => void;
	recolor: (label: Label) => void;
	remove: (label: Label) => void;
};

// Plain function, not a hook, like listActions/folderActions: the manager builds
// one descriptor per row inside a render callback.
//
// All three actions gate on the plain write role. label.update and label.delete
// (mutators.ts:1149, 1173) both call requireWrite on the label's workspace --
// neither has the admin-or-creator shape list.delete uses, and `label` carries
// no ownerId to hang canActOnOwned off anyway.
export function labelActions({
	label,
	role,
	handlers,
}: {
	label: Label;
	role: Role | null;
	handlers: LabelActionHandlers;
}): RowAction[] {
	const canWrite = role !== null && WRITE_ROLES.has(role);
	return [
		{
			id: "rename",
			label: m.action_rename(),
			icon: Pencil,
			hidden: !canWrite,
			onSelect: () => handlers.rename(label),
		},
		{
			id: "recolor",
			label: m.action_recolor(),
			icon: Palette,
			hidden: !canWrite,
			onSelect: () => handlers.recolor(label),
		},
		{
			id: "delete",
			label: m.action_delete(),
			icon: Trash2,
			destructive: true,
			hidden: !canWrite,
			onSelect: () => handlers.remove(label),
		},
	];
}
