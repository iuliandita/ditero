import { describe, expect, test } from "vitest";
import { listRowsLoading } from "./list-loading.ts";

const cached = {
	listId: "selected",
	lists: [{ id: "selected" }],
	tasks: [{ listId: "selected", parentId: null }],
	listsType: "unknown",
	tasksType: "unknown",
} as const;

describe("listRowsLoading", () => {
	test.each([
		["unknown", "unknown"],
		["complete", "unknown"],
		["unknown", "complete"],
	] as const)("renders cached roots with %s lists and %s tasks", (listsType, tasksType) => {
		expect(listRowsLoading({ ...cached, listsType, tasksType })).toBe(false);
	});

	test("renders cached roots with an omitted parentId", () => {
		expect(
			listRowsLoading({ ...cached, tasks: [{ listId: "selected" }] }),
		).toBe(false);
	});

	test("waits when the selected list is missing from the cache", () => {
		expect(listRowsLoading({ ...cached, lists: [{ id: "other" }] })).toBe(true);
	});

	test("waits when cached roots belong to another list", () => {
		expect(
			listRowsLoading({
				...cached,
				tasks: [{ listId: "other", parentId: null }],
			}),
		).toBe(true);
	});

	test.each([
		["unknown", "unknown"],
		["complete", "unknown"],
		["unknown", "complete"],
	] as const)("waits on empty rows with %s lists and %s tasks", (listsType, tasksType) => {
		expect(
			listRowsLoading({ ...cached, tasks: [], listsType, tasksType }),
		).toBe(true);
	});

	test("waits when only selected-list children are cached", () => {
		expect(
			listRowsLoading({
				...cached,
				tasks: [{ listId: "selected", parentId: "root" }],
			}),
		).toBe(true);
	});

	test.each([
		["error", "unknown"],
		["complete", "error"],
		["error", "complete"],
	] as const)("waits on query errors with %s lists and %s tasks", (listsType, tasksType) => {
		expect(listRowsLoading({ ...cached, listsType, tasksType })).toBe(true);
	});

	test("renders an authoritative empty list", () => {
		expect(
			listRowsLoading({
				...cached,
				tasks: [],
				listsType: "complete",
				tasksType: "complete",
			}),
		).toBe(false);
	});
});
