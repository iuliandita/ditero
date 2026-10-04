import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { m } from "../../../paraglide/messages.js";
import { queries } from "../../../zero/queries.ts";
import { formatList } from "../../lib/intl-format.ts";
import { cn } from "../../lib/utils.ts";
import { MemberAvatar } from "./avatar.tsx";

const MAX_SHOWN = 3;

// Avatar STACK for a task's assignees (design 3): overlapping decorative
// avatars with a trailing "+N" overflow. Self-queries assignees + memberships
// (Zero dedupes the shared views across every row), joining each assignee
// userId to the member's name/image. Renders nothing when unassigned.
export function AssigneeChips({
	taskId,
	density,
}: {
	taskId: string;
	density?: "dashboard";
}) {
	const dashboard = density === "dashboard";
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
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-x-1.5",
				dashboard
					? "w-full flex-col items-start gap-y-1 md:w-auto md:flex-row md:items-center"
					: "flex-wrap",
			)}
			title={m.assignee_chips_aria({ names: formatList(names) })}
			aria-label={m.assignee_chips_aria({ names: formatList(names) })}
		>
			<span
				className={cn(
					"inline-flex items-center",
					dashboard ? "shrink-0 gap-x-1" : "-space-x-2",
				)}
				aria-hidden
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
			</span>
			<span
				aria-hidden
				className={cn(
					"min-w-0 max-w-full wrap-anywhere text-xs text-muted-foreground",
					dashboard && "w-full md:w-auto",
				)}
			>
				{formatList(names)}
			</span>
		</div>
	);
}
