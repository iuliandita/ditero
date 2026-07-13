import { describe, expect, it } from "vitest";
import type { GroupCtx, GroupTask } from "./group.ts";
import { groupTasks } from "./group.ts";

const NOW = new Date("2026-07-13T12:00:00Z");

const ctx: GroupCtx = {
	now: NOW,
	listTitle: (id) => ({ "l-a": "Alpha", "l-b": "Beta" })[id] ?? id,
	memberName: (id) => ({ "u-1": "Ann", "u-2": "Bob" })[id] ?? id,
	labelName: (id) => ({ "lb-1": "Red", "lb-2": "Green" })[id] ?? id,
};

function task(overrides: Partial<GroupTask>): GroupTask {
	return {
		id: "t",
		listId: "l-a",
		title: "T",
		done: false,
		dueAt: null,
		priority: 0,
		assigneeIds: [],
		labelIds: [],
		...overrides,
	};
}

describe("groupTasks", () => {
	it("none returns a single passthrough group preserving order", () => {
		const tasks = [task({ id: "a" }), task({ id: "b" })];
		const groups = groupTasks(tasks, "none", ctx);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ key: "all", label: "" });
		expect(groups[0].tasks.map((t) => t.id)).toEqual(["a", "b"]);
	});

	it("status always emits Open then Done, including empty", () => {
		const groups = groupTasks([task({ id: "a", done: false })], "status", ctx);
		expect(groups.map((g) => g.label)).toEqual(["Open", "Done"]);
		expect(groups[0].tasks.map((t) => t.id)).toEqual(["a"]);
		expect(groups[1].tasks).toEqual([]);
	});

	it("priority orders High->None and skips empty priorities", () => {
		const tasks = [
			task({ id: "hi", priority: 3 }),
			task({ id: "lo", priority: 1 }),
			task({ id: "none", priority: 0 }),
		];
		const groups = groupTasks(tasks, "priority", ctx);
		expect(groups.map((g) => g.label)).toEqual(["High", "Low", "None"]);
		expect(groups.map((g) => g.key)).toEqual(["3", "1", "0"]);
	});

	it("priority treats out-of-range priority as None", () => {
		const groups = groupTasks(
			[task({ id: "x", priority: 9 })],
			"priority",
			ctx,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("None");
	});

	it("assignee fans out multi-assignee tasks and trails Unassigned", () => {
		const tasks = [
			task({ id: "shared", assigneeIds: ["u-2", "u-1"] }),
			task({ id: "solo", assigneeIds: ["u-1"] }),
			task({ id: "none" }),
		];
		const groups = groupTasks(tasks, "assignee", ctx);
		// Ann (u-1) before Bob (u-2) by name, Unassigned last.
		expect(groups.map((g) => g.label)).toEqual(["Ann", "Bob", "Unassigned"]);
		expect(groups[0].tasks.map((t) => t.id)).toEqual(["shared", "solo"]);
		expect(groups[1].tasks.map((t) => t.id)).toEqual(["shared"]);
		expect(groups[2].tasks.map((t) => t.id)).toEqual(["none"]);
	});

	it("assignee omits Unassigned when everything is assigned", () => {
		const groups = groupTasks(
			[task({ id: "a", assigneeIds: ["u-1"] })],
			"assignee",
			ctx,
		);
		expect(groups.map((g) => g.label)).toEqual(["Ann"]);
	});

	it("label fans out multi-label tasks and trails No label", () => {
		const tasks = [
			task({ id: "both", labelIds: ["lb-2", "lb-1"] }),
			task({ id: "none" }),
		];
		const groups = groupTasks(tasks, "label", ctx);
		expect(groups.map((g) => g.label)).toEqual(["Green", "Red", "No label"]);
		expect(groups[0].tasks.map((t) => t.id)).toEqual(["both"]);
		expect(groups[1].tasks.map((t) => t.id)).toEqual(["both"]);
	});

	it("list groups by listId ordered by title", () => {
		const tasks = [
			task({ id: "b1", listId: "l-b" }),
			task({ id: "a1", listId: "l-a" }),
		];
		const groups = groupTasks(tasks, "list", ctx);
		expect(groups.map((g) => g.label)).toEqual(["Alpha", "Beta"]);
		expect(groups[0].tasks.map((t) => t.id)).toEqual(["a1"]);
	});

	it("due buckets by boundary and orders Overdue->No date", () => {
		const tasks = [
			task({ id: "later", dueAt: new Date("2026-07-25T09:00:00Z") }),
			task({ id: "overdue", dueAt: new Date("2026-07-10T09:00:00Z") }),
			task({ id: "today", dueAt: new Date("2026-07-13T23:00:00Z") }),
			task({ id: "next7", dueAt: new Date("2026-07-16T09:00:00Z") }),
			task({ id: "nodate", dueAt: null }),
		];
		const groups = groupTasks(tasks, "due", ctx);
		expect(groups.map((g) => g.key)).toEqual([
			"overdue",
			"today",
			"next7",
			"later",
			"none",
		]);
		expect(groups.map((g) => g.tasks[0].id)).toEqual([
			"overdue",
			"today",
			"next7",
			"later",
			"nodate",
		]);
	});

	it("due skips empty buckets", () => {
		const groups = groupTasks([task({ id: "x", dueAt: null })], "due", ctx);
		expect(groups.map((g) => g.key)).toEqual(["none"]);
	});
});
