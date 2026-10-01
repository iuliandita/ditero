import { RRule } from "rrule";
import { localDay, shiftDay } from "../../domain/local-day.ts";
import { rruleToPreset } from "../../domain/recurrence.ts";
import {
	type FilterCtx,
	type FilterGroup,
	type FilterNode,
	type FilterTask,
	isGroup,
	taskMatchesFilter,
} from "../../domain/view-filter.ts";
import { wallClockToInstant } from "../../domain/zoned.ts";

export type HabitOccurrence = {
	date: string | null;
	dueAt: number | null;
	done: boolean;
	canToggle: boolean;
	status: "done" | "skipped" | "pending" | "unavailable" | null;
};
export type HabitOccurrenceTask = {
	id: string;
	dueAt?: number | null;
	rrule?: string | null;
};
export type OccurrenceLog = {
	habitId: string;
	date: string;
	status: "done" | "skipped";
};

// Habit schedules and logs use calendar days. An ordinary task's dueAt is an
// instant; a habit's dueAt anchors a series, never an overdue occurrence.
export function habitOccurrence(
	task: HabitOccurrenceTask,
	logs: readonly OccurrenceLog[],
	now: Date,
	timeZone: string,
	today = localDay(now, timeZone),
): HabitOccurrence {
	const empty: HabitOccurrence = {
		date: null,
		dueAt: null,
		done: false,
		canToggle: false,
		status: null,
	};
	if (!task.rrule) return empty;
	const anchor =
		task.dueAt == null ? today : localDay(new Date(task.dueAt), timeZone);
	try {
		const options = RRule.parseString(task.rrule);
		if (options.freq == null) return empty;
		const unavailable: HabitOccurrence = { ...empty, status: "unavailable" };
		// A habit is one check-in per calendar day. Sub-day recurrence must not
		// enumerate millions of old instants in the rendering thread.
		if (
			options.freq > RRule.DAILY ||
			options.byhour != null ||
			options.byminute != null ||
			options.bysecond != null
		)
			return unavailable;
		// Iteration callbacks cap emitted dates, not internal scanning. An
		// impossible complex rule can scan to year 9999 without emitting once.
		// Project only the editor's supported shapes, with finite COUNT/UNTIL
		// modifiers; keep every other stored rule intact and visibly unavailable.
		const projectionRule = task.rrule
			.split(";")
			.filter(
				(part) => !part.startsWith("COUNT=") && !part.startsWith("UNTIL="),
			)
			.join(";");
		const supported = rruleToPreset(projectionRule);
		if (
			!supported ||
			!Number.isInteger(supported.interval) ||
			supported.interval < 1 ||
			(supported.freq === "monthly" &&
				(!Number.isInteger(supported.monthday) ||
					supported.monthday < 1 ||
					supported.monthday > 31)) ||
			(supported.freq === "weekly" &&
				supported.weekdays.some(
					(day) => !Number.isInteger(day) || day < 0 || day > 6,
				))
		)
			return unavailable;
		const start = new Date(`${today}T00:00:00Z`);
		let epoch = new Date(`${anchor}T00:00:00Z`);
		const preset = rruleToPreset(task.rrule);
		if (preset?.freq === "daily" || preset?.freq === "weekly") {
			const period =
				preset.interval * (preset.freq === "weekly" ? 7 : 1) * 86_400_000;
			const elapsed = Math.max(
				0,
				Math.floor((start.getTime() - epoch.getTime()) / period),
			);
			epoch = new Date(epoch.getTime() + elapsed * period);
		}
		const rule = new RRule({ ...options, dtstart: epoch });
		let found: Date | null = null;
		let capped = false;
		rule.all((date, index) => {
			if (index >= 512) {
				capped = true;
				return false;
			}
			if (date >= start) {
				found = date;
				return false;
			}
			return true;
		});
		if (capped) return unavailable;
		const date = (found as Date | null)?.toISOString().slice(0, 10) ?? null;
		if (date == null) return empty;
		const status =
			logs.find((log) => log.habitId === task.id && log.date === date)
				?.status ?? "pending";
		return {
			date,
			dueAt: wallClockToInstant(date, "00:00", timeZone).getTime(),
			done: status === "done",
			canToggle: date === today,
			status,
		};
	} catch {
		return empty;
	}
}

// Only habit relative-day predicates use occurrence dates. Ordinary tasks and
// explicit before/after filters retain their existing instant semantics.
export function matchesOccurrenceFilter(
	task: FilterTask,
	filter: FilterGroup,
	ctx: FilterCtx,
	occurrence: HabitOccurrence | undefined,
	timeZone: string,
	today = localDay(ctx.now, timeZone),
): boolean {
	if (!occurrence) return taskMatchesFilter(task, filter, ctx);
	const evaluate = (node: FilterNode): boolean => {
		if (isGroup(node)) {
			if (node.conditions.length === 0) return true;
			return node.op === "and"
				? node.conditions.every(evaluate)
				: node.conditions.some(evaluate);
		}
		if (node.field === "due" && node.operator === "is") {
			const date = occurrence.date;
			switch (node.value) {
				case "none":
					return date == null;
				case "today":
					return date === today;
				case "overdue":
					return date != null && date < today && !occurrence.done;
				case "next7":
					return date != null && date >= today && date < shiftDay(today, 7);
			}
		}
		return taskMatchesFilter(task, { op: "and", conditions: [node] }, ctx);
	};
	return evaluate(filter);
}
