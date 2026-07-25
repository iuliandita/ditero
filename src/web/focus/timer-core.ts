// Focus/Pomodoro timer logic: config clamping, phase cycling, and formatting.
// No React, no timers, no network -- unit-tested in node. The cycle/config logic
// is pure; phaseLabel and formatFocusedDuration read the active locale, so they
// resolve their message at call time. The store (useFocusTimer.tsx) drives real
// time on top of these functions and computes remaining from timestamps, so tab
// throttling never desyncs the countdown.

import { m } from "../../paraglide/messages.js";

export type Phase = "work" | "break";

export type FocusConfig = {
	workMin: number;
	breakMin: number;
	longBreakMin: number;
	roundsPerLongBreak: number;
	autoCycle: boolean;
};

// Mirrors the userPref.set focus caps (minutes 1..180, rounds 1..12).
export const DEFAULT_FOCUS: FocusConfig = {
	workMin: 25,
	breakMin: 5,
	longBreakMin: 15,
	roundsPerLongBreak: 4,
	autoCycle: true,
};

function clampInt(
	v: unknown,
	lo: number,
	hi: number,
	fallback: number,
): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(hi, Math.max(lo, Math.round(v)));
}

// Coerce an untrusted pref blob (a co-device's stored focus, or first-run null)
// into a valid config, clamping to the same caps the mutator enforces server-side.
export function clampFocusConfig(raw: unknown): FocusConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_FOCUS };
	const r = raw as Record<string, unknown>;
	return {
		workMin: clampInt(r.workMin, 1, 180, DEFAULT_FOCUS.workMin),
		breakMin: clampInt(r.breakMin, 1, 180, DEFAULT_FOCUS.breakMin),
		longBreakMin: clampInt(r.longBreakMin, 1, 180, DEFAULT_FOCUS.longBreakMin),
		roundsPerLongBreak: clampInt(
			r.roundsPerLongBreak,
			1,
			12,
			DEFAULT_FOCUS.roundsPerLongBreak,
		),
		autoCycle:
			typeof r.autoCycle === "boolean" ? r.autoCycle : DEFAULT_FOCUS.autoCycle,
	};
}

// A point in the pomodoro cycle. `round` is the 1-based work-session index within
// the current long-break group; `isLongBreak` only means anything while phase is
// "break".
export type Cycle = { phase: Phase; round: number; isLongBreak: boolean };

export const INITIAL_CYCLE: Cycle = {
	phase: "work",
	round: 1,
	isLongBreak: false,
};

// The break that follows work session `round` is a long break every
// roundsPerLongBreak sessions.
export function isLongBreakAfter(round: number, cfg: FocusConfig): boolean {
	return round % cfg.roundsPerLongBreak === 0;
}

// work(r) -> break(r); break(r) -> work(r+1), resetting to work(1) after a long
// break so the group restarts.
export function nextCycle(cur: Cycle, cfg: FocusConfig): Cycle {
	if (cur.phase === "work") {
		return {
			phase: "break",
			round: cur.round,
			isLongBreak: isLongBreakAfter(cur.round, cfg),
		};
	}
	return {
		phase: "work",
		round: cur.isLongBreak ? 1 : cur.round + 1,
		isLongBreak: false,
	};
}

export function phaseDurationSec(cycle: Cycle, cfg: FocusConfig): number {
	if (cycle.phase === "work") return cfg.workMin * 60;
	return (cycle.isLongBreak ? cfg.longBreakMin : cfg.breakMin) * 60;
}

// Whole seconds left, floored at 0 and rounded up so a countdown shows "00:01"
// for any sub-second remainder rather than flicking to "00:00" early.
export function remainingSecFrom(endsAt: number, now: number): number {
	return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

// Digit-pair countdown, not a locale-sensitive duration format.
export function formatMMSS(sec: number): string {
	const s = Math.max(0, Math.floor(sec));
	const min = Math.floor(s / 60);
	const r = s % 60;
	return `${String(min).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function phaseLabel(cycle: Cycle): string {
	if (cycle.phase === "work") return m.focus_phase_work();
	return cycle.isLongBreak ? m.focus_phase_long_break() : m.focus_phase_break();
}

// Human total time-on-task for the detail surface. Sub-minute values (only real
// with tiny sessions or the e2e time seam) read in seconds; otherwise minutes,
// then hours + minutes.
export function formatFocusedDuration(totalSec: number): string {
	const s = Math.max(0, Math.floor(totalSec));
	if (s < 60) return m.focus_duration_seconds({ seconds: s });
	const h = Math.floor(s / 3600);
	const min = Math.floor((s % 3600) / 60);
	if (h > 0)
		// {minutes} is deliberately a pre-padded string here ("1h 05m"), unlike the
		// bare number below -- it must never be run through a number formatter.
		return m.focus_duration_hours_minutes({
			hours: h,
			minutes: String(min).padStart(2, "0"),
		});
	return m.focus_duration_minutes({ minutes: min });
}
