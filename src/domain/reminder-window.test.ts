import { describe, expect, it } from "vitest";
import { type ReminderSource, reminderWindow } from "./reminder-window.ts";

const TZ = "Europe/Bucharest";

function source(over: Partial<ReminderSource> = {}): ReminderSource {
	return {
		taskId: "t1",
		reminderTime: "08:00",
		rrule: null,
		dueAt: new Date("2026-07-15T00:00:00Z"),
		done: false,
		...over,
	};
}

describe("reminderWindow", () => {
	it("returns a one-off task's reminder inside the window", () => {
		const { occurrences, cappedTaskIds } = reminderWindow(
			[source()],
			TZ,
			new Date("2026-07-15T04:00:00Z"),
			new Date("2026-07-15T06:00:00Z"),
		);
		expect(occurrences).toEqual([
			{ taskId: "t1", occurrenceAt: new Date("2026-07-15T05:00:00Z") },
		]);
		expect(cappedTaskIds).toEqual([]);
	});

	it("excludes a reminder outside the window", () => {
		const { occurrences } = reminderWindow(
			[source()],
			TZ,
			new Date("2026-07-15T06:00:00Z"),
			new Date("2026-07-15T07:00:00Z"),
		);
		expect(occurrences).toEqual([]);
	});

	it("excludes tasks with no reminder time", () => {
		const { occurrences } = reminderWindow(
			[source({ reminderTime: null })],
			TZ,
			new Date("2026-07-15T00:00:00Z"),
			new Date("2026-07-16T00:00:00Z"),
		);
		expect(occurrences).toEqual([]);
	});

	it("excludes completed non-recurring tasks", () => {
		const { occurrences } = reminderWindow(
			[source({ done: true })],
			TZ,
			new Date("2026-07-15T00:00:00Z"),
			new Date("2026-07-16T00:00:00Z"),
		);
		expect(occurrences).toEqual([]);
	});

	it("expands a daily recurrence across a multi-day window", () => {
		const { occurrences } = reminderWindow(
			[
				source({
					rrule: "FREQ=DAILY",
					dueAt: new Date("2026-07-15T00:00:00Z"),
				}),
			],
			TZ,
			new Date("2026-07-15T00:00:00Z"),
			new Date("2026-07-18T00:00:00Z"),
		);
		expect(occurrences.map((o) => o.occurrenceAt.toISOString())).toEqual([
			"2026-07-15T05:00:00.000Z",
			"2026-07-16T05:00:00.000Z",
			"2026-07-17T05:00:00.000Z",
		]);
	});

	// Spring-forward makes a 23-hour local day, which a naive 24-hour pad
	// over-covers -- this is the "easy direction". It does NOT exercise the
	// fall-back / 25-hour-day failure mode below; DAILY additionally masks
	// that failure mode via same-day neighbor rescue (see the fall-back block
	// further down for cases that isolate it).
	it("holds wall-clock across a DST spring-forward transition", () => {
		const { occurrences } = reminderWindow(
			[
				source({
					rrule: "FREQ=DAILY",
					dueAt: new Date("2026-03-28T00:00:00Z"),
				}),
			],
			TZ,
			new Date("2026-03-28T00:00:00Z"),
			new Date("2026-03-31T00:00:00Z"),
		);
		expect(occurrences.map((o) => o.occurrenceAt.toISOString())).toEqual([
			"2026-03-28T06:00:00.000Z",
			"2026-03-29T05:00:00.000Z",
			"2026-03-30T05:00:00.000Z",
		]);
	});

	// DST fall-back (Bucharest, 2026-10-25): the local calendar day is ~25
	// hours long, so a task due at 2026-10-24T21:00:00Z (pre-transition, +3
	// offset) already reads as local 2026-10-25T00:00, one calendar date past
	// its UTC date. A late reminderTime (23:59) re-derives an instant
	// (21:59 UTC) that a 1-day-widened window narrowly misses -- this was the
	// reproduction for the widening bug. None of these three use FREQ=DAILY
	// with INTERVAL=1, so no adjacent daily occurrence can rescue the date via
	// the distinct-date Set: each isolates the pad's correctness on its own.
	describe("across a DST fall-back transition", () => {
		const dueAt = new Date("2026-10-24T21:00:00Z");
		const reminderTime = "23:59";
		const from = new Date("2026-10-25T21:59:00Z");
		const to = new Date("2026-10-25T21:59:30Z");
		const expected = [
			{ taskId: "t1", occurrenceAt: new Date("2026-10-25T21:59:00Z") },
		];

		it("fires a weekly reminder", () => {
			const { occurrences } = reminderWindow(
				[source({ rrule: "FREQ=WEEKLY", dueAt, reminderTime })],
				TZ,
				from,
				to,
			);
			expect(occurrences).toEqual(expected);
		});

		it("fires a monthly reminder", () => {
			const { occurrences } = reminderWindow(
				[source({ rrule: "FREQ=MONTHLY", dueAt, reminderTime })],
				TZ,
				from,
				to,
			);
			expect(occurrences).toEqual(expected);
		});

		it("fires a every-other-day reminder with no adjacent occurrence to rescue it", () => {
			const { occurrences } = reminderWindow(
				[source({ rrule: "FREQ=DAILY;INTERVAL=2", dueAt, reminderTime })],
				TZ,
				from,
				to,
			);
			expect(occurrences).toEqual(expected);
		});
	});

	it("collapses RRULE time-of-day (BYHOUR) to one reminder per date, since reminderTime is the sole time-of-day source", () => {
		const { occurrences } = reminderWindow(
			[
				source({
					rrule: "FREQ=DAILY;BYHOUR=9,15;BYMINUTE=0;BYSECOND=0",
					dueAt: new Date("2026-01-01T00:00:00Z"),
				}),
			],
			TZ,
			new Date("2026-01-01T00:00:00Z"),
			new Date("2026-01-03T00:00:00Z"),
		);
		expect(occurrences.map((o) => o.occurrenceAt.toISOString())).toEqual([
			"2026-01-01T06:00:00.000Z",
			"2026-01-02T06:00:00.000Z",
		]);
	});

	it("caps distinct-date expansion and reports the task as capped", () => {
		const { occurrences, cappedTaskIds } = reminderWindow(
			[
				source({
					rrule: "FREQ=DAILY",
					dueAt: new Date("2026-01-01T00:00:00Z"),
				}),
			],
			TZ,
			// 90-day window, well past the 64-distinct-date cap for a daily rule.
			new Date("2026-01-01T00:00:00Z"),
			new Date("2026-04-01T00:00:00Z"),
		);
		expect(occurrences).toHaveLength(64);
		expect(cappedTaskIds).toEqual(["t1"]);
	});

	it("bounds iteration work itself, not just the output, for an ultra-high-frequency rule", () => {
		const started = performance.now();
		const { occurrences, cappedTaskIds } = reminderWindow(
			[
				source({
					rrule: "FREQ=SECONDLY",
					dueAt: new Date("2026-07-15T00:00:00Z"),
				}),
			],
			TZ,
			new Date("2026-07-15T00:00:00Z"),
			new Date("2026-07-20T00:00:00Z"),
		);
		const elapsedMs = performance.now() - started;

		// Primary assertion: the iteration cap actually engaged. A timing-only
		// assertion can't tell a real cap from a lucky fast run.
		expect(cappedTaskIds).toEqual(["t1"]);

		// The cap engaging must not silently degrade to an empty/garbage result:
		// the occurrence(s) it does return must still be correctly computed.
		expect(occurrences.length).toBeGreaterThan(0);
		for (const occurrence of occurrences) {
			expect(occurrence.taskId).toBe("t1");
			expect(occurrence.occurrenceAt.toISOString()).toBe(
				"2026-07-15T05:00:00.000Z",
			);
		}

		// Backstop: unbounded, this took ~4s wall-clock for a 3-day window.
		// Loose enough not to flake on a slow CI box, tight enough to fail hard
		// if the iteration cap is ever removed.
		expect(elapsedMs).toBeLessThan(500);
	});

	it("throws on a malformed reminderTime rather than swallowing it", () => {
		expect(() =>
			reminderWindow(
				[source({ reminderTime: "8:00" })],
				TZ,
				new Date("2026-07-15T00:00:00Z"),
				new Date("2026-07-16T00:00:00Z"),
			),
		).toThrow();
	});

	it("throws on an unknown timezone rather than swallowing it", () => {
		expect(() =>
			reminderWindow(
				[source()],
				"Not/AZone",
				new Date("2026-07-15T00:00:00Z"),
				new Date("2026-07-16T00:00:00Z"),
			),
		).toThrow();
	});
});
