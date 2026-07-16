import { RRule } from "rrule";
import { describe, expect, test } from "vitest";
import {
	expand,
	nextDue,
	parseRule,
	presetToRRule,
	type RecurrencePreset,
	rruleToPreset,
} from "./recurrence.ts";

const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
	new Date(Date.UTC(y, m, d, h, min, 0));

describe("presetToRRule / rruleToPreset round-trips", () => {
	const cases: RecurrencePreset[] = [
		{ freq: "daily", interval: 2 },
		{ freq: "weekly", interval: 1, weekdays: [0, 2] },
		{ freq: "monthly", interval: 1, monthday: 15 },
		{ freq: "yearly", interval: 3 },
	];
	for (const p of cases) {
		test(`${p.freq} round-trips`, () => {
			expect(rruleToPreset(presetToRRule(p))).toEqual(p);
		});
	}

	test("weekly BYDAY emitted in stable 0..6 order", () => {
		expect(
			presetToRRule({ freq: "weekly", interval: 1, weekdays: [2, 0] }),
		).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE");
	});

	test("weekday mapping covers Mon..Sun", () => {
		expect(
			presetToRRule({ freq: "weekly", interval: 1, weekdays: [0, 6] }),
		).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,SU");
	});

	test("rejects invalid presets (fail-loud)", () => {
		expect(() => presetToRRule({ freq: "daily", interval: 0 })).toThrow();
		expect(() =>
			presetToRRule({ freq: "weekly", interval: 1, weekdays: [] }),
		).toThrow();
		expect(() =>
			presetToRRule({ freq: "weekly", interval: 1, weekdays: [7] }),
		).toThrow();
		expect(() =>
			presetToRRule({ freq: "monthly", interval: 1, monthday: 32 }),
		).toThrow();
	});
});

describe("rruleToPreset non-preset rules", () => {
	test("BYSETPOS -> null", () => {
		expect(rruleToPreset("FREQ=MONTHLY;BYSETPOS=1;BYDAY=MO")).toBeNull();
	});
	test("BYMONTH -> null", () => {
		expect(rruleToPreset("FREQ=YEARLY;BYMONTH=3")).toBeNull();
	});
	test("COUNT -> null (presets carry no bound)", () => {
		expect(rruleToPreset("FREQ=DAILY;INTERVAL=1;COUNT=5")).toBeNull();
	});
	test("SECONDLY freq -> null", () => {
		expect(rruleToPreset("FREQ=SECONDLY")).toBeNull();
	});
});

describe("parseRule", () => {
	test("parses a valid rule", () => {
		expect(parseRule("FREQ=WEEKLY;BYDAY=MO")).toBeInstanceOf(RRule);
	});
	test("throws on garbage (fail-loud)", () => {
		expect(() => parseRule("not-an-rrule")).toThrow();
	});
	test("throws when FREQ missing", () => {
		expect(() => parseRule("INTERVAL=2")).toThrow();
	});
});

describe("nextDue fixed", () => {
	const from = utc(2026, 2, 7, 9); // Sat 2026-03-07 09:00Z
	const opts = { relative: false as const, completedAt: from };

	test("daily advances one day strictly after from", () => {
		expect(nextDue("FREQ=DAILY;INTERVAL=1", from, opts)?.toISOString()).toBe(
			utc(2026, 2, 8, 9).toISOString(),
		);
	});
	test("weekly BYDAY advances to next listed weekday", () => {
		expect(
			nextDue("FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE", from, opts)?.toISOString(),
		).toBe(utc(2026, 2, 9, 9).toISOString()); // Mon 2026-03-09
	});
	test("monthly advances to the monthday", () => {
		expect(
			nextDue(
				"FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15",
				from,
				opts,
			)?.toISOString(),
		).toBe(utc(2026, 2, 15, 9).toISOString());
	});

	test("exhausted COUNT series -> null", () => {
		expect(nextDue("FREQ=DAILY;COUNT=1", from, opts)).toBeNull();
	});
	test("past UNTIL -> null", () => {
		expect(nextDue("FREQ=DAILY;UNTIL=20200101T000000Z", from, opts)).toBeNull();
	});

	test("DST-crossing daily keeps same wall-clock, no 23/25h drift", () => {
		// US spring-forward is 2026-03-08; rule frame is UTC so each step is +1 day.
		let cur = utc(2026, 2, 7, 9);
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			const nxt = nextDue("FREQ=DAILY;INTERVAL=1", cur, opts);
			if (!nxt) throw new Error("unexpected null");
			seen.push(nxt.toISOString());
			cur = nxt;
		}
		expect(seen).toEqual([
			utc(2026, 2, 8, 9).toISOString(),
			utc(2026, 2, 9, 9).toISOString(),
			utc(2026, 2, 10, 9).toISOString(),
		]);
	});
});

