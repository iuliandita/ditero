import { describe, expect, test } from "vitest";
import {
	type FilterCtx,
	type FilterGroup,
	type FilterTask,
	resolveWorkspaceScope,
	taskMatchesFilter,
} from "./view-filter.ts";

const now = new Date("2026-07-13T12:00:00Z");
const ctx: FilterCtx = {
	userId: "u1",
	now,
	membershipWorkspaceIds: ["w1", "w2"],
};
const base: FilterTask = {
	id: "t1",
	listId: "l1",
	workspaceId: "w1",
	done: false,
	dueAt: null,
	priority: 0,
	kind: "tasks",
	folderId: null,
	labelIds: [],
	assigneeIds: [],
};

describe("groups", () => {
	test("empty group matches everything", () => {
		expect(taskMatchesFilter(base, { op: "and", conditions: [] }, ctx)).toBe(
			true,
		);
		expect(taskMatchesFilter(base, { op: "or", conditions: [] }, ctx)).toBe(
			true,
		);
	});

	test("and requires every condition; or requires some", () => {
		const cDone: FilterGroup["conditions"][number] = {
			field: "done",
			operator: "is",
			value: true,
		};
		const cKind: FilterGroup["conditions"][number] = {
			field: "kind",
			operator: "eq",
			value: "tasks",
		};
		const and: FilterGroup = { op: "and", conditions: [cDone, cKind] };
		const or: FilterGroup = { op: "or", conditions: [cDone, cKind] };
		// task: done=false, kind=tasks
		expect(taskMatchesFilter(base, and, ctx)).toBe(false);
		expect(taskMatchesFilter(base, or, ctx)).toBe(true);
		expect(taskMatchesFilter({ ...base, done: true }, and, ctx)).toBe(true);
	});

	test("nested groups evaluate recursively", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [
				{ field: "kind", operator: "eq", value: "tasks" },
				{
					op: "or",
					conditions: [
						{ field: "priority", operator: "eq", value: 3 },
						{ field: "done", operator: "is", value: false },
					],
				},
			],
		};
		expect(taskMatchesFilter(base, f, ctx)).toBe(true);
		expect(
			taskMatchesFilter({ ...base, done: true, priority: 0 }, f, ctx),
		).toBe(false);
		expect(
			taskMatchesFilter({ ...base, done: true, priority: 3 }, f, ctx),
		).toBe(true);
	});
});

describe("done", () => {
	test("is boolean", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "done", operator: "is", value: true }],
		};
		expect(taskMatchesFilter({ ...base, done: true }, f, ctx)).toBe(true);
		expect(taskMatchesFilter(base, f, ctx)).toBe(false);
	});
});

describe("due", () => {
	test("overdue = due before today start and not done", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "due", operator: "is", value: "overdue" }],
		};
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-12T09:00:00Z") },
				f,
				ctx,
			),
		).toBe(true);
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-14T09:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
		// not done gate: a completed past task is not overdue
		expect(
			taskMatchesFilter(
				{ ...base, done: true, dueAt: new Date("2026-07-12T09:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
		// null dueAt never overdue
		expect(taskMatchesFilter(base, f, ctx)).toBe(false);
	});

	test("today = within [today-start, today-end)", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "due", operator: "is", value: "today" }],
		};
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-13T00:00:00Z") },
				f,
				ctx,
			),
		).toBe(true);
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-13T23:59:59Z") },
				f,
				ctx,
			),
		).toBe(true);
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-14T00:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-12T23:59:59Z") },
				f,
				ctx,
			),
		).toBe(false);
	});

	test("next7 = within [today-start, today-start+7d)", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "due", operator: "is", value: "next7" }],
		};
		// today counts
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-13T10:00:00Z") },
				f,
				ctx,
			),
		).toBe(true);
		// day 6 within window
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-19T23:00:00Z") },
				f,
				ctx,
			),
		).toBe(true);
		// day 7 start is exclusive upper bound
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-20T00:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
		// yesterday excluded
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-12T23:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
	});

	test("none = dueAt is null", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "due", operator: "is", value: "none" }],
		};
		expect(taskMatchesFilter(base, f, ctx)).toBe(true);
		expect(
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-13T10:00:00Z") },
				f,
				ctx,
			),
		).toBe(false);
	});

	test("before / after ISO date-string", () => {
		const before: FilterGroup = {
			op: "and",
			conditions: [
				{ field: "due", operator: "before", value: "2026-07-13T00:00:00Z" },
			],
		};
		const after: FilterGroup = {
			op: "and",
			conditions: [
				{ field: "due", operator: "after", value: "2026-07-13T00:00:00Z" },
			],
		};
		const past = { ...base, dueAt: new Date("2026-07-10T00:00:00Z") };
		const future = { ...base, dueAt: new Date("2026-07-20T00:00:00Z") };
		expect(taskMatchesFilter(past, before, ctx)).toBe(true);
		expect(taskMatchesFilter(future, before, ctx)).toBe(false);
		expect(taskMatchesFilter(future, after, ctx)).toBe(true);
		expect(taskMatchesFilter(past, after, ctx)).toBe(false);
		// null dueAt never matches before/after
		expect(taskMatchesFilter(base, before, ctx)).toBe(false);
		expect(taskMatchesFilter(base, after, ctx)).toBe(false);
	});
});

