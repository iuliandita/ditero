import { createRequire } from "node:module";
import type { IterationLimits } from "rrule";
import { RRule as ESMRRule } from "rrule/dist/esm/index.js";
import { describe, expect, test } from "vitest";

const { RRule: CJSRRule } = createRequire(import.meta.url)("rrule") as {
	RRule: typeof ESMRRule;
};
const date = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

for (const [entry, RRule] of [
	["ESM", ESMRRule],
	["CommonJS", CJSRRule],
] as const) {
	describe(`${entry} bounded recurrence evaluator`, () => {
		const rule = (text: string, start = "2026-01-01") =>
			new RRule({ ...RRule.parseString(text), dtstart: date(start) });
		const between = (text: string, limits: IterationLimits = {}) =>
			rule(text).betweenBounded(
				date("2026-01-01"),
				date("2026-12-31"),
				true,
				limits,
			);

		test("advanced weekday and set-position rules retain the evaluator", () => {
			for (const text of [
				"FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
				"FREQ=MONTHLY;BYDAY=2MO;COUNT=4",
				"FREQ=YEARLY;BYMONTH=2,5;BYMONTHDAY=-1;COUNT=2",
			]) {
				const r = rule(text);
				const expected = r.between(
					date("2026-01-01"),
					date("2026-12-31"),
					true,
				);
				expect(expected.length).toBeGreaterThan(0);
				const result = r.betweenBounded(
					date("2026-01-01"),
					date("2026-12-31"),
					true,
				);
				expect(result.status).toBe("complete");
				expect(iso(result.value)).toEqual(iso(expected));
			}
		});

		test("COUNT and UNTIL retain their original anchor across a prefix", () => {
			const counted = rule("FREQ=DAILY;COUNT=5");
			expect(
				iso(
					counted.betweenBounded(date("2026-01-04"), date("2026-02-01"), true)
						.value,
				),
			).toEqual(iso([date("2026-01-04"), date("2026-01-05")]));
			expect(counted.afterBounded(date("2026-01-05"))).toEqual({
				status: "complete",
				value: null,
			});
			const until = rule("FREQ=DAILY;UNTIL=20260105T000000Z");
			expect(
				iso(
					until.betweenBounded(date("2026-01-04"), date("2026-02-01"), true)
						.value,
				),
			).toEqual(iso([date("2026-01-04"), date("2026-01-05")]));
			expect(until.afterBounded(date("2026-01-05"))).toEqual({
				status: "complete",
				value: null,
			});
		});

		test("old pre-window candidates consume budget even without output", () => {
			const result = rule("FREQ=DAILY", "1900-01-01").betweenBounded(
				date("2026-01-01"),
				date("2026-01-02"),
				true,
				{ maxPeriods: 8 },
			);
			expect(result).toEqual({
				status: "capped",
				reason: "period-limit",
				value: [],
			});
		});

		test("impossible selectors cap empty periods rather than claim exhaustion", () => {
			const result = between("FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", {
				maxPeriods: 8,
			});
			expect(result).toEqual({
				status: "capped",
				reason: "period-limit",
				value: [],
			});
		});

		test("unreachable subdaily selectors stop inside advancement", () => {
			const r = new RRule({
				freq: RRule.HOURLY,
				interval: 24,
				byhour: [2],
				dtstart: new Date("2026-01-01T01:00:00Z"),
			});
			expect(
				r.afterBounded(date("2026-01-01"), false, { maxWork: 3000 }),
			).toEqual({ status: "capped", reason: "work-limit", value: null });
		});

		test("nested minute and second searches share the same work budget", () => {
			for (const options of [
				{
					freq: RRule.MINUTELY,
					interval: 60,
					byminute: [2],
					dtstart: new Date("2026-01-01T01:01:00Z"),
				},
				{
					freq: RRule.SECONDLY,
					interval: 60,
					bysecond: [2],
					dtstart: new Date("2026-01-01T01:01:01Z"),
				},
			]) {
				expect(
					new RRule(options).afterBounded(date("2026-01-01"), false, {
						maxWork: 3000,
					}),
				).toEqual({ status: "capped", reason: "work-limit", value: null });
			}
		});

		test("set-position scratch arrays and dense hourly timesets are bounded", () => {
			const positioned = new RRule({
				freq: RRule.YEARLY,
				dtstart: date("2026-01-01"),
				bysetpos: Array.from({ length: 500 }, () => 1),
				byweekday: [RRule.MO],
			});
			expect(
				positioned.afterBounded(date("2026-01-01"), true, {
					maxAllocation: 400,
				}),
			).toEqual({ status: "capped", reason: "allocation-limit", value: null });
			const hourly = new RRule({
				freq: RRule.HOURLY,
				dtstart: date("2026-01-01"),
				byminute: Array.from({ length: 60 }, (_, i) => i),
				bysecond: Array.from({ length: 60 }, (_, i) => i),
			});
			expect(
				hourly.afterBounded(date("2026-01-01"), true, { maxAllocation: 1000 }),
			).toEqual({ status: "capped", reason: "allocation-limit", value: null });
		});

		test("selector-prefix budget failure is capped and invalid limits still throw", () => {
			expect(
				rule("FREQ=DAILY").afterBounded(date("2026-01-01"), true, {
					maxWork: 1,
				}),
			).toEqual({ status: "capped", reason: "work-limit", value: null });
			expect(() =>
				rule("FREQ=DAILY").afterBounded(date("2026-01-01"), false, {
					maxWork: Infinity,
				}),
			).toThrow(RangeError);
		});

		test("dense Cartesian time arrays cap before allocation", () => {
			const r = new RRule({
				freq: RRule.DAILY,
				dtstart: date("2026-01-01"),
				byhour: Array.from({ length: 24 }, (_, i) => i),
				byminute: Array.from({ length: 60 }, (_, i) => i),
				bysecond: Array.from({ length: 60 }, (_, i) => i),
			});
			expect(
				r.afterBounded(date("2026-01-01"), true, { maxAllocation: 1000 }),
			).toEqual({ status: "capped", reason: "allocation-limit", value: null });
		});

		test("exact COUNT completion differs from one extra output", () => {
			expect(between("FREQ=DAILY;COUNT=2", { maxOutput: 2 })).toEqual({
				status: "complete",
				value: [date("2026-01-01"), date("2026-01-02")],
			});
			expect(between("FREQ=DAILY;COUNT=3", { maxOutput: 2 })).toEqual({
				status: "capped",
				reason: "output-limit",
				value: [date("2026-01-01"), date("2026-01-02")],
			});
		});

		test("result growth obeys allocation limits and keeps output precedence", () => {
			const r = rule("FREQ=DAILY;COUNT=401");
			const result = r.betweenBounded(
				date("2026-01-01"),
				date("2028-01-01"),
				true,
				{ maxOutput: 401, maxAllocation: 400 },
			);
			expect(result.status).toBe("capped");
			expect(result).toMatchObject({ reason: "allocation-limit" });
			expect(result.value).toHaveLength(400);
			expect(result.value[399]).toEqual(date("2027-02-04"));
			expect(
				r.betweenBounded(date("2026-01-01"), date("2028-01-01"), true, {
					maxOutput: 400,
					maxAllocation: 400,
				}),
			).toMatchObject({ status: "capped", reason: "output-limit" });
		});

		test("warm ordinary caches cannot bypass bounded traversal", () => {
			const r = rule("FREQ=DAILY;COUNT=10");
			expect(r.all()).toHaveLength(10);
			expect(r.after(date("2026-01-08"))).toEqual(date("2026-01-09"));
			expect(
				r.afterBounded(date("2026-01-08"), false, { maxPeriods: 2 }),
			).toEqual({ status: "capped", reason: "period-limit", value: null });
			expect(r.all()).toHaveLength(10);
		});

		test("calendar overflow caps instead of overflowing date arithmetic", () => {
			const r = new RRule({
				freq: RRule.DAILY,
				interval: Number.MAX_SAFE_INTEGER,
				dtstart: date("2026-01-01"),
			});
			expect(r.afterBounded(date("2026-01-01"))).toEqual({
				status: "capped",
				reason: "date-limit",
				value: null,
			});
		});
	});
}
