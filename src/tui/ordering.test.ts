import { describe, expect, it } from "vitest";
import { CliError } from "../cli/arguments.ts";
import type { ApiTask } from "../domain/public-api-resources.ts";
import {
	type ListObservation,
	MAX_ORDER_ROWS,
	orderWindow,
	type PlacementObservation,
	parsePosition,
	planOrdering,
	proposeOrdering,
	typePosition,
} from "./ordering.ts";

const row = (id: string, sortKey: string, extra: Partial<ApiTask> = {}) => ({
	id,
	listId: "list",
	workspaceId: "workspace",
	title: `Task ${id}`,
	done: false,
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	completedAt: null,
	createdAt: null,
	sortKey,
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: null,
	recurrenceRelative: false,
	reminderTime: null,
	assigneeIds: [],
	labelIds: [],
	...extra,
});
const listRow = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "Groceries",
	kind: "tasks" as const,
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink" as const,
};
const observed = (
	taskId: string,
	sortKey: string,
	parentId: string | null = null,
): PlacementObservation => ({
	snapshot: {
		version: 1,
		task: {
			version: 1,
			taskId,
			listId: "list",
			workspaceId: "workspace",
			title: `Task ${taskId}`,
			notes: null,
			dueAt: null,
			dueAllDay: false,
			priority: 0,
			createdAt: null,
			done: false,
			completedAt: null,
			listKind: "tasks",
			rrule: null,
			recurrenceRelative: false,
			recurrenceAnchorAt: null,
			recurrenceConsumed: null,
		},
		sortKey,
		parentId,
		list: listRow,
	},
	stateToken: "c".repeat(64),
	childrenState: { version: 1, count: 2, token: "b".repeat(64) },
});
const list: ListObservation = {
	snapshot: listRow,
	stateToken: "d".repeat(64),
};
const base = [
	row("z", "a0"),
	row("y", "a1", { done: true }),
	row("x", "a2"),
	row("w", "a3"),
];
const plan = (
	rows: ApiTask[] = base,
	taskId = "x",
	placement = observed(taskId, "a2"),
	observation = list,
) =>
	planOrdering({ rows, taskId, listId: "list", placement, list: observation });
const code = (action: () => unknown) => {
	try {
		action();
	} catch (error) {
		if (error instanceof CliError) return error.code;
		throw error;
	}
	return undefined;
};

