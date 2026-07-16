import { describe, expect, test } from "vitest";
import {
	evaluateGoals,
	KARMA_POINTS,
	type KarmaEvent,
	karmaForCompletion,
	LEVEL_THRESHOLDS,
	levelForPoints,
} from "./karma.ts";

const TODAY = "2026-07-14";
const ev = (date: string, delta: number, reason = "x"): KarmaEvent => ({
	date,
	delta,
	reason,
});

describe("karmaForCompletion", () => {
	test("task base is 5, habit base is 3, at priority 0", () => {
		expect(karmaForCompletion("task", 0)).toBe(5);
		expect(karmaForCompletion("habit", 0)).toBe(3);
	});

	test("priority bonus applies per level", () => {
		expect(karmaForCompletion("task", 0)).toBe(5 + 0);
		expect(karmaForCompletion("task", 1)).toBe(5 + 1);
		expect(karmaForCompletion("task", 2)).toBe(5 + 2);
		expect(karmaForCompletion("task", 3)).toBe(5 + 4);
	});

	test("priority clamps below 0 and above 3", () => {
		expect(karmaForCompletion("task", -1)).toBe(karmaForCompletion("task", 0));
		expect(karmaForCompletion("task", 5)).toBe(karmaForCompletion("task", 3));
		expect(karmaForCompletion("habit", 99)).toBe(3 + 4);
	});

	test("throws on unknown kind", () => {
		// @ts-expect-error deliberate bad kind
		expect(() => karmaForCompletion("bogus", 0)).toThrow();
	});
});

describe("LEVEL_THRESHOLDS", () => {
	test("starts at 0 and increases monotonically", () => {
		expect(LEVEL_THRESHOLDS[0]).toBe(0);
		for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
			expect(LEVEL_THRESHOLDS[i]).toBeGreaterThan(LEVEL_THRESHOLDS[i - 1]);
		}
	});
});

describe("levelForPoints", () => {
	test("0 points -> level 1", () => {
		expect(levelForPoints(0)).toBe(1);
	});

	test("negative points clamp to level 1", () => {
		expect(levelForPoints(-100)).toBe(1);
	});

	test("exact threshold lands on the new level", () => {
		expect(levelForPoints(LEVEL_THRESHOLDS[1])).toBe(2);
		expect(levelForPoints(LEVEL_THRESHOLDS[2])).toBe(3);
	});

	test("just below a threshold stays on the lower level", () => {
		expect(levelForPoints(LEVEL_THRESHOLDS[1] - 1)).toBe(1);
		expect(levelForPoints(LEVEL_THRESHOLDS[2] - 1)).toBe(2);
	});

	test("points beyond the top threshold return the top level", () => {
		const top = LEVEL_THRESHOLDS.length;
		expect(levelForPoints(LEVEL_THRESHOLDS[top - 1])).toBe(top);
		expect(levelForPoints(9_999_999)).toBe(top);
	});
});

describe("evaluateGoals", () => {
	test("dailyDone counts only today's positive events", () => {
		const events = [
			ev(TODAY, 5),
			ev(TODAY, 3),
			ev("2026-07-13", 5),
			ev(TODAY, -5),
		];
		const r = evaluateGoals(events, { daily: 2, weekly: 0 }, TODAY);
		expect(r.dailyDone).toBe(2);
	});

	test("weeklyDone counts the trailing 7-day window inclusive", () => {
		const events = [
			ev(TODAY, 5), // in
			ev("2026-07-08", 5), // today-6, in
			ev("2026-07-07", 5), // today-7, OUT
			ev("2026-07-10", 5), // in
		];
		const r = evaluateGoals(events, { daily: 0, weekly: 3 }, TODAY);
		expect(r.weeklyDone).toBe(3);
	});

	test("negative/undo deltas are ignored", () => {
		const events = [ev(TODAY, -5), ev(TODAY, 0), ev("2026-07-10", -3)];
		const r = evaluateGoals(events, { daily: 1, weekly: 1 }, TODAY);
		expect(r.dailyDone).toBe(0);
		expect(r.weeklyDone).toBe(0);
		expect(r.dailyMet).toBe(false);
		expect(r.weeklyMet).toBe(false);
	});

	test("goal of 0 is met vacuously", () => {
		const r = evaluateGoals([], { daily: 0, weekly: 0 }, TODAY);
		expect(r.dailyDone).toBe(0);
		expect(r.weeklyDone).toBe(0);
		expect(r.dailyMet).toBe(true);
		expect(r.weeklyMet).toBe(true);
	});

	test("done == goal counts as met", () => {
		const events = [ev(TODAY, 5), ev(TODAY, 5)];
		const r = evaluateGoals(events, { daily: 2, weekly: 2 }, TODAY);
		expect(r.dailyMet).toBe(true);
		expect(r.weeklyMet).toBe(true);
	});

	test("KARMA_POINTS shape is stable", () => {
		expect(KARMA_POINTS.task).toBe(5);
		expect(KARMA_POINTS.habit).toBe(3);
		expect(KARMA_POINTS.priorityBonus).toEqual([0, 1, 2, 4]);
	});
});
