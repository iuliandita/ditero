import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema } from "../../../zero/schema.gen.ts";
import { formatList } from "../../lib/intl-format.ts";

const isolate = (text: string) => `⁨${text}⁩`;
const firstName = (full: string) => full.trim().split(/\s+/)[0] || full;

// The first assignee's first name, then "+N" for the rest, as plain text in the
// row's context line. The full list stays in the accessible label and title.
// Shared workspaces, or any task assigned to someone other than the viewer: a
// personal row assigned only to its owner has no one to tell apart.
export function AssigneeNames({
	taskId,
	listId,
}: {
	taskId: string;
	listId: string;
}) {
	const zero = useZero<typeof schema>();
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [workspaces] = useQuery(queries.workspaces.mine());

	const mine = useMemo(
		() => assignees.filter((a) => a.taskId === taskId),
		[assignees, taskId],
	);
	const names = useMemo(() => {
		const byUser = new Map<string, string>();
		for (const mem of memberships)
			if (mem.user && !byUser.has(mem.userId))
				byUser.set(mem.userId, mem.user.name);
		return mine.map((a) => byUser.get(a.userId) ?? m.group_unknown_user());
	}, [mine, memberships]);

	const list = lists.find((l) => l.id === listId);
	const workspace = workspaces.find((w) => w.id === list?.workspaceId);
	const onlyViewer = mine.every((a) => a.userId === zero.userID);
	if (names.length === 0 || (workspace?.kind !== "shared" && onlyViewer))
		return null;

	const [lead, ...rest] = names;
	const short = firstName(lead);
	// Two people who share a first name stay apart by their full names.
	const shown = rest.some((n) => firstName(n) === short) ? lead : short;
	const label = m.assignee_chips_aria({ names: formatList(names) });
	return (
		<span
			data-testid="assignee-chips"
			role="img"
			title={label}
			aria-label={label}
			className="min-w-0 truncate text-xs text-muted-foreground"
		>
			<span aria-hidden>
				{rest.length > 0
					? m.task_assignees_more({
							name: isolate(shown),
							count: new Intl.NumberFormat(getLocale()).format(rest.length),
						})
					: isolate(shown)}
			</span>
		</span>
	);
}
