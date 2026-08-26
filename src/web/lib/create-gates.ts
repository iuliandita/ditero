// Which creation affordances a caller may be offered, per the M-ui rule: no
// permission hides the action outright. Never grants anything -- every mutator
// re-checks -- it only keeps the UI from advertising a guaranteed rejection.
//
// Deliberate asymmetry: folder.create is unconditionally requireWrite
// (mutators.ts:1086), but view.create and dashboard.create gate on the write
// role ONLY for scope "workspace" (mutators.ts:1481, :1569). A personal view or
// dashboard is legal for a Viewer, so those entry points stay visible for
// everyone and only the workspace-visibility option is gated.
import { type Role, WRITE_ROLES } from "../../domain/role.ts";

function hasWriteRole(role: Role | null): boolean {
	return role !== null && WRITE_ROLES.has(role);
}

export function canCreateFolder(role: Role | null): boolean {
	return hasWriteRole(role);
}

// Same predicate as canCreateFolder today (list.create is also unconditionally
// requireWrite, mutators.ts:1086), named separately because they mirror two
// different mutators and only one of them has to move for these to diverge.
export function canCreateList(role: Role | null): boolean {
	return hasWriteRole(role);
}

/** Workspaces the caller may share a view or dashboard into. */
export function shareableWorkspaces<T extends { id: string }>(
	workspaces: readonly T[],
	roleByWorkspace: ReadonlyMap<string, Role>,
): T[] {
	return workspaces.filter((w) =>
		hasWriteRole(roleByWorkspace.get(w.id) ?? null),
	);
}
