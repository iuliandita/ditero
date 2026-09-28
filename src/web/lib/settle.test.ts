import { describe, expect, test } from "vitest";
import { EMPTY_SETTLE, observeTasks, settleAll } from "./settle.ts";

const row = (id: string, done: boolean | null) => ({ id, done });

describe("observeTasks", () => {
	test("rows already done when first seen do not settle", () => {
		const s = observeTasks(EMPTY_SETTLE, [row("a", true), row("b", false)]);
		expect([...s.settling]).toEqual([]);
		expect(s.epoch).toBe(0);
	});

	test("an observed open -> done transition settles and bumps the epoch", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false), row("b", false)]);
		const s1 = observeTasks(s0, [row("a", true), row("b", false)]);
		expect([...s1.settling]).toEqual(["a"]);
		expect(s1.epoch).toBe(s0.epoch + 1);
		const s2 = observeTasks(s1, [row("a", true), row("b", true)]);
		expect([...s2.settling].sort()).toEqual(["a", "b"]);
		expect(s2.epoch).toBe(s1.epoch + 1);
	});

	test("null done counts as open, so null -> done settles", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", null)]);
		expect([...observeTasks(s0, [row("a", true)]).settling]).toEqual(["a"]);
	});

	test("reopening a settling row removes it without bumping the epoch", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false)]);
		const s1 = observeTasks(s0, [row("a", true)]);
		const s2 = observeTasks(s1, [row("a", false)]);
		expect([...s2.settling]).toEqual([]);
		expect(s2.epoch).toBe(s1.epoch);
	});

	test("a settling row that disappears (deleted, moved) stops settling", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false), row("b", false)]);
		const s1 = observeTasks(s0, [row("a", true), row("b", false)]);
		expect([...observeTasks(s1, [row("b", false)]).settling]).toEqual([]);
	});

	test("unchanged input returns the same state object", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false), row("b", true)]);
		expect(observeTasks(s0, [row("a", false), row("b", true)])).toBe(s0);
		const s1 = observeTasks(s0, [row("a", true), row("b", true)]);
		expect(observeTasks(s1, [row("a", true), row("b", true)])).toBe(s1);
	});

	test("a swapped id with the same row count is still a change", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false)]);
		const s1 = observeTasks(s0, [row("b", false)]);
		expect(s1).not.toBe(s0);
		expect(s1.done.has("a")).toBe(false);
	});
});

describe("settleAll", () => {
	test("clears every settling row and keeps the observed state", () => {
		const s0 = observeTasks(EMPTY_SETTLE, [row("a", false)]);
		const s1 = observeTasks(s0, [row("a", true)]);
		const s2 = settleAll(s1);
		expect([...s2.settling]).toEqual([]);
		expect(s2.done.get("a")).toBe(true);
		// After settling, the same snapshot must not re-settle the row.
		expect(observeTasks(s2, [row("a", true)])).toBe(s2);
	});

	test("is a no-op when nothing is settling", () => {
		expect(settleAll(EMPTY_SETTLE)).toBe(EMPTY_SETTLE);
	});
});
