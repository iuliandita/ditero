import { expect, test } from "vitest";
import { workspaceViewRowsLoading } from "./useWorkspaceData.ts";

const cached = {
	tasks: [{ listId: "list-1" }],
	lists: [{ id: "list-1", workspaceId: "workspace-1" }],
	workspaces: [{ id: "workspace-1" }],
	tasksType: "unknown" as const,
	listsType: "unknown" as const,
};

test("joined cached rows render while offline queries remain unknown", () => {
	expect(workspaceViewRowsLoading(cached)).toBe(false);
	expect(workspaceViewRowsLoading({ ...cached, tasksType: "complete" })).toBe(
		false,
	);
});

test("unknown empty, one-sided, and partially joined caches retain loading", () => {
	expect(
		workspaceViewRowsLoading({
			...cached,
			tasks: [],
			lists: [],
			workspaces: [],
		}),
	).toBe(true);
	expect(workspaceViewRowsLoading({ ...cached, tasks: [] })).toBe(true);
	expect(workspaceViewRowsLoading({ ...cached, lists: [] })).toBe(true);
	expect(workspaceViewRowsLoading({ ...cached, workspaces: [] })).toBe(true);
	expect(
		workspaceViewRowsLoading({
			...cached,
			tasks: [{ listId: "missing-list" }],
		}),
	).toBe(true);
	expect(
		workspaceViewRowsLoading({
			...cached,
			tasks: [...cached.tasks, { listId: "missing-list" }],
		}),
	).toBe(true);
	expect(
		workspaceViewRowsLoading({
			...cached,
			lists: [{ id: "list-1", workspaceId: "missing-workspace" }],
		}),
	).toBe(true);
});

test("complete empty results render empty, while query errors retain loading", () => {
	expect(
		workspaceViewRowsLoading({
			...cached,
			tasks: [],
			lists: [],
			tasksType: "complete",
			listsType: "complete",
		}),
	).toBe(false);
	expect(workspaceViewRowsLoading({ ...cached, tasksType: "error" })).toBe(
		true,
	);
	expect(workspaceViewRowsLoading({ ...cached, listsType: "error" })).toBe(
		true,
	);
});
