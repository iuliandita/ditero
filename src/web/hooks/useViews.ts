import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import type { FilterGroup, ViewDisplay } from "../../domain/view-filter.ts";
import { queries } from "../../zero/queries.ts";
import type { View } from "../../zero/schema.gen.ts";

// A saved `view` row with its opaque jsonb `filter`/`display` narrowed to the
// domain AST types. They are stored opaque (validated at read by
// taskMatchesFilter), so this is a typed cast, not a re-parse.
export type SavedView = Omit<View, "filter" | "display"> & {
	filter: FilterGroup;
	display: ViewDisplay;
};

// Thin wrapper over queries.views.mine -- returns saved views only (built-ins
// live in ../views/builtins.ts). Does not fetch tasks; the renderer joins.
export function useViews(): { views: SavedView[]; loading: boolean } {
	const [rows, details] = useQuery(queries.views.mine());
	const views = useMemo<SavedView[]>(
		() =>
			rows.map((r) => ({
				...r,
				filter: r.filter as FilterGroup,
				display: r.display as ViewDisplay,
			})),
		[rows],
	);
	return { views, loading: details.type !== "complete" };
}
