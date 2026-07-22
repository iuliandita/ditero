import { positiveInt } from "./env.ts";

export type SchedulerTiming = {
	tickMs: number;
	graceMs: number;
	lateThresholdMs: number;
};

export const DEFAULT_TICK_MS = 30_000;
// The overdue sweep is idempotent per recipient local day, so anything past the
// first sweep of that day is pure waste. Hours, not ticks: it deliberately does
// NOT follow the scan tick.
export const DEFAULT_OVERDUE_SWEEP_MS = 3_600_000;
export const DEFAULT_GRACE_MS = 3_600_000;
export const DEFAULT_LATE_THRESHOLD_MS = 60_000;

type SchedulerEnvironment = Record<string, string | undefined> & {
	DITERO_SCHEDULER_TICK_MS?: string;
	DITERO_SCHEDULER_GRACE_MS?: string;
	DITERO_SCHEDULER_LATE_THRESHOLD_MS?: string;
};

export function schedulerTiming(env: SchedulerEnvironment): SchedulerTiming {
	const timing: SchedulerTiming = {
		tickMs: positiveInt(
			"DITERO_SCHEDULER_TICK_MS",
			env.DITERO_SCHEDULER_TICK_MS,
			DEFAULT_TICK_MS,
		),
		graceMs: positiveInt(
			"DITERO_SCHEDULER_GRACE_MS",
			env.DITERO_SCHEDULER_GRACE_MS,
			DEFAULT_GRACE_MS,
		),
		lateThresholdMs: positiveInt(
			"DITERO_SCHEDULER_LATE_THRESHOLD_MS",
			env.DITERO_SCHEDULER_LATE_THRESHOLD_MS,
			DEFAULT_LATE_THRESHOLD_MS,
		),
	};
	// A reminder can always be up to one tick old by the time a tick sees it,
	// so a threshold under two ticks reports ordinary scheduling delay as
	// lateness and destroys the operator signal fired_late exists to give.
	if (timing.lateThresholdMs < 2 * timing.tickMs) {
		throw new Error(
			`DITERO_SCHEDULER_LATE_THRESHOLD_MS (${timing.lateThresholdMs}) must be at least twice DITERO_SCHEDULER_TICK_MS (${timing.tickMs})`,
		);
	}
	if (timing.graceMs < timing.tickMs) {
		throw new Error(
			`DITERO_SCHEDULER_GRACE_MS (${timing.graceMs}) must be at least DITERO_SCHEDULER_TICK_MS (${timing.tickMs}); a grace window shorter than the tick drops reminders between ticks`,
		);
	}
	return timing;
}

export function overdueSweepMs(
	env: Record<string, string | undefined>,
): number {
	return positiveInt(
		"DITERO_OVERDUE_SWEEP_MS",
		env.DITERO_OVERDUE_SWEEP_MS,
		DEFAULT_OVERDUE_SWEEP_MS,
	);
}
