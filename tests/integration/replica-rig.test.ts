// The rig's reminder fixture, checked against the real scan window at every
// minute of a UTC day. Pure -- no database, no replicas.
//
// Issue #95: a fixture that derives "HH:MM, N minutes ago" from one instant but
// anchors dueAt to another disagrees with the scan whenever those two instants
// fall on different UTC dates, and the reminder is then never created at all.
// The bug is invisible for 1410 minutes out of 1440, which is why it only ever
// surfaced as an intermittent CI timeout.
import { describe, expect, test } from "vitest";
import { reminderWindow } from "../../src/domain/reminder-window.ts";
import { RIG_TIMING, reminderAnchor } from "./replica-rig.ts";

const GRACE_MS = RIG_TIMING.graceMs;
const DAY = Date.UTC(2026, 7, 16);

// Exactly what the scheduler does with a seeded row: expand the task over
// [now - grace, now) in the list owner's zone, which the fixture seeds as UTC.
function occurrencesAt(nowMs: number, minutesAgo: number): Date[] {
	const anchor = reminderAnchor(minutesAgo, new Date(nowMs));
	return reminderWindow(
		[
			{
				taskId: "t",
				reminderTime: anchor.reminderTime,
				rrule: null,
				dueAt: anchor.dueAt,
				done: false,
			},
		],
		"UTC",
		new Date(nowMs - GRACE_MS),
		new Date(nowMs),
	).occurrences.map((o) => o.occurrenceAt);
}

// Mid-minute, so the assertions are not sitting on a second boundary.
const minuteOfDay = (minute: number) => DAY + minute * 60_000 + 30_000;
const label = (minute: number) =>
	`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

describe("rig reminder fixture", () => {
	// 0 and 2 are the defaults the crash and two-replica suites lean on; 30 is
	// the one that made #95 visible, because its window is the widest.
	for (const minutesAgo of [0, 2, 30]) {
		test(`minutesAgo ${minutesAgo} lands inside the scan window at every minute of the day`, () => {
			const missed: string[] = [];
			const misplaced: string[] = [];
			for (let minute = 0; minute < 1440; minute++) {
				const nowMs = minuteOfDay(minute);
				const found = occurrencesAt(nowMs, minutesAgo);
				if (found.length !== 1) {
					missed.push(`${label(minute)} (${found.length} occurrences)`);
					continue;
				}
				// Truncated to the minute on both sides: reminderTime carries no
				// seconds, and the fixture's own instant does.
				const expected =
					Math.floor((nowMs - minutesAgo * 60_000) / 60_000) * 60_000;
				if (found[0].getTime() !== expected) {
					misplaced.push(
						`${label(minute)} -> ${found[0].toISOString()}, expected ${new Date(expected).toISOString()}`,
					);
				}
			}
			expect(missed).toEqual([]);
			expect(misplaced).toEqual([]);
		});
	}

	// The mid-claim test seeds at 180 minutes precisely so the scan does NOT
	// create a reminder for it and the directly-inserted outbox rows are the
	// only ones in play. That has to hold at every minute too, or the crash
	// suite's row counts move.
	test("minutesAgo 180 stays outside the one-hour grace window all day", () => {
		const fired: string[] = [];
		for (let minute = 0; minute < 1440; minute++) {
			if (occurrencesAt(minuteOfDay(minute), 180).length > 0) {
				fired.push(label(minute));
			}
		}
		expect(fired).toEqual([]);
	});
});
