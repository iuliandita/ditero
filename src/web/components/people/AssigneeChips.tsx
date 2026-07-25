import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import { MemberAvatar } from "./avatar.tsx";

const MAX_SHOWN = 3;

// Avatar STACK for a task's assignees (design 3): overlapping decorative
// avatars with a trailing "+N" overflow. Self-queries assignees + memberships
// (Zero dedupes the shared views across every row), joining each assignee
// userId to the member's name/image. Renders nothing when unassigned.
export function AssigneeChips({ taskId }: { taskId: string }) {
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());

	const users = useMemo(() => {
		const map = new Map<string, { name: string; image: string | null }>();
		for (const mem of memberships) {
			if (mem.user && !map.has(mem.userId)) {
				map.set(mem.userId, {
					name: mem.user.name,
					image: mem.user.image ?? null,
				});
			}
		}
		return map;
	}, [memberships]);

	const mine = useMemo(
		() => assignees.filter((a) => a.taskId === taskId),
		[assignees, taskId],
	);

	if (mine.length === 0) return null;

	const shown = mine.slice(0, MAX_SHOWN);
	const overflow = mine.length - shown.length;
	const names = mine.map(
		(a) => users.get(a.userId)?.name ?? m.group_unknown_user(),
	);

	return (
		<div
			data-testid="assignee-chips"
			role="img"
			className="flex items-center -space-x-2"
			aria-label={m.assignee_chips_aria({ names: names.join(", ") })}
		>
			{shown.map((a) => {
				const u = users.get(a.userId);
				return (
					<MemberAvatar
						key={a.userId}
						name={u?.name ?? m.group_unknown_user()}
						image={u?.image}
						className="size-6 ring-2 ring-background"
					/>
				);
			})}
			{overflow > 0 && (
				<span
					aria-hidden="true"
					className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.65rem] font-medium ring-2 ring-background"
				>
					+{overflow}
				</span>
			)}
		</div>
	);
}
