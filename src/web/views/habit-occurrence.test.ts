import { describe, expect, it } from "vitest";
import type { FilterCtx, FilterTask } from "../../domain/view-filter.ts";
import {
	habitOccurrence,
	matchesOccurrenceFilter,
} from "./habit-occurrence.ts";

const now = new Date("2026-09-30T12:00:00Z");
const task = {
	id: "habit",
	dueAt: Date.parse("2026-09-18T08:00:00Z"),
	rrule: "FREQ=DAILY",
};
const ctx: FilterCtx = { userId: "u", now, membershipWorkspaceIds: ["w"] };
const filterTask: FilterTask = {
	id: "habit",
	listId: "l",
	workspaceId: "w",
	done: false,
	dueAt: new Date(task.dueAt),
	priority: 0,
	kind: "habits",
	folderId: null,
	labelIds: [],
	assigneeIds: [],
};

describe("habitOccurrence", () => {
	it("resolves the current scheduled day rather than the old anchor", () => {
		const occurrence = habitOccurrence(task, [], now, "Europe/Berlin");
		expect(occurrence).toMatchObject({
			date: "2026-09-30",
			dueAt: Date.parse("2026-09-29T22:00:00Z"),
			done: false,
			status: "pending",
			canToggle: true,
		});
		expect(task.dueAt).toBe(Date.parse("2026-09-18T08:00:00Z"));
	});
	it("reads completion only from this habit's current local-day log", () => {
		const logs = [
			{ habitId: "habit", date: "2026-09-29", status: "done" as const },
			{ habitId: "other", date: "2026-09-30", status: "done" as const },
		];
		expect(habitOccurrence(task, logs, now, "UTC").done).toBe(false);
		expect(
			habitOccurrence(
				task,
				[...logs, { habitId: "habit", date: "2026-09-30", status: "done" }],
				now,
				"UTC",
			).done,
		).toBe(true);
		expect(
			habitOccurrence(
				task,
				[{ habitId: "habit", date: "2026-09-30", status: "skipped" }],
				now,
				"UTC",
			),
		).toMatchObject({ done: false, status: "skipped" });
	});
	it("uses the user's evening day even when UTC is tomorrow", () => {
		const evening = new Date("2026-10-01T02:00:00Z");
		expect(
			habitOccurrence(
				task,
				[{ habitId: "habit", date: "2026-09-30", status: "done" }],
				evening,
				"America/New_York",
			),
		).toMatchObject({ date: "2026-09-30", done: true });
	});
	it("respects weekday schedules, future starts, and interval phase", () => {
		expect(
			habitOccurrence(
				{ ...task, rrule: "FREQ=WEEKLY;BYDAY=MO" },
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2026-10-05", canToggle: false });
		expect(
			habitOccurrence(
				{ ...task, dueAt: Date.parse("2026-10-03T00:00:00Z") },
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2026-10-03", canToggle: false });
		expect(
			habitOccurrence(
				{
					...task,
					dueAt: Date.parse("2026-09-19T00:00:00Z"),
					rrule: "FREQ=DAILY;INTERVAL=2",
				},
				[],
				now,
				"UTC",
			).date,
		).toBe("2026-10-01");
	});
	it("does not invent an occurrence for missing, malformed, or exhausted rules", () => {
		for (const rrule of [null, "garbage", "FREQ=DAILY;COUNT=2"])
			expect(habitOccurrence({ ...task, rrule }, [], now, "UTC")).toMatchObject(
				{ date: null, dueAt: null, canToggle: false },
			);
	});
});

describe("matchesOccurrenceFilter", () => {
	it("matches current habits as today in positive and negative offset zones", () => {
		for (const [timeZone, at] of [
			["Europe/Berlin", now],
			["America/New_York", new Date("2026-10-01T02:00:00Z")],
		] as const) {
			const occurrence = habitOccurrence(task, [], at, timeZone);
			const effective = {
				...filterTask,
				dueAt: new Date(occurrence.dueAt ?? Number.NaN),
			};
			expect(
				matchesOccurrenceFilter(
					effective,
					{
						op: "and",
						conditions: [{ field: "due", operator: "is", value: "today" }],
					},
					{ ...ctx, now: at },
					occurrence,
					timeZone,
				),
			).toBe(true);
			expect(
				matchesOccurrenceFilter(
					effective,
					{
						op: "and",
						conditions: [{ field: "due", operator: "is", value: "overdue" }],
					},
					{ ...ctx, now: at },
					occurrence,
					timeZone,
				),
			).toBe(false);
		}
	});
	it("retains ordinary overdue behavior and nested explicit filters", () => {
		const overdue = {
			op: "and" as const,
			conditions: [{ field: "due" as const, operator: "is", value: "overdue" }],
		};
		expect(
			matchesOccurrenceFilter(
				{ ...filterTask, kind: "tasks" },
				overdue,
				ctx,
				undefined,
				"UTC",
			),
		).toBe(true);
		const occurrence = habitOccurrence(task, [], now, "UTC");
		const effective = {
			...filterTask,
			dueAt: new Date(occurrence.dueAt ?? Number.NaN),
		};
		expect(
			matchesOccurrenceFilter(
				effective,
				{
					op: "and",
					conditions: [
						{
							op: "or",
							conditions: [
								{ field: "due", operator: "is", value: "today" },
								{ field: "done", operator: "is", value: true },
							],
						},
						{ field: "priority", operator: "eq", value: 0 },
						{ field: "due", operator: "before", value: "2026-10-01T00:00:00Z" },
					],
				},
				ctx,
				occurrence,
				"UTC",
			),
		).toBe(true);
		expect(
			matchesOccurrenceFilter(
				effective,
				{
					op: "and",
					conditions: [
						{ field: "due", operator: "before", value: "2026-09-20T00:00:00Z" },
					],
				},
				ctx,
				occurrence,
				"UTC",
			),
		).toBe(false);
	});
});

describe("bounded habit recurrence projection", () => {
	it("caps an old pre-window prefix rather than jumping its epoch", () => {
		expect(
			habitOccurrence(
				{
					...task,
					dueAt: Date.parse("1900-01-01T00:00:00Z"),
					rrule: "FREQ=DAILY;INTERVAL=2",
				},
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: null, status: "unavailable", canToggle: false });
		expect(
			habitOccurrence(
				{
					...task,
					dueAt: Date.parse("1900-01-01T00:00:00Z"),
					rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
				},
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2026-10-05", canToggle: false });
	});
	it("preserves original interval phase and COUNT across changed today dates and mutable due", () => {
		const series = {
			...task,
			recurrenceAnchorAt: Date.parse("2026-09-19T00:00:00Z"),
			recurrenceConsumed: 2,
			dueAt: Date.parse("2026-09-25T00:00:00Z"),
			rrule: "FREQ=DAILY;INTERVAL=2;COUNT=7",
		};
		expect(habitOccurrence(series, [], now, "UTC")).toMatchObject({
			date: "2026-10-01",
			canToggle: false,
		});
		expect(
			habitOccurrence(
				series,
				[{ habitId: "habit", date: "2026-10-01", status: "done" }],
				new Date("2026-10-01T12:00:00Z"),
				"UTC",
			),
		).toMatchObject({ date: "2026-10-01", canToggle: true, done: true });
		expect(
			habitOccurrence(series, [], new Date("2026-10-02T12:00:00Z"), "UTC"),
		).toMatchObject({ date: null, status: null, canToggle: false });
	});
	it("relative virtual habits retain fixed calendar eligibility despite progress and exhaustion", () => {
		const series = {
			...task,
			recurrenceAnchorAt: Date.parse("2026-09-19T00:00:00Z"),
			recurrenceConsumed: 7,
			dueAt: Date.parse("2026-10-06T00:00:00Z"),
			recurrenceRelative: true,
			done: true,
			rrule: "FREQ=DAILY;INTERVAL=2;COUNT=7",
		};
		expect(habitOccurrence(series, [], now, "UTC")).toMatchObject({
			date: "2026-10-01",
			canToggle: false,
		});
		expect(
			habitOccurrence(series, [], new Date("2026-10-02T12:00:00Z"), "UTC"),
		).toMatchObject({ date: null, status: null });
	});
	it("unknown legacy phase needs a start, while unlimited daily retains its date-independent fallback", () => {
		const undated = { ...task, dueAt: null };
		expect(
			habitOccurrence(
				{ ...undated, rrule: "FREQ=DAILY;INTERVAL=2" },
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: null, status: "unavailable", canToggle: false });
		expect(habitOccurrence(undated, [], now, "UTC")).toMatchObject({
			date: "2026-09-30",
			status: "pending",
			canToggle: true,
		});
		expect(
			habitOccurrence(
				{ ...undated, rrule: "FREQ=DAILY;COUNT=2" },
				[{ habitId: "habit", date: "2026-09-01", status: "done" }],
				now,
				"UTC",
			),
		).toMatchObject({ date: null, status: "unavailable" });
	});
	it("advanced date selectors remain supported without a narrow future horizon", () => {
		const series = {
			...task,
			recurrenceAnchorAt: Date.parse("2026-07-01T00:00:00Z"),
			recurrenceConsumed: 0,
		};
		expect(
			habitOccurrence(
				{
					...series,
					rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
				},
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2026-09-30", canToggle: true });
		expect(
			habitOccurrence(
				{ ...series, rrule: "FREQ=MONTHLY;BYDAY=2MO" },
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2026-10-12", canToggle: false });
		expect(
			habitOccurrence(
				{
					...series,
					recurrenceAnchorAt: Date.parse("2026-01-01T00:00:00Z"),
					rrule: "FREQ=YEARLY;INTERVAL=200;BYMONTH=2;BYMONTHDAY=-1",
				},
				[],
				now,
				"UTC",
			),
		).toMatchObject({ date: "2226-02-28", canToggle: false });
	});
	it("UNTIL exhaustion stays tied to the original anchor and inclusive end", () => {
		const series = {
			...task,
			recurrenceAnchorAt: Date.parse("2026-09-19T00:00:00Z"),
			recurrenceConsumed: 1,
			rrule: "FREQ=DAILY;INTERVAL=2;UNTIL=20261001T000000Z",
		};
		expect(habitOccurrence(series, [], now, "UTC").date).toBe("2026-10-01");
		expect(
			habitOccurrence(series, [], new Date("2026-10-02T12:00:00Z"), "UTC"),
		).toMatchObject({ date: null, status: null });
	});
	it("maps persisted anchor into the viewer's day frame rather than using browser UTC", () => {
		const series = {
			...task,
			recurrenceAnchorAt: Date.parse("2026-09-19T01:00:00Z"),
			recurrenceConsumed: 0,
			dueAt: Date.parse("2026-09-25T01:00:00Z"),
			rrule: "FREQ=DAILY;INTERVAL=2",
		};
		expect(
			habitOccurrence(
				series,
				[],
				new Date("2026-10-01T02:00:00Z"),
				"America/New_York",
			),
		).toMatchObject({ date: "2026-09-30", canToggle: true });
	});
	it("refuses sub-day rules and caps complex old series with an explicit unavailable state", () => {
		for (const rrule of [
			"FREQ=SECONDLY",
			"FREQ=MINUTELY",
			"FREQ=HOURLY",
			"FREQ=DAILY;BYSECOND=0,30",
			"FREQ=DAILY;COUNT=1000000",
			"FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
			"FREQ=DAILY;BYMONTH=2;BYMONTHDAY=31",
		])
			expect(
				habitOccurrence(
					{ ...task, dueAt: Date.parse("1900-01-01T00:00:00Z"), rrule },
					[],
					now,
					"UTC",
				),
			).toMatchObject({ date: null, status: "unavailable", canToggle: false });
	});
});
