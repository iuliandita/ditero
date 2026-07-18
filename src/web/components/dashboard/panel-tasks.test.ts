import { describe, expect, it } from "vitest";
import {
	DEFAULT_PANEL_LIMIT,
	type ResolvedSource,
} from "../../../domain/dashboard.ts";
import type { FilterCtx } from "../../../domain/view-filter.ts";
import { capEntries, matchingTasks } from "./panel-tasks.ts";

const ctx: FilterCtx = {
	userId: "u1",
	now: new Date("2026-07-16T12:00:00Z"),
	membershipWorkspaceIds: ["ws1", "ws2"],
};

function task(
	id: string,
	over: Partial<Parameters<typeof matchingTasks>[0]["tasks"][number]> = {},
) {
	return {
		id,
		listId: "l1",
		title: id,
		done: false,
		dueAt: null,
		priority: 0,
		sortKey: id,
		...over,
	};
}

const lists = [
	{ id: "l1", workspaceId: "ws1", kind: "tasks", folderId: null },
	{ id: "l2", workspaceId: "ws2", kind: "shopping", folderId: null },
	{ id: "l3", workspaceId: "ws3", kind: "tasks", folderId: null },
];

function source(over: Partial<ResolvedSource> = {}): ResolvedSource {
	return {
		filter: { op: "and", conditions: [] },
		sort: { field: "sortKey", dir: "asc" },
		workspaceScope: { mode: "all" },
		...over,
	};
}

function data(tasks: ReturnType<typeof task>[]) {
	return { tasks, lists, labels: [], taskLabels: [], assignees: [] };
}

describe("matchingTasks", () => {
	it("applies the filter AST", () => {
		const out = matchingTasks(
			data([task("a"), task("b", { done: true }), task("c", { priority: 3 })]),
			source({
				filter: {
					op: "and",
					conditions: [
						{ field: "done", operator: "is", value: false },
						{ field: "priority", operator: "gte", value: 3 },
					],
				},
			}),
			ctx,
		);
		expect(out.map((e) => e.task.id)).toEqual(["c"]);
	});

	it("scopes to the resolved workspace set, never beyond memberships", () => {
		const rows = [
			task("a", { listId: "l1" }),
			task("b", { listId: "l2" }),
			task("c", { listId: "l3" }), // ws3: not a membership
		];
		expect(
			matchingTasks(data(rows), source(), ctx).map((e) => e.task.id),
		).toEqual(["a", "b"]);
		expect(
			matchingTasks(
				data(rows),
				source({ workspaceScope: { mode: "one", id: "ws2" } }),
				ctx,
			).map((e) => e.task.id),
		).toEqual(["b"]);
	});

	it("drops tasks whose list is unknown", () => {
		const out = matchingTasks(
			data([task("a"), task("b", { listId: "nope" })]),
			source(),
			ctx,
		);
		expect(out.map((e) => e.task.id)).toEqual(["a"]);
	});

	it("sorts by due with null last on asc, and flips on desc", () => {
		const rows = [
			task("none", { dueAt: null }),
			task("late", { dueAt: 200 }),
			task("early", { dueAt: 100 }),
		];
		expect(
			matchingTasks(
				data(rows),
				source({ sort: { field: "due", dir: "asc" } }),
				ctx,
			).map((e) => e.task.id),
		).toEqual(["early", "late", "none"]);
		expect(
			matchingTasks(
				data(rows),
				source({ sort: { field: "due", dir: "desc" } }),
				ctx,
			).map((e) => e.task.id),
		).toEqual(["none", "late", "early"]);
	});

	it("falls back to sortKey order for unknown sort fields", () => {
		const rows = [task("b"), task("a")];
		expect(
			matchingTasks(
				data(rows),
				source({ sort: { field: "", dir: "asc" } }),
				ctx,
			).map((e) => e.task.id),
		).toEqual(["a", "b"]);
	});

	it("joins list kind and label rows onto each entry", () => {
		const out = matchingTasks(
			{
				tasks: [task("a", { listId: "l2" })],
				lists,
				labels: [{ id: "lb1", name: "urgent" }],
				taskLabels: [
					{ taskId: "a", labelId: "lb1" },
					{ taskId: "a", labelId: "ghost" },
				],
				assignees: [],
			},
			source(),
			ctx,
		);
		expect(out[0].kind).toBe("shopping");
		expect(out[0].labels).toEqual([{ id: "lb1", name: "urgent" }]);
	});

	it("resolves the assignee me token against ctx.userId", () => {
		const out = matchingTasks(
			{
				tasks: [task("mine"), task("other")],
				lists,
				labels: [],
				taskLabels: [],
				assignees: [
					{ taskId: "mine", userId: "u1" },
					{ taskId: "other", userId: "u2" },
				],
			},
			source({
				filter: {
					op: "and",
					conditions: [
						{ field: "assignee", operator: "includes", value: "me" },
					],
				},
			}),
			ctx,
		);
		expect(out.map((e) => e.task.id)).toEqual(["mine"]);
	});
});

describe("capEntries", () => {
	const twelve = Array.from({ length: 12 }, (_, i) => i);

	it("applies DEFAULT_PANEL_LIMIT when the panel has no limit", () => {
		expect(capEntries(twelve, undefined)).toHaveLength(DEFAULT_PANEL_LIMIT);
	});

	it("slices to an explicit limit and never pads", () => {
		expect(capEntries(twelve, 3)).toEqual([0, 1, 2]);
		expect(capEntries([1, 2], 50)).toEqual([1, 2]);
	});
});
