import { describe, expect, test } from "vitest";
import {
	EMPTY_SELECTION,
	liveSelection,
	type Selection,
	type SelectionEvent,
	selectionReducer,
} from "./selection.ts";

const ORDER = ["a", "b", "c", "d", "e"];

function run(...events: SelectionEvent[]): Selection {
	return events.reduce(selectionReducer, EMPTY_SELECTION);
}

describe("selectionReducer", () => {
	test("toggle adds and removes one row", () => {
		expect(run({ type: "toggle", id: "b" }).ids).toEqual(["b"]);
		expect(
			run({ type: "toggle", id: "b" }, { type: "toggle", id: "d" }).ids,
		).toEqual(["b", "d"]);
		expect(
			run({ type: "toggle", id: "b" }, { type: "toggle", id: "b" }),
		).toEqual(EMPTY_SELECTION);
	});

	test("extend selects the range from the anchor", () => {
		const s = run(
			{ type: "toggle", id: "b" },
			{ type: "extend", order: ORDER, to: "d" },
		);
		expect(s.ids).toEqual(["b", "c", "d"]);
		expect(s.anchor).toBe("b");
	});

	test("extending back toward the anchor shrinks the range", () => {
		const s = run(
			{ type: "toggle", id: "b" },
			{ type: "extend", order: ORDER, to: "e" },
			{ type: "extend", order: ORDER, to: "c" },
		);
		expect(s.ids).toEqual(["b", "c"]);
	});

	test("a range keeps rows chosen before it and works upward", () => {
		const s = run(
			{ type: "toggle", id: "e" },
			{ type: "toggle", id: "c" },
			{ type: "extend", order: ORDER, to: "a" },
		);
		expect([...s.ids].sort()).toEqual(["a", "b", "c", "e"]);
	});

	test("extend without an anchor selects just the target", () => {
		const s = run({ type: "extend", order: ORDER, to: "c" });
		expect(s.ids).toEqual(["c"]);
		expect(s.anchor).toBe("c");
	});

	test("extend to a row outside the order changes nothing", () => {
		const before = run({ type: "toggle", id: "a" });
		expect(
			selectionReducer(before, { type: "extend", order: ORDER, to: "zz" }),
		).toBe(before);
	});

	test("all and clear", () => {
		expect(run({ type: "all", order: ORDER }).ids).toEqual(ORDER);
		expect(run({ type: "all", order: [] })).toEqual(EMPTY_SELECTION);
		expect(run({ type: "all", order: ORDER }, { type: "clear" })).toEqual(
			EMPTY_SELECTION,
		);
	});

	test("liveSelection drops rows that are gone", () => {
		const s = run({ type: "all", order: ORDER });
		expect(liveSelection(s, new Set(["a", "c", "x"]))).toEqual(["a", "c"]);
	});
});
