import { describe, expect, test } from "vitest";
import type { FilterField } from "../../../domain/view-filter.ts";
import { FIELD_METAS, metaFor } from "./filter-options.ts";

const ALL_FIELDS: FilterField[] = [
	"done",
	"due",
	"priority",
	"kind",
	"list",
	"folder",
	"label",
	"assignee",
];

describe("FIELD_METAS coverage", () => {
	test("covers every FilterField exactly once", () => {
		const fields = FIELD_METAS.map((m) => m.field);
		expect(new Set(fields).size).toBe(fields.length);
		expect(new Set(fields)).toEqual(new Set(ALL_FIELDS));
		expect(fields.length).toBe(ALL_FIELDS.length);
	});

	test("every field declares at least one operator", () => {
		for (const meta of FIELD_METAS) {
			expect(meta.operators.length).toBeGreaterThan(0);
			expect(meta.label.length).toBeGreaterThan(0);
		}
	});
});

describe("metaFor", () => {
	test("returns the meta for each field", () => {
		for (const field of ALL_FIELDS) {
			expect(metaFor(field).field).toBe(field);
		}
	});

	test("throws for an unknown field", () => {
		expect(() => metaFor("nope" as FilterField)).toThrow();
	});
});

describe("controlFor totality", () => {
	test("returns a control for every declared operator", () => {
		for (const meta of FIELD_METAS) {
			for (const op of meta.operators) {
				const control = meta.controlFor(op.value);
				expect(control).toBeTruthy();
				expect(typeof control.kind).toBe("string");
			}
		}
	});
});

describe("data-backed controls", () => {
	test("assignee resolves to the assignee control", () => {
		const meta = metaFor("assignee");
		for (const op of meta.operators) {
			expect(meta.controlFor(op.value).kind).toBe("assignee");
		}
	});

	test("label resolves to the label control", () => {
		const meta = metaFor("label");
		for (const op of meta.operators) {
			expect(meta.controlFor(op.value).kind).toBe("label");
		}
	});

	test("list and folder resolve to their own controls", () => {
		expect(metaFor("list").controlFor("eq").kind).toBe("list");
		expect(metaFor("list").controlFor("in").kind).toBe("list");
		expect(metaFor("folder").controlFor("eq").kind).toBe("folder");
		expect(metaFor("folder").controlFor("in").kind).toBe("folder");
	});
});

describe("due switches control by operator", () => {
	const due = metaFor("due");

	test("is -> select over the due literals", () => {
		const control = due.controlFor("is");
		expect(control.kind).toBe("select");
		if (control.kind !== "select") throw new Error("unreachable");
		expect(control.options.map((o) => o.value)).toEqual([
			"today",
			"overdue",
			"next7",
			"none",
		]);
	});

	test("before/after -> date", () => {
		expect(due.controlFor("before").kind).toBe("date");
		expect(due.controlFor("after").kind).toBe("date");
	});
});

describe("static selects", () => {
	test("done uses a bool control", () => {
		expect(metaFor("done").controlFor("is").kind).toBe("bool");
	});

	test("priority select carries 0..3 string options", () => {
		const control = metaFor("priority").controlFor("eq");
		expect(control.kind).toBe("select");
		if (control.kind !== "select") throw new Error("unreachable");
		expect(control.options.map((o) => o.value)).toEqual(["0", "1", "2", "3"]);
	});

	test("kind select carries the five list kinds", () => {
		const control = metaFor("kind").controlFor("eq");
		expect(control.kind).toBe("select");
		if (control.kind !== "select") throw new Error("unreachable");
		expect(control.options.map((o) => o.value)).toEqual([
			"tasks",
			"shopping",
			"checklist",
			"project",
			"habits",
		]);
	});
});
