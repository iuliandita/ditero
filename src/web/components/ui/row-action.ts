// Pure descriptor for a row's action menu. The kebab, the right-click context
// menu and the keyboard opener all render the same array, so an action cannot
// reach one trigger while missing another.
import type { LucideIcon } from "lucide-react";
import { ADMIN_ROLES, type Role, WRITE_ROLES } from "../../../domain/role.ts";

export type RowAction = {
	id: string;
	/** Already translated by the caller. Never a module-scope m.x() call. */
	label: string;
	icon?: LucideIcon;
	/** Keymap command id, so the menu hint tracks a user's remap. */
	commandId?: string;
	destructive?: boolean;
	/** No permission: the action is not shown at all. */
	hidden?: boolean;
	/** Permission held, current state blocks it. Shown, disabled, reason given. */
	disabledReason?: string;
	submenu?: RowAction[];
	onSelect?: () => void;
};

/**
 * Admin+ may act on any row; a write-role holder may act on their own. This is
 * the client mirror of the rule the mutators enforce for list.delete and
 * template.delete. It never grants anything -- the mutator re-checks -- it only
 * keeps the menu from offering an action that would fail. A null ownerId is
 * unclaimable, so such a row is admin-only.
 */
export function canActOnOwned(
	role: Role | null,
	ownerId: string | null,
	userId: string,
): boolean {
	if (!role) return false;
	if (ADMIN_ROLES.has(role)) return true;
	return WRITE_ROLES.has(role) && ownerId === userId;
}

/**
 * Strip hidden actions, recursively. A submenu whose children are all hidden is
 * itself dropped: an empty "Move to folder >" that opens onto nothing reads as
 * broken.
 */
export function visibleActions(actions: RowAction[]): RowAction[] {
	const out: RowAction[] = [];
	for (const action of actions) {
		if (action.hidden) continue;
		if (action.submenu) {
			const submenu = visibleActions(action.submenu);
			if (submenu.length === 0) continue;
			out.push({ ...action, submenu });
			continue;
		}
		out.push(action);
	}
	return out;
}
