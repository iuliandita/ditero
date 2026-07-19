import { RRule } from "rrule";
import { DAY_MS, instantToWallClock, wallClockToInstant } from "./zoned.ts";

export type ReminderSource = {
	taskId: string;
	reminderTime: string | null;
	rrule: string | null;
	dueAt: Date | null;
	done: boolean;
};

export type DueOccurrence = { taskId: string; occurrenceAt: Date };

export type ReminderWindowResult = {
	occurrences: DueOccurrence[];
	// Task ids where a cap engaged, so the result may be an incomplete view of
	// that task's due occurrences in this window. Callers must not treat this
	// as "the task legitimately has no more reminders" -- see the caps below.
	cappedTaskIds: string[];
};

// Distinct-date cap: bounds output size (and, downstream, outbox/DB writes
// per task per tick).
export const MAX_OCCURRENCES_PER_TASK = 64;

// Hard ceiling on rrule iterator callbacks per task, independent of the
// distinct-date cap above: the iterator fires once per *occurrence*, and
// occurrences-per-calendar-date is unbounded (FREQ=SECONDLY etc), so the
// distinct-date cap alone does not bound iteration work -- a single
// FREQ=SECONDLY task over a 3-day widened window took ~4s wall-clock before
// this cap existed. 1000 gives ample headroom over the worst realistic
// legitimate case (hourly reminders over a week-long grace-plus-widening
// window: 24/day * ~9 days =~ 216) while keeping a pathological rule cheap
// (well under a millisecond of iteration work).
export const MAX_ITERATIONS_PER_TASK = 1000;

// Two independent effects stack, so a 1-day pad is not enough: (1) a local
// calendar date can span up to ~26 hours of UTC on a DST fall-back day (a
// "25-hour day" plus the usual 1-hour slack from probing the offset a day
// out in zoned.ts), and (2) reminderTime can sit up to a full day away from
// the occurrence instant that produced its calendar date. 2 * DAY_MS covers
// both with margin. Over-widening is harmless: the final `at >= from && at <
// to` filter below discards anything outside the real window, and the
// iteration cap already bounds the added cost.
const WINDOW_PAD_MS = 2 * DAY_MS;

export function reminderWindow(
	sources: ReminderSource[],
	timeZone: string,
	from: Date,
	to: Date,
): ReminderWindowResult {
	const occurrences: DueOccurrence[] = [];
	const cappedTaskIds: string[] = [];
	for (const src of sources) {
		if (!src.reminderTime) continue;
		if (src.done && !src.rrule) continue;
		if (!src.dueAt) continue;

		const { dates, capped } = occurrenceDates(src, timeZone, from, to);
		if (capped) cappedTaskIds.push(src.taskId);

		// RRULE time-of-day components (BYHOUR/BYMINUTE/BYSECOND) are
		// intentionally discarded here: reminderTime is the single source of
		// time-of-day, by product design, so every occurrence collapses to its
		// calendar date and is re-timed from reminderTime alone. A rule like
		// FREQ=DAILY;BYHOUR=9,15 still yields one reminder per day, not two --
		// working as intended, not a bug.
		for (const date of dates) {
			const at = wallClockToInstant(date, src.reminderTime, timeZone);
			if (at >= from && at < to) {
				occurrences.push({ taskId: src.taskId, occurrenceAt: at });
			}
		}
	}
	return { occurrences, cappedTaskIds };
}

// Reminder-window queries need dtstart pinned to the task's own dueAt (the
// recurrence series anchor) rather than the scan window -- unlike
// recurrence.expand(), which anchors dtstart to its `from` and so can't serve
// an arbitrary window far from the series start. Iteration is capped inside
// the between() callback (same pattern recurrence.expand uses) so a
// pathological rule (FREQ=MINUTELY) can't materialize an unbounded array
// before the cap applies.
function occurrenceDates(
	src: ReminderSource,
	timeZone: string,
	from: Date,
	to: Date,
): { dates: string[]; capped: boolean } {
	if (!src.dueAt) return { dates: [], capped: false };
	if (!src.rrule) {
		return {
			dates: [instantToWallClock(src.dueAt, timeZone).date],
			capped: false,
		};
	}

	const o = RRule.parseString(src.rrule); // throws on malformed input
	if (o.freq == null) {
		throw new Error(`reminder-window: RRULE missing FREQ: ${src.rrule}`);
	}
	const rule = new RRule({ ...o, dtstart: src.dueAt });

	const widenedFrom = new Date(from.getTime() - WINDOW_PAD_MS);
	const widenedTo = new Date(to.getTime() + WINDOW_PAD_MS);

	// Dates are collected in iteration (== chronological) order, so a cap
	// always keeps the earliest dates and drops the latest. That only matters
	// if a single scan spans more than MAX_OCCURRENCES_PER_TASK distinct
	// dates, which the grace window (about an hour, per the scheduler design)
	// makes unreachable in normal operation -- it only shows up in synthetic
	// windows like the cap test below.
	const seen = new Set<string>();
	let iterations = 0;
	rule.between(widenedFrom, widenedTo, true, (date) => {
		iterations++;
		seen.add(instantToWallClock(date, timeZone).date);
		return (
			iterations < MAX_ITERATIONS_PER_TASK &&
			seen.size < MAX_OCCURRENCES_PER_TASK
		);
	});
	// A cap reaching its limit on the very last relevant occurrence (nothing
	// left to drop) is reported as capped too -- a false positive is safe
	// here, a false negative (silently incomplete data reported as complete)
	// is not.
	const capped =
		iterations >= MAX_ITERATIONS_PER_TASK ||
		seen.size >= MAX_OCCURRENCES_PER_TASK;
	return { dates: [...seen], capped };
}
