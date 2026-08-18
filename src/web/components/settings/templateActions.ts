import { Copy, Trash2 } from "lucide-react";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { Template } from "../../../zero/schema.gen.ts";
import { canActOnOwned, type RowAction } from "../ui/row-action.ts";

export type TemplateActionHandlers = {
	use: (template: Template) => void;
	remove: (template: Template) => void;
};

// Plain function, not a hook, like listActions/folderActions/labelActions.
//
// template.delete (mutators.ts:1252) is the list.delete shape on a different
// column: admin+ may delete any template, a write-role holder only one they
// created -- so the predicate hangs off `createdBy`, not an `ownerId` the table
// does not have.
export function templateActions({
	template,
	role,
	userId,
	handlers,
}: {
	template: Template;
	role: Role | null;
	userId: string;
	handlers: TemplateActionHandlers;
}): RowAction[] {
	const canWrite = role !== null && WRITE_ROLES.has(role);
	const canDelete = canActOnOwned(role, template.createdBy, userId);
	// A task template expands into an existing list (template.instantiateTask
	// takes a target listId), which this workspace-level surface has none of.
	// Permission is held, state blocks it: shown, disabled, reason given.
	const blocked = template.kind !== "list";
	return [
		{
			id: "use",
			label: m.action_use_template(),
			icon: Copy,
			hidden: !canWrite,
			...(blocked ? { disabledReason: m.template_use_needs_list() } : {}),
			onSelect: () => handlers.use(template),
		},
		{
			id: "delete",
			label: m.action_delete(),
			icon: Trash2,
			destructive: true,
			hidden: !canDelete,
			onSelect: () => handlers.remove(template),
		},
	];
}