describe("priority", () => {
	test("eq / gte / lte numeric", () => {
		const mk = (operator: string, value: number): FilterGroup => ({
			op: "and",
			conditions: [{ field: "priority", operator, value }],
		});
		const p2 = { ...base, priority: 2 };
		expect(taskMatchesFilter(p2, mk("eq", 2), ctx)).toBe(true);
		expect(taskMatchesFilter(p2, mk("eq", 3), ctx)).toBe(false);
		expect(taskMatchesFilter(p2, mk("gte", 2), ctx)).toBe(true);
		expect(taskMatchesFilter(p2, mk("gte", 3), ctx)).toBe(false);
		expect(taskMatchesFilter(p2, mk("lte", 2), ctx)).toBe(true);
		expect(taskMatchesFilter(p2, mk("lte", 1), ctx)).toBe(false);
	});
});

describe("kind", () => {
	test("eq string / in string[]", () => {
		const eq: FilterGroup = {
			op: "and",
			conditions: [{ field: "kind", operator: "eq", value: "shopping" }],
		};
		const inSet: FilterGroup = {
			op: "and",
			conditions: [
				{ field: "kind", operator: "in", value: ["shopping", "project"] },
			],
		};
		expect(taskMatchesFilter({ ...base, kind: "shopping" }, eq, ctx)).toBe(
			true,
		);
		expect(taskMatchesFilter(base, eq, ctx)).toBe(false);
		expect(taskMatchesFilter({ ...base, kind: "project" }, inSet, ctx)).toBe(
			true,
		);
		expect(taskMatchesFilter(base, inSet, ctx)).toBe(false);
	});
});

describe("list", () => {
	test("eq / in over listId", () => {
		const eq: FilterGroup = {
			op: "and",
			conditions: [{ field: "list", operator: "eq", value: "l1" }],
		};
		const inSet: FilterGroup = {
			op: "and",
			conditions: [{ field: "list", operator: "in", value: ["l2", "l1"] }],
		};
		expect(taskMatchesFilter(base, eq, ctx)).toBe(true);
		expect(taskMatchesFilter({ ...base, listId: "l9" }, eq, ctx)).toBe(false);
		expect(taskMatchesFilter(base, inSet, ctx)).toBe(true);
		expect(taskMatchesFilter({ ...base, listId: "l9" }, inSet, ctx)).toBe(
			false,
		);
	});
});

describe("folder", () => {
	test("eq / in; null never matches a concrete id", () => {
		const eq: FilterGroup = {
			op: "and",
			conditions: [{ field: "folder", operator: "eq", value: "f1" }],
		};
		const inSet: FilterGroup = {
			op: "and",
			conditions: [{ field: "folder", operator: "in", value: ["f1", "f2"] }],
		};
		expect(taskMatchesFilter({ ...base, folderId: "f1" }, eq, ctx)).toBe(true);
		expect(taskMatchesFilter(base, eq, ctx)).toBe(false);
		expect(taskMatchesFilter({ ...base, folderId: "f2" }, inSet, ctx)).toBe(
			true,
		);
		expect(taskMatchesFilter(base, inSet, ctx)).toBe(false);
	});
});

