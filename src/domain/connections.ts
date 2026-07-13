export type Membership = { userId: string; workspaceId: string };

// Connections are derived, never stored (design 2.6): everyone who shares
// >=1 workspace with `me`, excluding `me`. Two passes: first collect the
// workspaceIds `me` belongs to, then collect other users in those
// workspaces, so a workspace `me` isn't in never leaks a connection.
// Sorted lexicographically for deterministic output.
export function deriveConnections(
	memberships: Membership[],
	me: string,
): string[] {
	const myWorkspaces = new Set(
		memberships.filter((m) => m.userId === me).map((m) => m.workspaceId),
	);

	const connections = new Set<string>();
	for (const m of memberships) {
		if (m.userId !== me && myWorkspaces.has(m.workspaceId)) {
			connections.add(m.userId);
		}
	}

	return [...connections].sort();
}
