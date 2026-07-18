import { type BuiltinViewId, DEFAULT_HOME, getBuiltin } from "./builtins.ts";

// Landing target for user_pref.homeViewRef: a view (built-in or saved) or a
// dashboard ("dashboard:<id>"). Dangling refs (deleted view/dashboard, garbage)
// resolve to DEFAULT_HOME so the landing never dead-ends.
export type HomeTarget =
	| { kind: "view"; id: string }
	| { kind: "dashboard"; id: string };

const DASHBOARD_PREFIX = "dashboard:";

export const dashboardHomeRef = (id: string): string =>
	`${DASHBOARD_PREFIX}${id}`;

export function resolveHomeRef(
	ref: string | null | undefined,
	known: { savedViewIds: readonly string[]; dashboardIds: readonly string[] },
): HomeTarget {
	if (!ref) return { kind: "view", id: DEFAULT_HOME };
	if (ref.startsWith(DASHBOARD_PREFIX)) {
		const id = ref.slice(DASHBOARD_PREFIX.length);
		if (known.dashboardIds.includes(id)) return { kind: "dashboard", id };
		return { kind: "view", id: DEFAULT_HOME };
	}
	if (getBuiltin(ref as BuiltinViewId) || known.savedViewIds.includes(ref))
		return { kind: "view", id: ref };
	return { kind: "view", id: DEFAULT_HOME };
}