describe("ordering plan", () => {
	it("sorts the exact-parent group by key, counting done rows", () => {
		const result = plan([base[3], base[1], base[2], base[0]]);
		expect(result.siblings.map((s) => s.id)).toEqual(["z", "y", "x", "w"]);
		expect(result.index).toBe(2);
		expect(result.siblings[1].done).toBe(true);
		expect(result.childCount).toBe(2);
		expect(result.listToken).toBe("d".repeat(64));
		expect(result.placementToken).toBe("c".repeat(64));
	});
	it("keeps subtasks and root groups apart", () => {
		const rows = [
			row("p", "a0"),
			row("q", "a1"),
			row("s1", "a0", { parentId: "p" }),
			row("s2", "a1", { parentId: "p" }),
		];
		expect(
			plan(rows, "s2", observed("s2", "a1", "p")).siblings.map((s) => s.id),
		).toEqual(["s1", "s2"]);
		expect(
			plan(rows, "q", observed("q", "a1")).siblings.map((s) => s.id),
		).toEqual(["p", "q"]);
	});
	it.each([
		["missing selected", base.filter((r) => r.id !== "x"), "ordering_stale"],
		[
			"moved selected",
			[...base.slice(0, 2), row("x", "a5"), base[3]],
			"ordering_stale",
		],
		["duplicate ID", [...base, row("x", "a9")], "ordering_duplicate"],
		[
			"foreign list",
			[...base, row("f", "a9", { listId: "other" })],
			"ordering_scope",
		],
		[
			"foreign workspace",
			[...base, row("f", "a9", { workspaceId: "other" })],
			"ordering_scope",
		],
		["tied keys", [...base, row("t", "a1")], "ordering_tied"],
		["malformed key", [...base, row("m", "0")], "ordering_malformed"],
		[
			"overlong key",
			[...base, row("m", `a${"1".repeat(256)}`)],
			"ordering_malformed",
		],
		["alone", [row("x", "a2")], "ordering_single"],
	])("refuses %s", (_name, rows, expected) => {
		expect(code(() => plan(rows))).toBe(expected);
	});
	it("does not let another group's keys affect the selected group", () => {
		const rows = [...base, row("s", "!!", { parentId: "w" })];
		expect(plan(rows).siblings.map((s) => s.id)).toEqual(["z", "y", "x", "w"]);
	});
	it("refuses observation and list mismatches", () => {
		expect(code(() => plan(base, "x", observed("x", "a9")))).toBe(
			"ordering_stale",
		);
		expect(code(() => plan(base, "x", observed("y", "a2")))).toBe(
			"ordering_stale",
		);
		expect(
			code(() =>
				plan(base, "x", observed("x", "a2"), {
					...list,
					snapshot: { ...listRow, title: "Changed" },
				}),
			),
		).toBe("ordering_stale");
		expect(
			code(() =>
				plan(base, "x", observed("x", "a2"), {
					...list,
					snapshot: { ...listRow, id: "other" },
				}),
			),
		).toBe("ordering_stale");
	});
	it("accepts a selected row equal to the placement observation", () => {
		expect(plan().title).toBe("Task x");
	});
	it.each([
		["listId", { listId: "other" }],
		["workspaceId", { workspaceId: "other" }],
		["title", { title: "Renamed" }],
		["notes", { notes: "changed" }],
		["dueAt", { dueAt: "2030-01-01T00:00:00.000Z" }],
		["dueAllDay", { dueAllDay: true }],
		["priority", { priority: 3 }],
		["createdAt", { createdAt: "2030-01-01T00:00:00.000Z" }],
		["done", { done: true }],
		["completedAt", { completedAt: "2030-01-01T00:00:00.000Z" }],
		["rrule", { rrule: "FREQ=DAILY" }],
		["recurrenceRelative", { recurrenceRelative: true }],
		["listKind", { listKind: "shopping" as never }],
	])("refuses an observation whose task %s differs", (_name, change) => {
		const placement = observed("x", "a2");
		const changed = {
			...placement,
			snapshot: {
				...placement.snapshot,
				task: { ...placement.snapshot.task, ...change },
			},
		};
		expect(code(() => plan(base, "x", changed))).toBe("ordering_stale");
	});
	it.each([
		["notes", { notes: "changed" }],
		["dueAt", { dueAt: "2030-01-01T00:00:00.000Z" }],
		["dueAllDay", { dueAllDay: true }],
		["priority", { priority: 3 }],
		["createdAt", { createdAt: "2030-01-01T00:00:00.000Z" }],
		["done", { done: true }],
		["completedAt", { completedAt: "2030-01-01T00:00:00.000Z" }],
		["rrule", { rrule: "FREQ=DAILY" }],
		["recurrenceRelative", { recurrenceRelative: true }],
	])("refuses a selected row whose %s differs from the observation", (_name, change) => {
		const rows = [base[0], base[1], row("x", "a2", change), base[3]];
		expect(code(() => plan(rows))).toBe("ordering_stale");
	});
	it("refuses a selected row whose title differs from the observation", () => {
		const rows = [
			base[0],
			base[1],
			row("x", "a2", { title: "Renamed" }),
			base[3],
		];
		expect(code(() => plan(rows))).toBe("ordering_stale");
	});
	it("refuses a task list kind that differs from the list observation", () => {
		const shopping = { ...listRow, kind: "shopping" as never };
		const placement = observed("x", "a2");
		const changed = {
			...placement,
			snapshot: { ...placement.snapshot, list: shopping },
		};
		expect(
			code(() => plan(base, "x", changed, { ...list, snapshot: shopping })),
		).toBe("ordering_stale");
	});
	it("refuses collections beyond the page bound", () => {
		const rows = Array.from({ length: MAX_ORDER_ROWS + 1 }, (_, i) =>
			row(`id${i}`, "a0"),
		);
		expect(code(() => plan(rows))).toBe("ordering_bounds");
	});
	it("refuses a subtask whose parent is not in the list", () => {
		const rows = [
			row("s1", "a0", { parentId: "gone" }),
			row("s2", "a1", { parentId: "gone" }),
		];
		expect(code(() => plan(rows, "s2", observed("s2", "a1", "gone")))).toBe(
			"ordering_stale",
		);
	});
	it("windows around the task with a bounded size", () => {
		const { start, items } = orderWindow(plan(), 1);
		expect(start).toBe(1);
		expect(items.map((s) => s.id)).toEqual(["y", "x", "w"]);
	});
});

