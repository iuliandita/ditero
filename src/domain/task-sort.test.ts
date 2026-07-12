import { describe, expect, test } from "vitest";
import { type SortableTask, sortTasks } from "./task-sort.ts";

const t = (
	sortKey: string,
	done: boolean,
	completedAt: number | null = null,
): SortableTask => ({ sortKey, done, completedAt });

describe("sortTasks: sink", () => {
	test("open by sortKey asc, then done by completedAt desc, appended", () => {
		const tasks = [
			t("c", false),
			t("a", false),
			t("x", true, 100),
			t("b", false),
			t("y", true, 300),
			t("z", true, 200),
		];
		const { visible, completed } = sortTasks(tasks, "sink");
		expect(visible.map((x) => x.sortKey)).toEqual([
			"a",
			"b",
			"c",
			"y",
			"z",
			"x",
		]);
		expect(completed).toEqual([]);
	});
});

describe("sortTasks: keep", () => {
	test("all tasks by sortKey asc regardless of done", () => {
		const tasks = [t("c", true, 100), t("a", false), t("b", true, 200)];
		const { visible, completed } = sortTasks(tasks, "keep");
		expect(visible.map((x) => x.sortKey)).toEqual(["a", "b", "c"]);
		expect(completed).toEqual([]);
	});
});

describe("sortTasks: hide", () => {
	test("open in visible by sortKey asc; done in completed by completedAt desc", () => {
		const tasks = [
			t("c", false),
			t("a", true, 100),
			t("b", false),
			t("d", true, 300),
		];
		const { visible, completed } = sortTasks(tasks, "hide");
		expect(visible.map((x) => x.sortKey)).toEqual(["b", "c"]);
		expect(completed.map((x) => x.sortKey)).toEqual(["d", "a"]);
	});
});

describe("sortTasks: purity", () => {
	test("does not mutate input array or task objects", () => {
		const tasks = [t("b", true, 100), t("a", false)];
		const frozen = tasks.map((x) => Object.freeze({ ...x }));
		expect(() => sortTasks(frozen, "sink")).not.toThrow();
		expect(() => sortTasks(frozen, "keep")).not.toThrow();
		expect(() => sortTasks(frozen, "hide")).not.toThrow();
	});

	test("input array order and reference untouched", () => {
		const tasks = [t("b", true, 100), t("a", false)];
		const copy = [...tasks];
		sortTasks(tasks, "sink");
		expect(tasks).toEqual(copy);
		expect(tasks[0]).toBe(copy[0]);
		expect(tasks[1]).toBe(copy[1]);
	});

	test("sortKey values are never touched by any mode", () => {
		const tasks = [t("b", true, 100), t("a", false), t("c", true, 200)];
		const keys = tasks.map((x) => x.sortKey);
		for (const mode of ["sink", "keep", "hide"] as const) {
			const { visible, completed } = sortTasks(tasks, mode);
			for (const x of [...visible, ...completed]) {
				expect(keys).toContain(x.sortKey);
			}
		}
		expect(tasks.map((x) => x.sortKey)).toEqual(keys);
	});
});

describe("sortTasks: defensive completedAt null", () => {
	test("done task with null completedAt sorts as oldest (deterministically last)", () => {
		const tasks = [t("a", true, 200), t("b", true, null), t("c", true, 100)];
		const { completed } = sortTasks(tasks, "hide");
		expect(completed.map((x) => x.sortKey)).toEqual(["a", "c", "b"]);
	});
});
