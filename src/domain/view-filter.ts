// Pure client-side view predicate. Views are saved filters over the user's
// already-synced, membership-bounded task set, so evaluation is a plain
// predicate (no Zero runtime, no DB, no React). Callers narrow the candidate
// set by workspace via resolveWorkspaceScope, then keep tasks that pass
// taskMatchesFilter.
import { z } from "zod";

export type FilterField =
	| "done"
	| "due"
	| "priority"
	| "kind"
	| "list"
	| "folder"
	| "label"
	| "assignee";

export type FilterCondition = {
	field: FilterField;
	operator: string;
	value: unknown;
};
export type FilterNode = FilterCondition | FilterGroup;
export type FilterGroup = { op: "and" | "or"; conditions: FilterNode[] };

export type ViewLayout = "list" | "board" | "table" | "calendar";
export type GroupBy =
	| "none"
	| "status"
	| "priority"
	| "assignee"
	| "label"
	| "list"
	| "due";
export type WorkspaceScope =
	| { mode: "all" }
	| { mode: "subset"; ids: string[] }
	| { mode: "one"; id: string };
export type ViewDisplay = {
	layout: ViewLayout;
	groupBy: GroupBy;
	sort: { field: string; dir: "asc" | "desc" };
	workspaceScope: WorkspaceScope;
};

export type FilterTask = {
	id: string;
	listId: string;
	workspaceId: string;
	done: boolean;
	dueAt: Date | null;
	priority: number;
	kind: string;
	folderId: string | null;
	labelIds: string[];
	assigneeIds: string[];
};
export type FilterCtx = {
	userId: string;
	now: Date;
	membershipWorkspaceIds: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isGroup(node: FilterNode): node is FilterGroup {
	return (node as FilterGroup).op !== undefined;
}

// Server-authoritative validation of a client-supplied filter/display AST. A
// member with write access to a shared workspace can call view.create/update
// directly (bypassing the builder UI); a malformed tree would otherwise sync to
// co-members and throw in taskMatchesFilter during their render. The mutators
// parse against these schemas, so a bad field/operator or an over-deep/over-wide
// tree is rejected at write time.
const FILTER_FIELDS = [
	"done",
	"due",
	"priority",
	"kind",
	"list",
	"folder",
	"label",
	"assignee",
] as const satisfies readonly FilterField[];

const MAX_CONDITIONS = 50; // breadth per group
const MAX_FILTER_DEPTH = 5; // group nesting
const MAX_FILTER_NODES = 200; // total conditions + groups

const filterConditionSchema = z.object({
	field: z.enum(FILTER_FIELDS),
	operator: z.string().min(1).max(20),
	value: z.unknown(),
});

const filterGroupBase: z.ZodType<FilterGroup> = z.lazy(() =>
	z.object({
		op: z.enum(["and", "or"]),
		conditions: z
			.array(z.union([filterConditionSchema, filterGroupBase]))
			.max(MAX_CONDITIONS),
	}),
);

// z.lazy caps breadth but not total depth/size; walk once and reject over-deep or
// over-large trees (both are cheap stack/CPU DoS vectors against co-members).
export function assertFilterDepth(
	group: FilterGroup,
	maxDepth = MAX_FILTER_DEPTH,
	maxNodes = MAX_FILTER_NODES,
): void {
	let nodes = 0;
	const walk = (node: FilterNode, depth: number): void => {
		nodes += 1;
		if (nodes > maxNodes) throw new Error("view-filter: filter too large");
		if (isGroup(node)) {
			if (depth > maxDepth)
				throw new Error("view-filter: filter nesting too deep");
			for (const child of node.conditions) walk(child, depth + 1);
		}
	};
	walk(group, 1);
}

export const filterGroupSchema = filterGroupBase.superRefine(
	(group, refCtx) => {
		try {
			assertFilterDepth(group);
		} catch (err) {
			refCtx.addIssue({ code: "custom", message: (err as Error).message });
		}
	},
);

export const viewDisplaySchema: z.ZodType<ViewDisplay> = z.object({
	layout: z.enum(["list", "board", "table", "calendar"]),
	groupBy: z.enum([
		"none",
		"status",
		"priority",
		"assignee",
		"label",
		"list",
		"due",
	]),
	sort: z.object({
		field: z.string().max(40),
		dir: z.enum(["asc", "desc"]),
	}),
	workspaceScope: z.discriminatedUnion("mode", [
		z.object({ mode: z.literal("all") }),
		z.object({ mode: z.literal("subset"), ids: z.array(z.string()).max(100) }),
		z.object({ mode: z.literal("one"), id: z.string() }),
	]),
});

// Day boundaries derive from ctx.now as a UTC calendar day. Timezone-aware
// boundaries (per-user zone) are a later refinement.
function todayStart(now: Date): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function asNumber(value: unknown, field: string): number {
	if (typeof value !== "number") {
		throw new Error(`view-filter: ${field} value must be a number`);
	}
	return value;
}

function asStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`view-filter: ${field} 'in' value must be a string[]`);
	}
	return value as string[];
}

