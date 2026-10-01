import { describe, expect, test } from "vitest";
import { localDay } from "./local-day.ts";
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
const schedule = (
	day: string,
	overrides: Partial<import("./streak.ts").StreakSchedule> = {},
) => ({
	anchorAt: new Date(`${day}T00:00:00Z`),
	dueAt: new Date(`${day}T00:00:00Z`),
	consumed: 0,
	relative: false,
	exhausted: false,
	...overrides,
});
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

	test("tracked since the window start with no logs -> current/longest 0, adherence 0", () => {
		const r = computeStreak(DAILY, [], TODAY, 30, "2026-06-15");
		expect(r.current).toBe(0);
		expect(r.longest).toBe(0);
		expect(r.adherencePct).toBe(0); // 29 past occurrences all missed
	});

	test("empty logs with only a pending today -> no adherence yet", () => {
		const r = computeStreak(DAILY, [], TODAY, 1);
		expect(r.heatmap).toEqual([{ date: TODAY, status: "none" }]);
		expect(r.current).toBe(0);
		expect(r.longest).toBe(0);
		expect(r.adherencePct).toBeNull(); // no past occurrence to hold against
	});

	test("heatmap length == expected count, marks missed and none", () => {
		const dates = windowDates();
		const r = computeStreak(DAILY, [], TODAY, 30, "2026-06-15");
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
			30,
			"2026-06-15",
			schedule("2026-06-15"),
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

	test("INTERVAL>1 phase uses the same anchor across shifted windows", () => {
		const r = computeStreak(
			"FREQ=DAILY;INTERVAL=2",
			[],
			TODAY,
			30,
			"2026-06-15",
			schedule("2026-06-15"),
		);
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
		const next = computeStreak(
			"FREQ=DAILY;INTERVAL=2",
			[],
			"2026-07-15",
			30,
			"2026-06-15",
			schedule("2026-06-15"),
		);
		expect(next.heatmap.map((h) => h.date).filter((d) => d <= TODAY)).toEqual(
			r.heatmap.map((h) => h.date).filter((d) => d >= "2026-06-16"),
		);
	});

	test("a habit started today with nothing logged has one pending day and no score", () => {
		const r = computeStreak(DAILY, [], TODAY);
		expect(r.heatmap).toEqual([{ date: TODAY, status: "none" }]);
		expect(r.adherencePct).toBeNull();
		expect(r.current).toBe(0);
	});

	test("days before tracking started are neither shown nor missed", () => {
		const r = computeStreak(
			DAILY,
			[done("2026-07-12")],
			TODAY,
			30,
			"2026-07-10",
		);
		expect(r.heatmap).toEqual([
			{ date: "2026-07-10", status: "missed" },
			{ date: "2026-07-11", status: "missed" },
			{ date: "2026-07-12", status: "done" },
			{ date: "2026-07-13", status: "missed" },
			{ date: TODAY, status: "none" },
		]);
		expect(r.adherencePct).toBe(25); // 1 done of 4 elapsed days since 07-10
	});

	test("without a start day, the first check-in anchors tracking", () => {
		const r = computeStreak(
			DAILY,
			[done("2026-07-12"), done("2026-07-13")],
			TODAY,
		);
		expect(r.heatmap.map((h) => h.status)).toEqual(["done", "done", "none"]);
		expect(r.adherencePct).toBe(100);
		expect(r.current).toBe(2);
	});

	test("a log older than the start day still counts (imported history)", () => {
		const r = computeStreak(
			DAILY,
			[done("2026-07-08")],
			TODAY,
			30,
			"2026-07-13",
		);
		expect(r.heatmap[0]).toEqual({ date: "2026-07-08", status: "done" });
		expect(r.heatmap).toHaveLength(7);
	});

	test("a tracking start before the window is clamped to the window", () => {
		const r = computeStreak(DAILY, [], TODAY, 30, "2025-01-01");
		expect(r.heatmap).toHaveLength(30);
	});

	test("tracking start does not change the persisted schedule phase", () => {
		const r = computeStreak(
			"FREQ=DAILY;INTERVAL=2",
			[],
			TODAY,
			30,
			"2026-07-09",
			schedule("2026-06-15"),
		);
		expect(r.heatmap.map((h) => h.date)).toEqual([
			"2026-07-09",
			"2026-07-11",
			"2026-07-13",
		]);
		expect(r.adherencePct).toBe(0);
	});

	test("finite virtual history keeps original COUNT even after exhaustion or relative progress", () => {
		for (const relative of [false, true]) {
			const r = computeStreak(
				"FREQ=DAILY;COUNT=3",
				[
					done("2026-07-01"),
					done("2026-07-02"),
					done("2026-07-03"),
					done("2026-07-04"),
				],
				"2026-07-10",
				30,
				"2026-07-01",
				schedule("2026-07-01", {
					relative,
					consumed: 3,
					exhausted: true,
					dueAt: new Date("2026-07-03T00:00:00Z"),
				}),
			);
			expect(r.projectionStatus).toBe("complete");
			expect(r.heatmap.map((h) => h.date)).toEqual([
				"2026-07-01",
				"2026-07-02",
				"2026-07-03",
			]);
			expect(r.current).toBe(3);
		}
	});

	test("UNTIL and calendar-month windows retain the same original interval phase", () => {
		const state = schedule("2026-01-01");
		const rrule = "FREQ=MONTHLY;INTERVAL=2;UNTIL=20260501T000000Z";
		const april = computeStreak(
			rrule,
			[],
			"2026-04-30",
			30,
			"2026-01-01",
			state,
		);
		const may = computeStreak(
			rrule,
			[done("2026-05-01")],
			"2026-05-31",
			31,
			"2026-01-01",
			state,
		);
		expect(april.heatmap).toEqual([]);
		expect(may.heatmap).toEqual([{ date: "2026-05-01", status: "done" }]);
		expect(
			computeStreak(rrule, [], "2026-04-30", 30, "2026-01-01", state),
		).toEqual(april);
	});

	test("undated phase-sensitive legacy schedules need a start instead of inferring it from logs", () => {
		const r = computeStreak(
			"FREQ=DAILY;INTERVAL=2",
			[done("2026-07-01")],
			TODAY,
		);
		expect(r.projectionStatus).toBe("needs-start");
		expect(r.heatmap).toEqual([]);
		expect(r.adherencePct).toBeNull();
	});

	test("an old prefix or impossible selector reports incomplete without a false score", () => {
		for (const rrule of ["FREQ=DAILY", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"]) {
			const r = computeStreak(
				rrule,
				[],
				TODAY,
				30,
				"2026-06-15",
				schedule("1900-01-01"),
			);
			expect(r.projectionStatus).toBe("capped");
			expect(r.adherencePct).toBeNull();
			expect(r.heatmap).toEqual([]);
		}
	});

	test("malformed rrule fails loud", () => {
		expect(() => computeStreak("garbage", [], TODAY)).toThrow();
	});
});

test("creation provenance starts habit tracking in the viewer's timezone without discarding older logs", () => {
	const createdAt = new Date("2026-07-14T01:00:00.000Z");
	const since = localDay(createdAt, "America/Los_Angeles");
	expect(since).toBe("2026-07-13");
	const result = computeStreak(DAILY, [], TODAY, 30, since);
	expect(result.heatmap).toEqual([
		{ date: "2026-07-13", status: "missed" },
		{ date: TODAY, status: "none" },
	]);
	expect(
		computeStreak(DAILY, [done("2026-07-12")], TODAY, 30, since).heatmap[0],
	).toEqual({ date: "2026-07-12", status: "done" });
	expect(computeStreak(DAILY, [], TODAY).heatmap).toEqual([
		{ date: TODAY, status: "none" },
	]);
});
