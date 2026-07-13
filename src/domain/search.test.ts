import { describe, expect, it } from "vitest";
import { searchTasks } from "./search.ts";

const lists = [
	{ id: "l1", title: "Groceries" },
	{ id: "l2", title: "Work" },
];

const tasks = [
	{ id: "t1", listId: "l1", title: "Buy milk", notes: "whole milk" },
	{ id: "t2", listId: "l2", title: "Ship release", notes: null },
	{ id: "t3", listId: "l1", title: "Apples", notes: "for the milk shake" },
	{ id: "t4", listId: "l2", title: "Standup", notes: "sync with team" },
];

describe("searchTasks", () => {
	it("returns [] for an empty query", () => {
		expect(searchTasks("", tasks, lists)).toEqual([]);
	});

	it("returns [] for a whitespace-only query", () => {
		expect(searchTasks("   ", tasks, lists)).toEqual([]);
	});

	it("matches on title (case-insensitive)", () => {
		const hits = searchTasks("MILK", tasks, lists);
		const t1 = hits.find((h) => h.taskId === "t1");
		expect(t1).toEqual({ taskId: "t1", listId: "l1", matchedField: "title" });
	});

	it("matches on notes", () => {
		const hits = searchTasks("team", tasks, lists);
		expect(hits).toEqual([
			{ taskId: "t4", listId: "l2", matchedField: "notes" },
		]);
	});

	it("surfaces a task via its list-name match", () => {
		const hits = searchTasks("work", tasks, lists);
		const ids = hits.map((h) => h.taskId).sort();
		expect(ids).toEqual(["t2", "t4"]);
		for (const h of hits) {
			expect(h.matchedField).toBe("list");
		}
	});

	it("ranks title match above notes match", () => {
		// "milk" hits t1 title (3), t1 notes (1), t3 notes (1).
		const hits = searchTasks("milk", tasks, lists);
		expect(hits[0]).toEqual({
			taskId: "t1",
			listId: "l1",
			matchedField: "title",
		});
		expect(hits.map((h) => h.taskId)).toEqual(["t1", "t3"]);
	});

	it("keeps the best field per task and dedupes to one hit", () => {
		const hits = searchTasks("milk", tasks, lists);
		expect(hits.filter((h) => h.taskId === "t1")).toHaveLength(1);
	});

	it("prefers list (2) over notes (1) as the matched field", () => {
		const only = [{ id: "l3", title: "milk run" }];
		const t = [{ id: "x", listId: "l3", title: "errand", notes: "buy milk" }];
		expect(searchTasks("milk", t, only)).toEqual([
			{ taskId: "x", listId: "l3", matchedField: "list" },
		]);
	});

	it("still matches title/notes when the task's list is absent from lists", () => {
		const orphan = [
			{ id: "o1", listId: "missing", title: "milk", notes: null },
		];
		expect(searchTasks("milk", orphan, [])).toEqual([
			{ taskId: "o1", listId: "missing", matchedField: "title" },
		]);
	});

	it("sorts by score desc then title asc as a stable tiebreak", () => {
		const t = [
			{ id: "b", listId: "l1", title: "Banana", notes: null },
			{ id: "a", listId: "l1", title: "Avocado", notes: null },
		];
		const l = [{ id: "l1", title: "aaa" }];
		// query "a" hits both titles (score 3); tiebreak by title asc: Avocado, Banana.
		const hits = searchTasks("a", t, l);
		expect(hits.map((h) => h.taskId)).toEqual(["a", "b"]);
	});

	it("trims the query before matching", () => {
		expect(searchTasks("  milk  ", tasks, lists).map((h) => h.taskId)).toEqual([
			"t1",
			"t3",
		]);
	});
});
