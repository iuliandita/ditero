import type { FilterGroup, ViewDisplay } from "../../domain/view-filter.ts";
import { m } from "../../paraglide/messages.js";

// Product-shipped aggregate views (design 2.20). Built-ins are NOT `view` rows;
// they are constants resolved to the same client predicate (taskMatchesFilter)
// as saved views, so the renderer treats both uniformly. `name` is display-only
// (nav/palette label) and never written or compared — callers key off `id` — so
// it is a getter: this array is module-level, and resolving the message eagerly
// would freeze it at the import-time locale.
export type BuiltinViewId = "today" | "all-my-tasks" | "assigned-to-me";
export type BuiltinView = {
	id: BuiltinViewId;
	name: string;
	icon: string;
	filter: FilterGroup;
	display: ViewDisplay;
};

export const DEFAULT_HOME: BuiltinViewId = "today";

export const BUILTIN_VIEWS: BuiltinView[] = [
	{
		id: "today",
		get name() {
			return m.builtin_view_today();
		},
		icon: "sun",
		filter: {
			op: "or",
			conditions: [
				{ field: "due", operator: "is", value: "today" },
				{ field: "due", operator: "is", value: "overdue" },
			],
		},
		display: {
			layout: "list",
			groupBy: "none",
			sort: { field: "due", dir: "asc" },
			workspaceScope: { mode: "all" },
		},
	},
	{
		id: "all-my-tasks",
		get name() {
			return m.builtin_view_all_my_tasks();
		},
		icon: "list-checks",
		// Empty `and` group matches everything the caller can already see.
		filter: { op: "and", conditions: [] },
		display: {
			layout: "list",
			groupBy: "list",
			sort: { field: "due", dir: "asc" },
			workspaceScope: { mode: "all" },
		},
	},
	{
		id: "assigned-to-me",
		get name() {
			return m.builtin_view_assigned_to_me();
		},
		icon: "flag",
		filter: {
			op: "and",
			conditions: [{ field: "assignee", operator: "includes", value: "me" }],
		},
		display: {
			layout: "list",
			groupBy: "none",
			sort: { field: "due", dir: "asc" },
			workspaceScope: { mode: "all" },
		},
	},
];

export function getBuiltin(id: BuiltinViewId): BuiltinView | undefined {
	return BUILTIN_VIEWS.find((v) => v.id === id);
}
