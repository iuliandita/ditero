import { describe, expect, test } from "vitest";
import {
	DEFAULT_GRACE_MS,
	DEFAULT_LATE_THRESHOLD_MS,
	DEFAULT_TICK_MS,
	schedulerTiming,
} from "./scheduler.ts";

describe("schedulerTiming", () => {
	test("empty env yields the documented defaults", () => {
		expect(schedulerTiming({})).toEqual({
			tickMs: DEFAULT_TICK_MS,
			graceMs: DEFAULT_GRACE_MS,
			lateThresholdMs: DEFAULT_LATE_THRESHOLD_MS,
		});
	});

	test("the defaults satisfy their own ordering constraint", () => {
		expect(DEFAULT_LATE_THRESHOLD_MS).toBeGreaterThanOrEqual(
			2 * DEFAULT_TICK_MS,
		);
		expect(DEFAULT_GRACE_MS).toBeGreaterThanOrEqual(DEFAULT_TICK_MS);
	});

	test("all three are overridable", () => {
		expect(
			schedulerTiming({
				DITERO_SCHEDULER_TICK_MS: "50",
				DITERO_SCHEDULER_GRACE_MS: "5000",
				DITERO_SCHEDULER_LATE_THRESHOLD_MS: "100",
			}),
		).toEqual({ tickMs: 50, graceMs: 5000, lateThresholdMs: 100 });
	});

	test("a late threshold under two ticks is rejected at boot", () => {
		expect(() =>
			schedulerTiming({
				DITERO_SCHEDULER_TICK_MS: "1000",
				DITERO_SCHEDULER_LATE_THRESHOLD_MS: "1999",
			}),
		).toThrow(/at least twice/);
		expect(() =>
			schedulerTiming({
				DITERO_SCHEDULER_TICK_MS: "1000",
				DITERO_SCHEDULER_LATE_THRESHOLD_MS: "2000",
			}),
		).not.toThrow();
	});

	test("a grace window shorter than the tick is rejected at boot", () => {
		expect(() =>
			schedulerTiming({
				DITERO_SCHEDULER_TICK_MS: "1000",
				DITERO_SCHEDULER_GRACE_MS: "999",
				DITERO_SCHEDULER_LATE_THRESHOLD_MS: "2000",
			}),
		).toThrow(/at least/);
	});

	test.each([
		["0"],
		["-1"],
		["1.5"],
		["abc"],
		["30s"],
	])("rejects %s as a tick interval", (raw) => {
		expect(() => schedulerTiming({ DITERO_SCHEDULER_TICK_MS: raw })).toThrow(
			/positive integer/,
		);
	});
});