describe("ordering proposal", () => {
	it.each([
		[1, null, "z"],
		[2, "z", "y"],
		[4, "w", null],
	])("places the task at position %i between its new neighbors", (position, after, before) => {
		const current = plan(base, "x");
		const proposal = proposeOrdering(current, position);
		expect(proposal.order.after?.id ?? null).toBe(after);
		expect(proposal.order.before?.id ?? null).toBe(before);
		expect(proposal.order.from).toBe(3);
		expect(proposal.order.total).toBe(4);
		const { key } = proposal.order;
		if (proposal.order.after)
			expect(proposal.order.after.sortKey < key).toBe(true);
		if (proposal.order.before)
			expect(key < proposal.order.before.sortKey).toBe(true);
		expect(proposal.body).toEqual({
			workspaceId: "workspace",
			listId: "list",
			expectedState: "c".repeat(64),
			targetListId: "list",
			expectedTargetState: "d".repeat(64),
			sortKey: key,
			cascadeChildren: false,
			expectedChildrenState: null,
		});
		expect(Object.isFrozen(proposal.body)).toBe(true);
	});
	it("refuses unchanged and out-of-range positions without generating a key", () => {
		const generate = () => {
			throw new Error("must not run");
		};
		const current = plan(base, "x");
		expect(code(() => proposeOrdering(current, 3, generate))).toBe(
			"ordering_unchanged",
		);
		expect(code(() => proposeOrdering(current, 0, generate))).toBe(
			"invalid_input",
		);
		expect(code(() => proposeOrdering(current, 5, generate))).toBe(
			"invalid_input",
		);
		expect(code(() => proposeOrdering(current, 1.5, generate))).toBe(
			"invalid_input",
		);
	});
	it.each([
		[
			"throws",
			() => {
				throw new Error("bad");
			},
		],
		["outside bounds", () => "a9"],
		["malformed", () => "0"],
		["too long", () => `a${"1".repeat(256)}`],
	])("refuses a generated key that %s", (_name, generate) => {
		expect(code(() => proposeOrdering(plan(base, "x"), 1, generate))).toBe(
			"ordering_key",
		);
	});
	it("freezes the supplied key in the proposal", () => {
		const proposal = proposeOrdering(plan(base, "x"), 1, () => "Zz5");
		expect(proposal.order.key).toBe("Zz5");
		expect(proposal.body.sortKey).toBe("Zz5");
	});
});

describe("typed position", () => {
	it("accepts only digits within 1..total", () => {
		expect(typePosition("", "1", 120)).toBe("1");
		expect(typePosition("1", "2", 120)).toBe("12");
		expect(typePosition("12", "3", 120)).toBe("12");
		expect(typePosition("", "0", 120)).toBe("");
		expect(typePosition("", "x", 120)).toBe("");
		expect(typePosition("1", "2x", 120)).toBe("1");
		expect(typePosition("", "٣", 120)).toBe("");
	});
	it("parses a complete in-range position", () => {
		expect(parsePosition("12", 120)).toBe(12);
		expect(parsePosition("", 120)).toBeNull();
		expect(parsePosition("0", 120)).toBeNull();
		expect(parsePosition("121", 120)).toBeNull();
		expect(parsePosition("01", 120)).toBeNull();
	});
});
