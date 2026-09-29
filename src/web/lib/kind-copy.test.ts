import { expect, test } from "vitest";
import { addCopyFor } from "./kind-copy.ts";

test("each kind names what its add field creates", () => {
	const copy = (kind: Parameters<typeof addCopyFor>[0]) => {
		const c = addCopyFor(kind);
		return [c.placeholder(), c.action()];
	};
	expect(copy("tasks")).toEqual(["Add a task", "Add task"]);
	expect(copy("project")).toEqual(["Add a task", "Add task"]);
	expect(copy(null)).toEqual(["Add a task", "Add task"]);
	expect(copy("shopping")).toEqual(["Add an item", "Add item"]);
	expect(copy("checklist")).toEqual(["Add an item", "Add item"]);
	expect(copy("habits")).toEqual(["Add a habit", "Add habit"]);
});
