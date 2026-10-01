import { RRule } from "rrule";
import { localDay, shiftDay } from "../../domain/local-day.ts";
import { projectRecurrence } from "../../domain/recurrence.ts";
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
	recurrenceAnchorAt?: number | null;
	recurrenceConsumed?: number | null;
	recurrenceRelative?: boolean | null;
	done?: boolean | null;
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
	const unavailable: HabitOccurrence = { ...empty, status: "unavailable" };
	try {
		const options = RRule.parseString(task.rrule);
		if (options.freq == null) return unavailable;
		// Habits have one check-in per calendar day, not sub-day occurrences.
		if (
			options.freq > RRule.DAILY ||
			options.byhour != null ||
			options.byminute != null ||
			options.bysecond != null
		)
			return unavailable;
		const frame = (timestamp: number | null | undefined) =>
			timestamp == null
				? null
				: new Date(`${localDay(new Date(timestamp), timeZone)}T00:00:00Z`);
		// Search through the evaluator's supported date domain, not a UI horizon.
		const projected = projectRecurrence(
			{
				rrule: task.rrule,
				anchorAt: frame(task.recurrenceAnchorAt),
				dueAt: frame(task.dueAt),
				consumed: task.recurrenceConsumed ?? null,
				relative: task.recurrenceRelative ?? false,
				exhausted: task.done ?? false,
			},
			new Date(`${today}T00:00:00Z`),
			new Date("9999-12-31T23:59:59.999Z"),
			{
				includePast: true,
				maxOutput: 1,
			},
		);
		// The first ordered result proves the earliest eligible day even if later
		// traversal caps. No result on a cap is unknown, not series exhaustion.
		const date = projected.occurrences[0]?.toISOString().slice(0, 10) ?? null;
		if (date == null)
			return projected.status === "complete" ? empty : unavailable;
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
		return unavailable;
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