describe("label", () => {
	test("includes / excludes membership over labelIds", () => {
		const includes: FilterGroup = {
			op: "and",
			conditions: [{ field: "label", operator: "includes", value: "lab1" }],
		};
		const excludes: FilterGroup = {
			op: "and",
			conditions: [{ field: "label", operator: "excludes", value: "lab1" }],
		};
		expect(
			taskMatchesFilter({ ...base, labelIds: ["lab1"] }, includes, ctx),
		).toBe(true);
		expect(taskMatchesFilter(base, includes, ctx)).toBe(false);
		expect(taskMatchesFilter(base, excludes, ctx)).toBe(true);
		expect(
			taskMatchesFilter({ ...base, labelIds: ["lab1"] }, excludes, ctx),
		).toBe(false);
	});

	test("label 'me' is a literal id, not the current-user token", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "label", operator: "includes", value: "me" }],
		};
		// "me" is a plain labelId here, not the current-user token; it matches only
		// an actual "me" label membership, never ctx.userId.
		expect(taskMatchesFilter({ ...base, labelIds: ["u1"] }, f, ctx)).toBe(
			false,
		);
		expect(taskMatchesFilter({ ...base, labelIds: ["me"] }, f, ctx)).toBe(true);
	});
});

describe("assignee", () => {
	test("me token matches current user's assignment", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "assignee", operator: "includes", value: "me" }],
		};
		expect(taskMatchesFilter({ ...base, assigneeIds: ["u1"] }, f, ctx)).toBe(
			true,
		);
		expect(taskMatchesFilter({ ...base, assigneeIds: ["u2"] }, f, ctx)).toBe(
			false,
		);
	});

	test("explicit userId includes / excludes", () => {
		const includes: FilterGroup = {
			op: "and",
			conditions: [{ field: "assignee", operator: "includes", value: "u2" }],
		};
		const excludes: FilterGroup = {
			op: "and",
			conditions: [{ field: "assignee", operator: "excludes", value: "u2" }],
		};
		expect(
			taskMatchesFilter({ ...base, assigneeIds: ["u2"] }, includes, ctx),
		).toBe(true);
		expect(taskMatchesFilter(base, includes, ctx)).toBe(false);
		expect(taskMatchesFilter(base, excludes, ctx)).toBe(true);
		expect(
			taskMatchesFilter({ ...base, assigneeIds: ["u2"] }, excludes, ctx),
		).toBe(false);
	});

	test("excludes me", () => {
		const f: FilterGroup = {
			op: "and",
			conditions: [{ field: "assignee", operator: "excludes", value: "me" }],
		};
		expect(taskMatchesFilter({ ...base, assigneeIds: ["u1"] }, f, ctx)).toBe(
			false,
		);
		expect(taskMatchesFilter({ ...base, assigneeIds: ["u2"] }, f, ctx)).toBe(
			true,
		);
	});
});

describe("errors", () => {
	test("unknown field throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "bogus", operator: "eq", value: 1 }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow(/field/i);
	});

	test("unknown operator throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "priority", operator: "between", value: 1 }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow(/operator/i);
	});

	test("unknown due literal throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "due", operator: "is", value: "someday" }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow();
	});

	test("priority non-number value throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "priority", operator: "eq", value: "high" }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow(/number/i);
	});

	test("kind 'in' non-array value throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "kind", operator: "in", value: "tasks" }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow(/string\[\]/i);
	});

	test("assignee non-string value throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "assignee", operator: "includes", value: 42 }],
		} as unknown as FilterGroup;
		expect(() => taskMatchesFilter(base, f, ctx)).toThrow(/string/i);
	});

	test("due before with invalid ISO string throws", () => {
		const f = {
			op: "and",
			conditions: [{ field: "due", operator: "before", value: "garbage" }],
		} as unknown as FilterGroup;
		// Bound is validated only after the non-null dueAt gate, so give a dueAt.
		expect(() =>
			taskMatchesFilter(
				{ ...base, dueAt: new Date("2026-07-13T00:00:00Z") },
				f,
				ctx,
			),
		).toThrow(/invalid due date bound/i);
	});
});

describe("resolveWorkspaceScope", () => {
	test("all = every membership", () => {
		expect([...resolveWorkspaceScope({ mode: "all" }, ctx)].sort()).toEqual([
			"w1",
			"w2",
		]);
	});

	test("subset = intersection with memberships", () => {
		expect([
			...resolveWorkspaceScope({ mode: "subset", ids: ["w2", "w9"] }, ctx),
		]).toEqual(["w2"]);
	});

	test("one = intersection with a single id", () => {
		expect([...resolveWorkspaceScope({ mode: "one", id: "w1" }, ctx)]).toEqual([
			"w1",
		]);
		// id not in memberships -> empty (no privilege escalation)
		expect([...resolveWorkspaceScope({ mode: "one", id: "w9" }, ctx)]).toEqual(
			[],
		);
	});
});
