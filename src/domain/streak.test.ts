import { describe, expect, test } from "vitest";
import { computeStreak, type HabitLogEntry } from "./streak.ts";

const DAILY = "FREQ=DAILY;INTERVAL=1";
const TODAY = "2026-07-14";

// Ascending "YYYY-MM-DD" list of the daily occurrences in the default 30-day
// window ending on TODAY (index 0 = oldest, index 29 = TODAY).
const windowDates = (count = 30): string[] => {
	const out: string[] = [];
	const end = Date.UTC(2026, 6, 14);
	for (let i = count - 1; i >= 0; i--) {
		out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
	}
	return out;
};

const done = (date: string): HabitLogEntry => ({ date, status: "done" });
const skipped = (date: string): HabitLogEntry => ({ date, status: "skipped" });

describe("computeStreak", () => {
	test("perfect run -> current == longest == expected count, adherence 100", () => {
		const dates = windowDates();
		const r = computeStreak(DAILY, dates.map(done), TODAY);
		expect(dates).toHaveLength(30);
		expect(r.current).toBe(30);
		expect(r.longest).toBe(30);
		expect(r.adherencePct).toBe(100);
		expect(r.heatmap).toHaveLength(30);
		expect(r.heatmap.every((h) => h.status === "done")).toBe(true);
	});

	test("a skipped day is neutral: no break, excluded from adherence", () => {
		const dates = windowDates();
		const logs = dates.map((d, i) => (i === 15 ? skipped(d) : done(d)));
		const r = computeStreak(DAILY, logs, TODAY);
		expect(r.current).toBe(29); // 29 done, skip neutral (not counted, not broken)
		expect(r.longest).toBe(29);
		expect(r.adherencePct).toBe(100); // done 29 / (denominator excludes the skip) 29
	});

	test("a missed past date breaks current, a later run still yields longest", () => {
		const dates = windowDates();
		// days 0..19 done, day 20 missed (no log), days 21..29 done
		const logs = dates.filter((_, i) => i !== 20).map(done);
		const r = computeStreak(DAILY, logs, TODAY);
		expect(r.current).toBe(9); // recent run: days 21..29
		expect(r.longest).toBe(20); // earlier run: days 0..19
		// adherence: 29 done, 1 missed -> 29/30
		expect(r.adherencePct).toBe(97);
	});

	test("today expected-but-not-yet-logged: current == run ending yesterday", () => {
		const dates = windowDates();
		const logs = dates.slice(0, 29).map(done); // all done except TODAY
		const r = computeStreak(DAILY, logs, TODAY);
		expect(r.current).toBe(29);
		expect(r.longest).toBe(29);
		expect(r.adherencePct).toBe(100); // pending today excluded from both
		expect(r.heatmap[29]).toEqual({ date: TODAY, status: "none" });
	});

	test("empty logs with past expected dates -> current/longest 0, adherence 0", () => {
		const r = computeStreak(DAILY, [], TODAY);
		expect(r.current).toBe(0);
		expect(r.longest).toBe(0);
		expect(r.adherencePct).toBe(0); // 29 past occurrences all missed
	});

	test("empty logs with only a pending today -> adherence 100", () => {
		const r = computeStreak(DAILY, [], TODAY, 1);
		expect(r.heatmap).toEqual([{ date: TODAY, status: "none" }]);
		expect(r.current).toBe(0);
		expect(r.longest).toBe(0);
		expect(r.adherencePct).toBe(100); // no past occurrence to hold against
	});

	test("heatmap length == expected count, marks missed and none", () => {
		const dates = windowDates();
		const r = computeStreak(DAILY, [], TODAY);
		expect(r.heatmap).toHaveLength(dates.length);
		expect(r.heatmap.slice(0, 29).every((h) => h.status === "missed")).toBe(
			true,
		);
		expect(r.heatmap[29].status).toBe("none");
	});

	test("logs outside expected occurrences are ignored", () => {
		// A weekly Monday habit; a done log on a non-Monday must not count.
		const r = computeStreak(
			"FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
			[
				{ date: "2026-07-06", status: "done" },
				{ date: "2026-07-07", status: "done" },
			],
			TODAY,
		);
		// Mondays in [2026-06-15, 2026-07-14]: 06-15,22,29, 07-06,13. 2026-07-07 is
		// a Tuesday (ignored). Only 2026-07-06 (Mon) is done; the rest missed.
		expect(r.heatmap.map((h) => h.date)).toEqual([
			"2026-06-15",
			"2026-06-22",
			"2026-06-29",
			"2026-07-06",
			"2026-07-13",
		]);
		const doneDay = r.heatmap.find((h) => h.date === "2026-07-06");
		expect(doneDay?.status).toBe("done");
		expect(r.current).toBe(0); // most recent expected (07-13) is missed
	});

	test("INTERVAL>1 phase is window-edge-anchored (known limitation, pinned)", () => {
		// FREQ=DAILY;INTERVAL=2 anchors on the window start (2026-06-15), not the
		// habit's true epoch. Expected dates are every other day from that edge, so
		// TODAY (2026-07-14, an odd offset) is NOT an occurrence. This asserts the
		// current deferred behavior; epoch-anchoring would change it visibly.
		const r = computeStreak("FREQ=DAILY;INTERVAL=2", [], TODAY);
		expect(r.heatmap.map((h) => h.date)).toEqual([
			"2026-06-15",
			"2026-06-17",
			"2026-06-19",
			"2026-06-21",
			"2026-06-23",
			"2026-06-25",
			"2026-06-27",
			"2026-06-29",
			"2026-07-01",
			"2026-07-03",
			"2026-07-05",
			"2026-07-07",
			"2026-07-09",
			"2026-07-11",
			"2026-07-13",
		]);
		expect(r.heatmap.some((h) => h.date === TODAY)).toBe(false);
	});

	test("malformed rrule fails loud", () => {
		expect(() => computeStreak("garbage", [], TODAY)).toThrow();
	});
});
