import { describe, expect, it } from "vitest";
import type { FilterCtx, FilterTask } from "../../domain/view-filter.ts";
import { taskMatchesFilter } from "../../domain/view-filter.ts";
import { getBuiltin } from "./builtins.ts";

const NOW = new Date("2026-07-13T12:00:00Z");
const ME = "user-me";

const ctx: FilterCtx = {
	userId: ME,
	now: NOW,
	membershipWorkspaceIds: ["ws-1"],
};

function task(overrides: Partial<FilterTask>): FilterTask {
	return {
		id: "t",
		listId: "l-1",
		workspaceId: "ws-1",
		done: false,
		dueAt: null,
		priority: 0,
		kind: "tasks",
		folderId: null,
		labelIds: [],
		assigneeIds: [],
		...overrides,
	};
}

function filterOf(id: Parameters<typeof getBuiltin>[0]) {
	const b = getBuiltin(id);
	if (!b) throw new Error(`missing builtin ${id}`);
	return b.filter;
}

describe("builtin views", () => {
	it("today matches overdue and due-today, excludes future and undated", () => {
		const filter = filterOf("today");
		const overdue = task({ dueAt: new Date("2026-07-10T09:00:00Z") });
		const dueToday = task({ dueAt: new Date("2026-07-13T20:00:00Z") });
		const nextWeek = task({ dueAt: new Date("2026-07-20T09:00:00Z") });
		const undated = task({ dueAt: null });

		expect(taskMatchesFilter(overdue, filter, ctx)).toBe(true);
		expect(taskMatchesFilter(dueToday, filter, ctx)).toBe(true);
		expect(taskMatchesFilter(nextWeek, filter, ctx)).toBe(false);
		expect(taskMatchesFilter(undated, filter, ctx)).toBe(false);
	});

	it("assigned-to-me matches tasks with me assigned, excludes others", () => {
		const filter = filterOf("assigned-to-me");
		const mine = task({ assigneeIds: [ME, "other"] });
		const theirs = task({ assigneeIds: ["other"] });

		expect(taskMatchesFilter(mine, filter, ctx)).toBe(true);
		expect(taskMatchesFilter(theirs, filter, ctx)).toBe(false);
	});

	it("all-my-tasks matches every task (empty group)", () => {
		const filter = filterOf("all-my-tasks");
		expect(taskMatchesFilter(task({}), filter, ctx)).toBe(true);
		expect(
			taskMatchesFilter(
				task({ dueAt: new Date("2026-07-20T09:00:00Z"), done: true }),
				filter,
				ctx,
			),
		).toBe(true);
	});
});
