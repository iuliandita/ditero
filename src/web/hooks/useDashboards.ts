import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { Dashboard } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.dashboards.mine, sorted by sortKey for the sidebar.
export function useDashboards(): {
	dashboards: Dashboard[];
	loading: boolean;
} {
	const [memberships, membershipDetails] = useQuery(queries.memberships.own());
	const membershipsReady = membershipDetails.type === "complete";

	// Membership changes need fresh hydration; names and row order must not restart it.
	const idsKey = JSON.stringify(
		[...new Set(memberships.map((m) => m.workspaceId))].sort(),
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
		loading: !membershipsReady || details.type !== "complete",
	};
}
