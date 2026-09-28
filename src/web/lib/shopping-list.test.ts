import { expect, test } from "vitest";
import { formatAmount, groupByCategory } from "./shopping-list.ts";

const item = (id: string, category?: string | null) => ({ id, category });
const keys = (r: ReturnType<typeof groupByCategory>) =>
	r.groups.map(([key, items]) => [
		key,
		items.map((i) => (i as { id: string }).id),
	]);

test("a list with no categories is one headerless group", () => {
	const r = groupByCategory([item("a"), item("b", "  "), item("c", null)]);
	expect(r.showHeaders).toBe(false);
	expect(keys(r)).toEqual([["", ["a", "b", "c"]]]);
});

test("real categories keep first-seen order and push uncategorized last", () => {
	const r = groupByCategory([
		item("a"),
		item("b", "Dairy"),
		item("c", "Produce"),
		item("d", "Dairy"),
	]);
	expect(r.showHeaders).toBe(true);
	expect(keys(r)).toEqual([
		["Dairy", ["b", "d"]],
		["Produce", ["c"]],
		["", ["a"]],
	]);
});

test("a single real category still gets its header", () => {
	expect(groupByCategory([item("a", "Dairy")]).showHeaders).toBe(true);
});

test("formatAmount joins whichever parts are set", () => {
	expect(formatAmount("2", "L")).toBe("2 L");
	expect(formatAmount("3", null)).toBe("3");
	expect(formatAmount("", "kg")).toBe("kg");
	expect(formatAmount(" ", undefined)).toBe("");
	expect(formatAmount(null, null)).toBe("");
});
