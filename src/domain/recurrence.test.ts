import { RRule } from "rrule";
import { describe, expect, test } from "vitest";
import {
	DAILY_RRULE,
	expand,
	initialRRule,
	nextDue,
	parseRule,
	presetToRRule,
	projectRecurrence,
	type RecurrencePreset,
	type RecurrenceSeries,
	rruleToPreset,
	transitionRecurrence,
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

describe("initialRRule", () => {
	test("a top-level habit starts daily, and the rule parses", () => {
		expect(initialRRule("habits", null)).toBe(DAILY_RRULE);
		expect(initialRRule("habits", undefined)).toBe(DAILY_RRULE);
		expect(rruleToPreset(DAILY_RRULE)).toEqual({ freq: "daily", interval: 1 });
	});

	test("habit subtasks and every other kind start without a rule", () => {
		expect(initialRRule("habits", "parent")).toBeNull();
		for (const kind of ["tasks", "shopping", "checklist", "project", null]) {
			expect(initialRRule(kind, null)).toBeNull();
		}
	});
});

const series = (
	rule: string,
	patch: Partial<RecurrenceSeries> = {},
): RecurrenceSeries => ({
	rrule: rule,
	relative: false,
	anchorAt: utc(2026, 0, 1),
	dueAt: utc(2026, 0, 1),
	consumed: 0,
	exhausted: false,
	...patch,
});
const dates = (result: ReturnType<typeof projectRecurrence>) =>
	result.occurrences.map((d) => d.toISOString().slice(0, 10));

describe("finite recurrence transitions", () => {
	for (const relative of [false, true])
		for (const count of [1, 2, 3]) {
			test(`${relative ? "relative" : "fixed"} COUNT=${count} consumes the final slot and then does nothing`, () => {
				let current = series(`FREQ=DAILY;COUNT=${count}`, { relative });
				const anchor = current.anchorAt?.getTime();
				for (let i = 1; i <= count; i++) {
					const result = transitionRecurrence(current, utc(2026, 0, 10 + i));
					expect(result.status).toBe(i === count ? "exhausted" : "advanced");
					expect(result.series.consumed).toBe(i);
					expect(result.series.anchorAt?.getTime()).toBe(anchor);
					if (i < count)
						expect(result.series.dueAt).toEqual(
							relative ? utc(2026, 0, 11 + i) : utc(2026, 0, 1 + i),
						);
					current = result.series;
				}
				expect(transitionRecurrence(current, utc(2026, 0, 30)).series).toBe(
					current,
				);
			});
		}
	test("legacy known due adopts a continuation with no guessed history", () => {
		const result = transitionRecurrence(
			series("FREQ=DAILY;COUNT=2", {
				anchorAt: null,
				consumed: null,
				dueAt: utc(2026, 4, 5),
			}),
			utc(2026, 4, 20),
		);
		expect(result.status).toBe("advanced");
		expect(result.series).toMatchObject({
			anchorAt: utc(2026, 4, 5),
			consumed: 1,
			dueAt: utc(2026, 4, 6),
		});
	});
	for (const relative of [false, true])
		test(`UNTIL is inclusive (${relative})`, () => {
			const current = series("FREQ=DAILY;UNTIL=20260102T000000Z", { relative });
			const next = transitionRecurrence(current, utc(2026, 0, 1));
			expect(next.status).toBe("advanced");
			expect(next.series.dueAt).toEqual(utc(2026, 0, 2));
			expect(transitionRecurrence(next.series, utc(2026, 0, 2)).status).toBe(
				"exhausted",
			);
		});

	test("scan incompleteness never consumes a slot or means exhaustion", () => {
		const current = series("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30");
		const result = transitionRecurrence(current, utc(2026, 0, 1), {
			maxPeriods: 2,
		});
		expect(result).toEqual({
			status: "capped",
			series: current,
			reason: "period-limit",
		});
	});
});

describe("anchored bounded projection", () => {
	test("relative virtual habits retain eligible dated history while ordinary tasks show current due only", () => {
		const current = series("FREQ=DAILY;COUNT=3", { relative: true });
		expect(
			dates(projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 5))),
		).toEqual(["2026-01-01"]);
		expect(
			dates(
				projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 5), {
					includePast: true,
				}),
			),
		).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
	});
	test("transition consumes first unspent slot when cursor lags consumed ordinal", () => {
		const current = series("FREQ=DAILY;COUNT=4", { consumed: 1 });
		expect(
			dates(projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 5)))[0],
		).toBe("2026-01-02");
		const result = transitionRecurrence(current, utc(2026, 0, 2));
		expect(result.status).toBe("advanced");
		expect(result.series).toMatchObject({
			consumed: 2,
			dueAt: utc(2026, 0, 3),
		});
	});
	test("capped spent-ordinal lookup leaves action state unchanged", () => {
		const current = series("FREQ=DAILY;COUNT=4", { consumed: 1 });
		expect(
			transitionRecurrence(current, utc(2026, 0, 2), { maxPeriods: 1 }),
		).toEqual({ status: "capped", reason: "period-limit", series: current });
	});
	test("a daily COUNT1000 series advances beyond the display output cap", () => {
		const dueAt = new Date("2026-01-03T12:00:00Z");
		const current = series("FREQ=DAILY;COUNT=1000", {
			anchorAt: new Date("2025-01-01T12:00:00Z"),
			dueAt,
			consumed: 367,
		});
		for (const limits of [{}, { maxOutput: 2 }]) {
			const result = transitionRecurrence(current, dueAt, limits);
			expect(result.status).toBe("advanced");
			expect(result.series).toEqual({
				...current,
				consumed: 368,
				dueAt: new Date("2026-01-04T12:00:00Z"),
			});
		}
	});
	test("long ordinal lookup retains work and allocation caps without changing state", () => {
		const dueAt = new Date("2026-01-03T12:00:00Z");
		const current = series("FREQ=DAILY;COUNT=1000", {
			anchorAt: new Date("2025-01-01T12:00:00Z"),
			dueAt,
			consumed: 367,
		});
		for (const [limits, reason] of [
			[{ maxWork: 1000 }, "work-limit"],
			[{ maxAllocation: 366 }, "allocation-limit"],
		] as const) {
			expect(transitionRecurrence(current, dueAt, limits)).toEqual({
				status: "capped",
				reason,
				series: current,
			});
			expect(
				projectRecurrence(
					current,
					dueAt,
					new Date("2026-01-10T12:00:00Z"),
					limits,
				),
			).toEqual({ status: "capped", reason, occurrences: [] });
		}
	});
	test("long consumed history preserves a complete window and its display cap", () => {
		const from = new Date("2026-01-03T12:00:00Z");
		const to = new Date("2026-01-10T12:00:00Z");
		const current = series("FREQ=DAILY;COUNT=1000", {
			anchorAt: new Date("2025-01-01T12:00:00Z"),
			dueAt: from,
			consumed: 367,
		});
		const result = projectRecurrence(current, from, to);
		expect(result.status).toBe("complete");
		expect(dates(result)).toEqual([
			"2026-01-03",
			"2026-01-04",
			"2026-01-05",
			"2026-01-06",
			"2026-01-07",
			"2026-01-08",
			"2026-01-09",
			"2026-01-10",
		]);
		expect(projectRecurrence(current, from, to, { maxOutput: 2 })).toEqual({
			status: "capped",
			reason: "output-limit",
			occurrences: [from, new Date("2026-01-04T12:00:00Z")],
		});
	});

	test("spent budget and stale cursors never advertise spent slots; virtual history remains", () => {
		for (const consumed of [1, 2]) {
			const current = series("FREQ=DAILY;COUNT=2", { consumed });
			expect(
				dates(projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 5))),
			).toEqual(consumed === 1 ? ["2026-01-02"] : []);
			expect(
				dates(
					projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 5), {
						includePast: true,
					}),
				),
			).toEqual(["2026-01-01", "2026-01-02"]);
		}
	});
	test("selected Tuesday is the first ordinary COUNT slot; virtual dates count eligible dates", () => {
		const current = series("FREQ=WEEKLY;BYDAY=MO,WE;COUNT=2", {
			anchorAt: utc(2026, 0, 6),
			dueAt: utc(2026, 0, 6),
		});
		expect(
			dates(projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 31))),
		).toEqual(["2026-01-06", "2026-01-07"]);
		expect(
			dates(
				projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 31), {
					includePast: true,
				}),
			),
		).toEqual(["2026-01-07", "2026-01-12"]);
		const next = transitionRecurrence(current, utc(2026, 0, 6));
		expect(next.status).toBe("advanced");
		expect(next.series.dueAt).toEqual(utc(2026, 0, 7));
		expect(transitionRecurrence(next.series, utc(2026, 0, 7)).status).toBe(
			"exhausted",
		);
	});
	test("eligible initial anchor is not double counted", () => {
		expect(
			dates(
				projectRecurrence(
					series("FREQ=WEEKLY;BYDAY=TH;COUNT=2"),
					utc(2026, 0, 1),
					utc(2026, 0, 31),
				),
			),
		).toEqual(["2026-01-01", "2026-01-08"]);
	});
	test("COUNT1 selected slot needs no eligible later selector match", () => {
		const current = series("FREQ=WEEKLY;BYDAY=MO;COUNT=1");
		expect(
			dates(projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 31))),
		).toEqual(["2026-01-01"]);
		expect(transitionRecurrence(current, utc(2026, 0, 1)).status).toBe(
			"exhausted",
		);
	});
	test("weekly interval phase and partial first-period COUNT survive month navigation", () => {
		const current = series("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", {
			anchorAt: utc(2026, 0, 7),
			dueAt: utc(2026, 0, 7),
		});
		expect(
			dates(projectRecurrence(current, utc(2026, 0, 19), utc(2026, 1, 28))),
		).toEqual(["2026-01-19", "2026-01-21", "2026-02-02"]);
		const open = { ...current, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" };
		expect(
			dates(projectRecurrence(open, utc(2026, 1, 1), utc(2026, 1, 28))),
		).toEqual(["2026-02-02", "2026-02-16"]);
		expect(
			dates(projectRecurrence(open, utc(2026, 2, 1), utc(2026, 2, 31))),
		).toEqual(["2026-03-02", "2026-03-16", "2026-03-30"]);
	});
	test("daily COUNT does not restart in the next month", () => {
		expect(
			projectRecurrence(
				series("FREQ=DAILY;INTERVAL=2;COUNT=3"),
				utc(2026, 1, 1),
				utc(2026, 1, 28),
			),
		).toEqual({ status: "complete", occurrences: [] });
	});
	test("advanced custom selectors retain full rule semantics in virtual projection", () => {
		const cases = [
			["FREQ=MONTHLY;BYDAY=2MO;COUNT=2", ["2026-01-12", "2026-02-09"]],
			[
				"FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2",
				["2026-01-30", "2026-02-27"],
			],
			["FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2", ["2026-01-31", "2026-02-28"]],
		] as const;
		for (const [rule, expected] of cases)
			expect(
				dates(
					projectRecurrence(series(rule), utc(2026, 0, 1), utc(2026, 2, 1), {
						includePast: true,
					}),
				),
			).toEqual(expected);
	});
	test("relative projection promises only the actual current due", () => {
		expect(
			dates(
				projectRecurrence(
					series("FREQ=DAILY;COUNT=3", { relative: true }),
					utc(2026, 0, 1),
					utc(2026, 0, 31),
				),
			),
		).toEqual(["2026-01-01"]);
	});
	test("legacy unlimited daily habits remain; unknown finite phase requires a start", () => {
		const unknown = { anchorAt: null, dueAt: null, consumed: null };
		expect(
			dates(
				projectRecurrence(
					series(DAILY_RRULE, unknown),
					utc(2026, 0, 2),
					utc(2026, 0, 4),
				),
			),
		).toEqual(["2026-01-02", "2026-01-03", "2026-01-04"]);
		for (const rule of [
			"FREQ=DAILY;COUNT=2",
			"FREQ=DAILY;INTERVAL=2",
			"FREQ=WEEKLY;BYDAY=MO",
		])
			expect(
				projectRecurrence(
					series(rule, unknown),
					utc(2026, 0, 1),
					utc(2026, 0, 31),
				).status,
			).toBe("needs-start");
	});
	test("dense far-old and impossible selectors cap pre-window work explicitly", () => {
		for (const rule of ["FREQ=SECONDLY", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31"])
			expect(
				projectRecurrence(
					series(rule, { anchorAt: utc(1900, 0, 1), dueAt: utc(1900, 0, 1) }),
					utc(2026, 0, 1),
					utc(2026, 1, 1),
					{ maxPeriods: 5 },
				),
			).toEqual({ status: "capped", occurrences: [], reason: "period-limit" });
	});
	test("output limits include the extra initial selected slot", () => {
		const current = series("FREQ=WEEKLY;BYDAY=MO,WE", {
			anchorAt: utc(2026, 0, 6),
			dueAt: utc(2026, 0, 6),
		});
		expect(
			projectRecurrence(current, utc(2026, 0, 1), utc(2026, 0, 31), {
				maxOutput: 1,
			}),
		).toEqual({
			status: "capped",
			reason: "output-limit",
			occurrences: [utc(2026, 0, 6)],
		});
	});
	test("invalid stored state and invalid evaluator budgets fail loudly", () => {
		expect(() =>
			projectRecurrence(
				series(DAILY_RRULE, { consumed: null }),
				utc(2026, 0, 1),
				utc(2026, 0, 2),
			),
		).toThrow("incomplete");
		expect(() =>
			projectRecurrence(series(DAILY_RRULE), utc(2026, 0, 1), utc(2026, 0, 2), {
				maxPeriods: Infinity,
			}),
		).toThrow();
	});
});
