import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import type { Role } from "../../domain/role.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { shareableWorkspaces } from "../lib/create-gates.ts";

// The workspace's synced row sets and the derivations that read only those rows.
// Anything that also reads component state (the active workspace, the open task)
// stays at the call site -- it is state, not data.
export function useWorkspaceData() {
	const zero = useZero<typeof schema>();
	const [workspaces] = useQuery(queries.workspaces.mine());
	const [lists, listsDetails] = useQuery(queries.lists.mine());
	const [folders] = useQuery(queries.folders.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [tasks, tasksDetails] = useQuery(queries.tasks.mine());
	const [labels] = useQuery(queries.labels.mine());
	const [taskLabels] = useQuery(queries.taskLabels.mine());
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	// The view surface joins tasks onto lists, so it is only settled once both
	// queries are; until then "no rows" means "not synced", not "nothing here".
	const viewRowsLoading =
		tasksDetails.type !== "complete" || listsDetails.type !== "complete";

	// The caller's own role per workspace; the mutators re-check on write, this
	// only keeps the menu from offering what would fail.
	const roleByWorkspace = useMemo(() => {
		const map = new Map<string, Role>();
		for (const row of memberships) {
			if (row.userId === zero.userID)
				map.set(row.workspaceId, row.role as Role);
		}
		return map;
	}, [memberships, zero.userID]);
	// Share targets for views/dashboards: every user owns a personal workspace as
	// owner, so this is never empty -- it only drops the workspaces the caller
	// joined as Viewer.
	const shareable = useMemo(
		() => shareableWorkspaces(workspaces, roleByWorkspace),
		[workspaces, roleByWorkspace],
	);
	// Members for the renderer/filter-builder pickers: one entry per co-member.
	const members = useMemo(() => {
		const seen = new Set<string>();
		const out: { id: string; name: string }[] = [];
		for (const row of memberships) {
			if (row.user && !seen.has(row.userId)) {
				seen.add(row.userId);
				out.push({ id: row.userId, name: row.user.name });
			}
		}
		return out;
	}, [memberships]);
	// The renderer scopes to workspaces the user actually belongs to.
	const membershipWorkspaceIds = useMemo(
		() => workspaces.map((w) => w.id),
		[workspaces],
	);
	// Label ids per task -> TaskDetail (view onOpenTask reuses the list sheet).
	const labelIdsByTask = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const tl of taskLabels) {
			const bucket = map.get(tl.taskId);
			if (bucket) bucket.push(tl.labelId);
			else map.set(tl.taskId, [tl.labelId]);
		}
		return map;
	}, [taskLabels]);

	return {
		workspaces,
		lists,
		folders,
		templates,
		tasks,
		labels,
		taskLabels,
		assignees,
		memberships,
		viewRowsLoading,
		roleByWorkspace,
		shareable,
		members,
		membershipWorkspaceIds,
		labelIdsByTask,
	};
}
