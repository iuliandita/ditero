import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { Dashboard } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.dashboards.mine, sorted by sortKey for the sidebar.
export function useDashboards(): {
	dashboards: Dashboard[];
	loading: boolean;
} {
	const [scopes, scopeDetails] = useQuery(queries.workspaceAccessScopes.own());
	const scopesReady = scopeDetails.type === "complete";

	// Access changes need fresh hydration; names and row order must not restart it.
	const idsKey = JSON.stringify(
		[...new Set(scopes.map((scope) => scope.workspaceId))].sort(),
	);
	const workspaceIds = useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);

	const [rows, details] = useQuery(queries.dashboards.mine({ workspaceIds }));
	const dashboards = useMemo(
		() =>
			[...rows].sort((a, b) =>
				a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
			),
		[rows],
	);
	return {
		dashboards,
		loading: !scopesReady || details.type !== "complete",
	};
}