describe("nextDue relative", () => {
	const completedAt = utc(2026, 2, 20, 14, 30);
	// A wildly different `from` must not affect the relative result.
	const farFrom = utc(2000, 0, 1);

	test("daily interval adds N days, independent of from", () => {
		const a = nextDue("FREQ=DAILY;INTERVAL=3", completedAt, {
			relative: true,
			completedAt,
		});
		const b = nextDue("FREQ=DAILY;INTERVAL=3", farFrom, {
			relative: true,
			completedAt,
		});
		expect(a?.toISOString()).toBe(utc(2026, 2, 23, 14, 30).toISOString());
		expect(b?.toISOString()).toBe(a?.toISOString());
	});
	test("weekly interval adds N weeks", () => {
		expect(
			nextDue("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", completedAt, {
				relative: true,
				completedAt,
			})?.toISOString(),
		).toBe(utc(2026, 3, 3, 14, 30).toISOString()); // +14 days
	});
	test("monthly interval adds N months", () => {
		expect(
			nextDue("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=20", completedAt, {
				relative: true,
				completedAt,
			})?.toISOString(),
		).toBe(utc(2026, 3, 20, 14, 30).toISOString());
	});
	test("yearly interval adds N years", () => {
		expect(
			nextDue("FREQ=YEARLY;INTERVAL=2", completedAt, {
				relative: true,
				completedAt,
			})?.toISOString(),
		).toBe(utc(2028, 2, 20, 14, 30).toISOString());
	});

	test("monthly clamps to month end instead of overflowing", () => {
		// Jan 31 + 1 month must land on Feb 28 (2026 non-leap), not spill into March.
		const jan31 = utc(2026, 0, 31, 8);
		expect(
			nextDue("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31", jan31, {
				relative: true,
				completedAt: jan31,
			})?.toISOString(),
		).toBe(utc(2026, 1, 28, 8).toISOString());
	});

	test("yearly clamps leap day to Feb 28 on a non-leap year", () => {
		const feb29 = utc(2024, 1, 29, 8);
		expect(
			nextDue("FREQ=YEARLY;INTERVAL=1", feb29, {
				relative: true,
				completedAt: feb29,
			})?.toISOString(),
		).toBe(utc(2025, 1, 28, 8).toISOString());
	});

	test("ignores BYMONTHDAY/BYDAY, anchoring on the completion day", () => {
		// Relative due = completedAt + interval; the rule's BYMONTHDAY (5) is not
		// consulted, so completing on the 20th advances to the 20th.
		const completedAt = utc(2026, 2, 20, 9);
		expect(
			nextDue("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5", completedAt, {
				relative: true,
				completedAt,
			})?.toISOString(),
		).toBe(utc(2026, 3, 20, 9).toISOString());
	});
});

describe("expand", () => {
	test("returns inclusive instances within window", () => {
		const got = expand(
			"FREQ=DAILY;INTERVAL=1",
			utc(2026, 2, 7, 9),
			utc(2026, 2, 11, 9),
		);
		expect(got.map((d) => d.toISOString().slice(0, 10))).toEqual([
			"2026-03-07",
			"2026-03-08",
			"2026-03-09",
			"2026-03-10",
			"2026-03-11",
		]);
	});

	test("enforces the cap on pathological rules", () => {
		const got = expand(
			"FREQ=SECONDLY",
			utc(2026, 2, 7, 9),
			utc(2027, 0, 1),
			10,
		);
		expect(got).toHaveLength(10);
	});

	test("default cap is 366", () => {
		const got = expand("FREQ=SECONDLY", utc(2026, 2, 7, 9), utc(2027, 0, 1));
		expect(got).toHaveLength(366);
	});

	test("throws on malformed rrule", () => {
		expect(() => expand("garbage", utc(2026, 2, 7), utc(2026, 2, 8))).toThrow();
	});
});