// Resolves the assignee "me" token to the current user; all other values are
// literal ids. Label values are always literal (no "me" token).
function resolveAssigneeValue(value: unknown, ctx: FilterCtx): string {
	if (typeof value !== "string") {
		throw new Error("view-filter: assignee value must be a string");
	}
	return value === "me" ? ctx.userId : value;
}

function matchDue(
	task: FilterTask,
	cond: FilterCondition,
	ctx: FilterCtx,
): boolean {
	if (cond.operator === "is") {
		const start = todayStart(ctx.now);
		const due = task.dueAt === null ? null : task.dueAt.getTime();
		switch (cond.value) {
			case "none":
				return due === null;
			case "overdue":
				return due !== null && due < start && !task.done;
			case "today":
				return due !== null && due >= start && due < start + DAY_MS;
			case "next7":
				return due !== null && due >= start && due < start + 7 * DAY_MS;
			default:
				throw new Error(
					`view-filter: unknown due literal '${String(cond.value)}'`,
				);
		}
	}
	if (cond.operator === "before" || cond.operator === "after") {
		if (typeof cond.value !== "string") {
			throw new Error(
				"view-filter: due before/after value must be an ISO string",
			);
		}
		if (task.dueAt === null) return false;
		const bound = new Date(cond.value).getTime();
		if (Number.isNaN(bound)) {
			throw new Error(
				`view-filter: invalid due date bound: ${String(cond.value)}`,
			);
		}
		const due = task.dueAt.getTime();
		return cond.operator === "before" ? due < bound : due > bound;
	}
	throw new Error(`view-filter: unknown operator '${cond.operator}' for due`);
}

function matchCondition(
	task: FilterTask,
	cond: FilterCondition,
	ctx: FilterCtx,
): boolean {
	switch (cond.field) {
		case "done":
			if (cond.operator !== "is") {
				throw new Error(
					`view-filter: unknown operator '${cond.operator}' for done`,
				);
			}
			return task.done === cond.value;
		case "due":
			return matchDue(task, cond, ctx);
		case "priority": {
			const v = asNumber(cond.value, "priority");
			switch (cond.operator) {
				case "eq":
					return task.priority === v;
				case "gte":
					return task.priority >= v;
				case "lte":
					return task.priority <= v;
				default:
					throw new Error(
						`view-filter: unknown operator '${cond.operator}' for priority`,
					);
			}
		}
		case "kind":
			if (cond.operator === "eq") return task.kind === cond.value;
			if (cond.operator === "in")
				return asStringArray(cond.value, "kind").includes(task.kind);
			throw new Error(
				`view-filter: unknown operator '${cond.operator}' for kind`,
			);
		case "list":
			if (cond.operator === "eq") return task.listId === cond.value;
			if (cond.operator === "in")
				return asStringArray(cond.value, "list").includes(task.listId);
			throw new Error(
				`view-filter: unknown operator '${cond.operator}' for list`,
			);
		case "folder":
			if (cond.operator === "eq") return task.folderId === cond.value;
			if (cond.operator === "in")
				return (
					task.folderId !== null &&
					asStringArray(cond.value, "folder").includes(task.folderId)
				);
			throw new Error(
				`view-filter: unknown operator '${cond.operator}' for folder`,
			);
		case "label": {
			if (typeof cond.value !== "string") {
				throw new Error("view-filter: label value must be a string");
			}
			const has = task.labelIds.includes(cond.value);
			if (cond.operator === "includes") return has;
			if (cond.operator === "excludes") return !has;
			throw new Error(
				`view-filter: unknown operator '${cond.operator}' for label`,
			);
		}
		case "assignee": {
			const id = resolveAssigneeValue(cond.value, ctx);
			const has = task.assigneeIds.includes(id);
			if (cond.operator === "includes") return has;
			if (cond.operator === "excludes") return !has;
			throw new Error(
				`view-filter: unknown operator '${cond.operator}' for assignee`,
			);
		}
		default:
			throw new Error(`view-filter: unknown field '${String(cond.field)}'`);
	}
}

// Recursive group eval: and = every node true, or = some node true. An empty
// conditions array matches all (true) under both operators.
export function taskMatchesFilter(
	task: FilterTask,
	group: FilterGroup,
	ctx: FilterCtx,
): boolean {
	const evalNode = (node: FilterNode): boolean =>
		isGroup(node)
			? taskMatchesFilter(task, node, ctx)
			: matchCondition(task, node, ctx);

	if (group.conditions.length === 0) return true;
	return group.op === "and"
		? group.conditions.every(evalNode)
		: group.conditions.some(evalNode);
}

// Allowed workspace-id set = memberships intersected with the scope selection.
// Callers apply this as an implicit AND (drop tasks whose workspaceId is not in
// the set). Never widens beyond ctx.membershipWorkspaceIds.
export function resolveWorkspaceScope(
	scope: WorkspaceScope,
	ctx: FilterCtx,
): Set<string> {
	const members = new Set(ctx.membershipWorkspaceIds);
	if (scope.mode === "all") return members;
	const selection = scope.mode === "subset" ? scope.ids : [scope.id];
	return new Set(selection.filter((id) => members.has(id)));
}
