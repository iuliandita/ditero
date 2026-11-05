import { m } from "../../paraglide/messages.js";

export type TaskAudience = { text: string; opensMembers: boolean };

/**
 * Who can read a task, from the membership rows the caller can actually see.
 * Personal workspaces can still hold other members (legacy memberships, guest
 * viewers), so the kind alone never justifies "Only you". Null until the
 * caller's own row has synced: an empty list says nothing about privacy.
 */
export function taskAudience(
	workspace: { name: string; kind: string | null } | undefined,
	members: readonly { userId: string }[],
	callerId: string | undefined,
): TaskAudience | null {
	if (!workspace || !members.some((row) => row.userId === callerId))
		return null;
	if (members.length > 1)
		return {
			text: m.task_visibility_shared({ workspace: workspace.name }),
			opensMembers: true,
		};
	return {
		text: m.task_visibility_personal(),
		opensMembers: workspace.kind !== "personal",
	};
}
