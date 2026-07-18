import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { Dashboard } from "../../zero/schema.gen.ts";

// Thin wrapper over queries.dashboards.mine, sorted by sortKey for the sidebar.
export function useDashboards(): {
	dashboards: Dashboard[];
	loading: boolean;
} {
	const [rows, details] = useQuery(queries.dashboards.mine());
	const dashboards = useMemo(
		() =>
			[...rows].sort((a, b) =>
				a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
			),
		[rows],
	);
	return { dashboards, loading: details.type !== "complete" };
}
