import type {
	FilterGroup,
	FilterNode,
	GroupBy,
	ViewLayout,
} from "../../domain/view-filter.ts";
import { isGroup } from "../../domain/view-filter.ts";
import { m } from "../../paraglide/messages.js";
import { priorityLabel } from "../lib/task-display.ts";

// Pure grouping for the view renderer. Views feed an already filtered + sorted
// task set here; grouping only buckets + orders the buckets, never re-sorts the
// tasks inside a bucket (the caller's view sort/sortKey order is preserved).
// No React, no Zero, no schema types so it stays fully unit-testable.

export type GroupTask = {
	id: string;
	listId: string;
	title: string;
	done: boolean;
	dueAt: Date | null;
	priority: number;
	assigneeIds: string[];
	labelIds: string[];
};

export type GroupCtx = {
	now: Date;
	listTitle: (listId: string) => string;
	memberName: (userId: string) => string;
	labelName: (labelId: string) => string;
};

export type TaskGroup = { key: string; label: string; tasks: GroupTask[] };

const DAY_MS = 24 * 60 * 60 * 1000;

// UTC calendar day, identical to view-filter's due boundaries so grouping and
// filtering agree on what "today"/"overdue" mean.
function todayStart(now: Date): number {
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function pushInto(map: Map<string, GroupTask[]>, key: string, t: GroupTask) {
	const bucket = map.get(key);
	if (bucket) bucket.push(t);
	else map.set(key, [t]);
}

// Due bucket by date only; completion state is ignored so every task lands in
// exactly one bucket (a done+overdue task still buckets as overdue by its date).
function dueBucketKey(dueAt: Date | null, now: Date): string {
	if (dueAt === null) return "none";
	const start = todayStart(now);
	const due = dueAt.getTime();
	if (due < start) return "overdue";
	if (due < start + DAY_MS) return "today";
	if (due < start + 7 * DAY_MS) return "next7";
	return "later";
}

const PRIORITY_ORDER = [3, 2, 1, 0];

const DUE_ORDER = ["overdue", "today", "next7", "later", "none"];
// Thunks: resolving `m` at module scope would freeze the import-time locale.
const DUE_LABELS: Record<string, () => string> = {
	overdue: m.due_overdue,
	today: m.due_today,
	next7: m.due_next7,
	later: m.due_later,
	none: m.due_no_date,
};

// Buckets tasks into ordered groups. Semantics per mode:
// - none: one group {key:"all", label:""} with every task (ungrouped passthrough).
// - status: always two groups, "Open" (done=false) then "Done" (done=true),
//   even when empty (stable columns for a status board).
// - priority: High(3)/Medium(2)/Low(1)/None(0) in that fixed order; empty
//   priorities are skipped.
// - assignee: one group per assignee (label=memberName) ordered by name, then a
//   trailing "Unassigned" group. A multi-assignee task FANS OUT (appears under
//   each of its assignees).
// - label: one group per label (label=labelName) ordered by name, then a
//   trailing "No label" group. A multi-label task FANS OUT.
// - list: one group per listId (label=listTitle) ordered by title.
// - due: Overdue / Today / Next 7 days / Later / No date in that fixed order;
//   empty buckets are skipped.
export function groupTasks(
	tasks: GroupTask[],
	groupBy: GroupBy,
	ctx: GroupCtx,
): TaskGroup[] {
	switch (groupBy) {
		case "none":
			return [{ key: "all", label: "", tasks }];
		case "status": {
			const open: GroupTask[] = [];
			const done: GroupTask[] = [];
			for (const t of tasks) (t.done ? done : open).push(t);
			return [
				{ key: "open", label: m.status_open(), tasks: open },
				{ key: "done", label: m.status_done(), tasks: done },
			];
		}
		case "priority": {
			const buckets = new Map<string, GroupTask[]>();
			for (const t of tasks) {
				const p = PRIORITY_ORDER.includes(t.priority) ? t.priority : 0;
				pushInto(buckets, String(p), t);
			}
			return PRIORITY_ORDER.filter((p) => buckets.has(String(p))).map((p) => ({
				key: String(p),
				label: priorityLabel(p),
				tasks: buckets.get(String(p)) ?? [],
			}));
		}
		case "assignee": {
			const buckets = new Map<string, GroupTask[]>();
			for (const t of tasks) {
				if (t.assigneeIds.length === 0) pushInto(buckets, "", t);
				else for (const uid of t.assigneeIds) pushInto(buckets, uid, t);
			}
			const named = [...buckets.keys()].filter((k) => k !== "");
			named.sort((a, b) => ctx.memberName(a).localeCompare(ctx.memberName(b)));
			const keys = buckets.has("") ? [...named, ""] : named;
			return keys.map((k) => ({
				key: k,
				label: k === "" ? m.group_unassigned() : ctx.memberName(k),
				tasks: buckets.get(k) ?? [],
			}));
		}
		case "label": {
			const buckets = new Map<string, GroupTask[]>();
			for (const t of tasks) {
				if (t.labelIds.length === 0) pushInto(buckets, "", t);
				else for (const lid of t.labelIds) pushInto(buckets, lid, t);
			}
			const named = [...buckets.keys()].filter((k) => k !== "");
			named.sort((a, b) => ctx.labelName(a).localeCompare(ctx.labelName(b)));
			const keys = buckets.has("") ? [...named, ""] : named;
			return keys.map((k) => ({
				key: k,
				label: k === "" ? m.group_no_label() : ctx.labelName(k),
				tasks: buckets.get(k) ?? [],
			}));
		}
		case "list": {
			const buckets = new Map<string, GroupTask[]>();
			for (const t of tasks) pushInto(buckets, t.listId, t);
			const keys = [...buckets.keys()].sort((a, b) =>
				ctx.listTitle(a).localeCompare(ctx.listTitle(b)),
			);
			return keys.map((k) => ({
				key: k,
				label: ctx.listTitle(k),
				tasks: buckets.get(k) ?? [],
			}));
		}
		case "due": {
			const buckets = new Map<string, GroupTask[]>();
			for (const t of tasks)
				pushInto(buckets, dueBucketKey(t.dueAt, ctx.now), t);
			return DUE_ORDER.filter((k) => buckets.has(k)).map((k) => ({
				key: k,
				label: DUE_LABELS[k](),
				tasks: buckets.get(k) ?? [],
			}));
		}
		default:
			return [{ key: "all", label: "", tasks }];
	}
}

// A board with no grouping is one column holding every card, which is a list
// with extra chrome. The view form defaults a board to priority; this covers
// boards saved before it did (and any written through the API).
export function effectiveGroupBy(
	layout: ViewLayout,
	groupBy: GroupBy,
): GroupBy {
	return layout === "board" && groupBy === "none" ? "priority" : groupBy;
}

// groupTasks skips empty priority buckets (right for list/table), but a
// regroupable priority board needs every column as a drop target: the fixed
// four in P1 -> No priority order, populated columns reused as-is.
export function groupForView(
	tasks: GroupTask[],
	layout: ViewLayout,
	groupBy: GroupBy,
	ctx: GroupCtx,
): TaskGroup[] {
	const by = effectiveGroupBy(layout, groupBy);
	const groups = groupTasks(tasks, by, ctx);
	if (layout !== "board" || by !== "priority") return groups;
	const byKey = new Map(groups.map((g) => [g.key, g]));
	return PRIORITY_ORDER.map(
		(p) =>
			byKey.get(String(p)) ?? {
				key: String(p),
				label: priorityLabel(p),
				tasks: [],
			},
	);
}

// True when any condition, at any depth, filters on `done`. A view that asks
// about completion explicitly shows what it asked for; every other task
// surface keeps completed work out of the way.
export function filterMentionsDone(filter: FilterGroup): boolean {
	const walk = (node: FilterNode): boolean =>
		isGroup(node) ? node.conditions.some(walk) : node.field === "done";
	return walk(filter);
}

export function splitCompleted<T extends { task: { done?: boolean | null } }>(
	entries: readonly T[],
): { open: T[]; done: T[] } {
	const open: T[] = [];
	const done: T[] = [];
	for (const e of entries) (e.task.done ? done : open).push(e);
	return { open, done };
}
