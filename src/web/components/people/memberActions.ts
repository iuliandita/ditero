import { Shield, UserMinus } from "lucide-react";
import { ADMIN_ROLES, ROLES, type Role } from "../../../domain/role.ts";
import { m } from "../../../paraglide/messages.js";
import type { RowAction } from "../ui/row-action.ts";
import { ROLE_LABELS } from "./role-labels.ts";

export type MemberActionHandlers = {
	setRole: (membershipId: string, role: Role) => void;
	remove: (membershipId: string, name: string) => void;
};

// Client mirror of the membership mutator's gates. It never grants anything --
// the mutator re-checks every rule -- it only keeps the menu from offering an
// action that would be rejected. Keep in step with mutators.ts's membership
// namespace; the two must agree or the UI offers dead controls.
export function memberActions({
	membershipId,
	memberName,
	memberRole,
	isSelf,
	callerRole,
	ownerCount,
	handlers,
}: {
	membershipId: string;
	memberName: string;
	memberRole: Role;
	isSelf: boolean;
	callerRole: Role | null;
	ownerCount: number;
	handlers: MemberActionHandlers;
}): RowAction[] {
	const isAdmin = callerRole !== null && ADMIN_ROLES.has(callerRole);
	const isOwner = callerRole === "owner";
	// Rules, in the same order as the mutator: no self-target, admins may not
	// touch an owner, the last owner is immovable.
	const mayAct = isAdmin && !isSelf && (memberRole !== "owner" || isOwner);
	const lastOwner = memberRole === "owner" && ownerCount === 1;

	return [
		{
			id: "role",
			label: m.member_action_change_role(),
			icon: Shield,
			hidden: !mayAct,
			disabledReason: lastOwner ? m.member_last_owner_reason() : undefined,
			submenu: ROLES.map((r) => ({
				id: `role:${r}`,
				label: ROLE_LABELS[r](),
				// Only an owner may grant owner.
				hidden: r === "owner" && !isOwner,
				onSelect: () => handlers.setRole(membershipId, r),
			})),
		},
		{
			id: "remove",
			label: m.member_action_remove(),
			icon: UserMinus,
			destructive: true,
			hidden: !mayAct,
			disabledReason: lastOwner ? m.member_last_owner_reason() : undefined,
			onSelect: () => handlers.remove(membershipId, memberName),
		},
	];
}
