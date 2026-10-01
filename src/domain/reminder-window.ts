import { projectRecurrence } from "./recurrence.ts";
import { DAY_MS, instantToWallClock, wallClockToInstant } from "./zoned.ts";

export type ReminderSource = {
	taskId: string;
	reminderTime: string | null;
	rrule: string | null;
	dueAt: Date | null;
	done: boolean;
	recurrenceAnchorAt?: Date | null;
	recurrenceConsumed?: number | null;
	recurrenceRelative?: boolean;
	listKind?: string;
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

// Bounds emitted candidates independently of the distinct-date cap. The shared
// evaluator also bounds pre-window periods, selector work, and allocations.
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
		if (!src.dueAt && !src.rrule) continue;

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

function occurrenceDates(
	src: ReminderSource,
	timeZone: string,
	from: Date,
	to: Date,
): { dates: string[]; capped: boolean } {
	if (!src.rrule) {
		return {
			dates: src.dueAt ? [instantToWallClock(src.dueAt, timeZone).date] : [],
			capped: false,
		};
	}
	const virtual = src.listKind === "habits";
	const dayFrame = (date: Date) =>
		new Date(`${instantToWallClock(date, timeZone).date}T00:00:00Z`);
	const frame = (date: Date | null | undefined) =>
		date == null ? null : virtual ? dayFrame(date) : date;
	const widenedFrom = new Date(from.getTime() - WINDOW_PAD_MS);
	const widenedTo = new Date(to.getTime() + WINDOW_PAD_MS);
	const projected = projectRecurrence(
		{
			rrule: src.rrule,
			relative: src.recurrenceRelative ?? false,
			anchorAt: frame(src.recurrenceAnchorAt),
			dueAt: frame(src.dueAt),
			consumed: src.recurrenceConsumed ?? null,
			exhausted: src.done,
		},
		virtual ? dayFrame(widenedFrom) : widenedFrom,
		virtual ? dayFrame(widenedTo) : widenedTo,
		{
			includePast: virtual,
			maxOutput: MAX_ITERATIONS_PER_TASK,
		},
	);
	const seen = new Set<string>();
	for (const date of projected.occurrences) {
		seen.add(
			virtual
				? date.toISOString().slice(0, 10)
				: instantToWallClock(date, timeZone).date,
		);
		if (seen.size >= MAX_OCCURRENCES_PER_TASK) break;
	}
	return {
		dates: [...seen],
		capped:
			projected.status !== "complete" || seen.size >= MAX_OCCURRENCES_PER_TASK,
	};
}
