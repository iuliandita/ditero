import { describe, expect, test } from "vitest";
import { m } from "../../paraglide/messages.js";
import {
	type Cycle,
	clampFocusConfig,
	DEFAULT_FOCUS,
	formatFocusedDuration,
	formatMMSS,
	INITIAL_CYCLE,
	nextCycle,
	phaseDurationSec,
	phaseLabel,
	remainingSecFrom,
} from "./timer-core.ts";

describe("clampFocusConfig", () => {
	test("null/garbage -> defaults", () => {
		expect(clampFocusConfig(null)).toEqual(DEFAULT_FOCUS);
		expect(clampFocusConfig("nope")).toEqual(DEFAULT_FOCUS);
		expect(clampFocusConfig(42)).toEqual(DEFAULT_FOCUS);
	});

	test("clamps to caps (minutes 1..180, rounds 1..12)", () => {
		expect(
			clampFocusConfig({
				workMin: 9999,
				breakMin: 0,
				longBreakMin: -3,
				roundsPerLongBreak: 50,
				autoCycle: false,
			}),
		).toEqual({
			workMin: 180,
			breakMin: 1,
			longBreakMin: 1,
			roundsPerLongBreak: 12,
			autoCycle: false,
		});
	});

	test("non-number fields fall back per field; rounds fractional input", () => {
		expect(
			clampFocusConfig({
				workMin: 30.6,
				breakMin: "x",
				roundsPerLongBreak: 3,
				autoCycle: "yes",
			}),
		).toEqual({
			workMin: 31,
			breakMin: DEFAULT_FOCUS.breakMin,
			longBreakMin: DEFAULT_FOCUS.longBreakMin,
			roundsPerLongBreak: 3,
			autoCycle: DEFAULT_FOCUS.autoCycle,
		});
	});
});

describe("nextCycle", () => {
	const cfg = { ...DEFAULT_FOCUS, roundsPerLongBreak: 4 };

	test("full pomodoro group: work1..work4 -> long break -> work1", () => {
		const seen: string[] = [];
		let c: Cycle = INITIAL_CYCLE;
		// Walk 8 transitions (4 work + 4 break) and record phase/round/long.
		for (let i = 0; i < 8; i++) {
			seen.push(
				`${c.phase}${c.round}${c.phase === "break" && c.isLongBreak ? "L" : ""}`,
			);
			c = nextCycle(c, cfg);
		}
		expect(seen).toEqual([
			"work1",
			"break1",
			"work2",
			"break2",
			"work3",
			"break3",
			"work4",
			"break4L",
		]);
		// After the long break, the group restarts at work round 1.
		expect(c).toEqual({ phase: "work", round: 1, isLongBreak: false });
	});

	test("work always feeds a break of the same round", () => {
		expect(
			nextCycle({ phase: "work", round: 2, isLongBreak: false }, cfg),
		).toEqual({ phase: "break", round: 2, isLongBreak: false });
	});
});

describe("phaseDurationSec", () => {
	const cfg = {
		workMin: 25,
		breakMin: 5,
		longBreakMin: 15,
		roundsPerLongBreak: 4,
		autoCycle: true,
	};
	test("work/short break/long break map to their configured minutes", () => {
		expect(
			phaseDurationSec({ phase: "work", round: 1, isLongBreak: false }, cfg),
		).toBe(25 * 60);
		expect(
			phaseDurationSec({ phase: "break", round: 1, isLongBreak: false }, cfg),
		).toBe(5 * 60);
		expect(
			phaseDurationSec({ phase: "break", round: 4, isLongBreak: true }, cfg),
		).toBe(15 * 60);
	});
});

describe("remainingSecFrom", () => {
	test("computed from timestamps, ceils sub-second, floors at 0", () => {
		const now = 1_000_000;
		expect(remainingSecFrom(now + 25_000, now)).toBe(25);
		expect(remainingSecFrom(now + 1, now)).toBe(1); // sub-second remainder rounds up
		expect(remainingSecFrom(now - 5_000, now)).toBe(0); // overshoot clamps to 0
	});
});

describe("formatting", () => {
	test("formatMMSS pads minutes and seconds", () => {
		expect(formatMMSS(0)).toBe("00:00");
		expect(formatMMSS(65)).toBe("01:05");
		expect(formatMMSS(25 * 60)).toBe("25:00");
	});

	test("phaseLabel distinguishes long break", () => {
		expect(phaseLabel({ phase: "work", round: 1, isLongBreak: false })).toBe(
			m.focus_phase_work(),
		);
		expect(phaseLabel({ phase: "break", round: 1, isLongBreak: false })).toBe(
			m.focus_phase_break(),
		);
		expect(phaseLabel({ phase: "break", round: 4, isLongBreak: true })).toBe(
			m.focus_phase_long_break(),
		);
	});

	test("formatFocusedDuration tiers: seconds, minutes, hours+minutes", () => {
		expect(formatFocusedDuration(0)).toBe(
			m.focus_duration_seconds({ seconds: 0 }),
		);
		expect(formatFocusedDuration(2)).toBe(
			m.focus_duration_seconds({ seconds: 2 }),
		);
		expect(formatFocusedDuration(25 * 60)).toBe(
			m.focus_duration_minutes({ minutes: 25 }),
		);
		expect(formatFocusedDuration(3600 + 5 * 60)).toBe(
			m.focus_duration_hours_minutes({ hours: 1, minutes: "05" }),
		);
	});
});
