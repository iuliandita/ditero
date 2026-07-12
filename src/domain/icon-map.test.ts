import { describe, expect, test } from "vitest";
import { suggestIcon } from "./icon-map.ts";

describe("suggestIcon: per-kind defaults", () => {
	test.each([
		["tasks", "check"],
		["shopping", "shopping-basket"],
		["checklist", "list-checks"],
		["project", "folder-kanban"],
		["habits", "repeat"],
	] as const)("kind=%s, no keyword hit -> %s", (kind, icon) => {
		expect(suggestIcon("Untitled list", kind)).toBe(icon);
	});
});

describe("suggestIcon: keyword hits", () => {
	test.each([
		["Groceries", "shopping-cart"],
		["Weekly market run", "shopping-cart"],
		["Gym plan", "dumbbell"],
		["Workout log", "dumbbell"],
		["Summer trip", "plane"],
		["Travel checklist", "plane"],
		["Take meds", "pill"],
		["Pills reminder", "pill"],
		["Walk the dog", "paw-print"],
		["Pet care", "paw-print"],
		["Book to read", "book-open"],
		["Reading list", "book-open"],
		["Work tasks", "briefcase"],
		["Home chores", "house"],
		["Birthday party", "cake"],
		["Movie night", "clapperboard"],
		["Clean the house", "spray-can"],
		["Car maintenance", "car"],
		["Garden plants", "sprout"],
		["Music practice", "music"],
		["Code review", "code"],
		["Call mom", "phone"],
		["Phone bills", "phone"],
		["Email inbox", "mail"],
		["Pay rent", "wallet"],
		["Drink water", "droplet"],
	] as const)("title=%s -> %s", (title, icon) => {
		expect(suggestIcon(title, "tasks")).toBe(icon);
	});

	test("case-insensitive match", () => {
		expect(suggestIcon("GROCERIES run", "tasks")).toBe("shopping-cart");
	});

	test("substring match within a word", () => {
		expect(suggestIcon("regroceries stock", "tasks")).toBe("shopping-cart");
	});

	test("keyword hit overrides per-kind default", () => {
		expect(suggestIcon("Gym", "shopping")).toBe("dumbbell");
	});

	test("first-matching keyword by table order wins", () => {
		expect(suggestIcon("Gym trip", "tasks")).toBe("dumbbell");
	});

	test("no keyword hit falls back to kind default", () => {
		expect(suggestIcon("Miscellaneous stuff", "checklist")).toBe("list-checks");
	});

	test("empty title falls back to kind default", () => {
		expect(suggestIcon("", "habits")).toBe("repeat");
	});
});
