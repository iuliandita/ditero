import { describe, expect, test } from "vitest";
import type { Role } from "../../../domain/role.ts";
import { snapshotTask } from "../../../domain/template.ts";
import type { Task } from "../../../zero/schema.gen.ts";
import { taskActions } from "./taskActions.ts";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		listId: "l1",
		parentId: null,
		title: "Pack the bag",
		sortKey: "a0",
		done: false,
		priority: null,
		...overrides,
	} as Task;
}

function build(role: Role | null) {
	const saved: Task[] = [];
	const actions = taskActions({
		task: task(),
		kind: "tasks",
		role,
		handlers: {
			open: () => {},
			schedule: () => {},
			pickDate: undefined,
			setPriority: () => {},
			saveAsTemplate: (t) => saved.push(t),
			remove: () => {},
		},
	});
	return { actions, saved };
}

describe("taskActions save-as-template", () => {
	test("a write role gets the entry, and it hands the task to the handler", () => {
		const { actions, saved } = build("member");
		const entry = actions.find((a) => a.id === "save-as-template");
		expect(entry?.hidden).toBeFalsy();
		entry?.onSelect?.();
		expect(saved.map((t) => t.id)).toEqual(["t1"]);
	});

	test("a viewer does not, because template.save requires a write role", () => {
		const { actions } = build("viewer");
		expect(actions.find((a) => a.id === "save-as-template")?.hidden).toBe(true);
	});

	// Checklists drop due/priority from the menu; saving one as a template is
	// still a plain write, so the entry stays.
	test("survives the checklist bare menu", () => {
		const actions = taskActions({
			task: task(),
			kind: "checklist",
			role: "member",
			handlers: {
				open: () => {},
				schedule: () => {},
				pickDate: undefined,
				setPriority: () => {},
				saveAsTemplate: () => {},
				remove: () => {},
			},
		});
		expect(
			actions.find((a) => a.id === "save-as-template")?.hidden,
		).toBeFalsy();
	});
});

describe("the content the save path snapshots", () => {
	// TaskRow feeds snapshotTask the task plus its synced children; template.save
	// rejects a kind that disagrees with its content, so a "list" here would be
	// refused server-side.
	test("is a task template carrying one level of subtasks", () => {
		const parent = task({ id: "p1", title: "Trip" });
		const subs = [
			task({ id: "s1", parentId: "p1", title: "Passport", sortKey: "a1" }),
			task({ id: "s2", parentId: "p1", title: "Charger", sortKey: "a2" }),
		];
		const content = snapshotTask(parent, subs);
		expect(content.kind).toBe("task");
		if (content.kind !== "task") return;
		expect(content.task.title).toBe("Trip");
		expect(content.task.subtasks?.map((s) => s.title)).toEqual([
			"Passport",
			"Charger",
		]);
	});
});
