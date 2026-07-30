import { describe, expect, test } from "vitest";
import { type FocusStatsSession, focusStats } from "./focus-stats.ts";

const now = new Date("2026-07-16T12:00:00Z");
const UTC = "UTC";
const NY = "America/New_York";

const s = (
	startedAt: string,
	durationSec = 1500,
	kind = "work",
): FocusStatsSession => ({
	kind,
	startedAt: Date.parse(startedAt),
	durationSec,
});

describe("focusStats: today", () => {
	test("counts work sessions started within the day", () => {
		const sessions = [
			s("2026-07-16T00:01:00Z"), // just inside
			s("2026-07-16T23:59:00Z"), // late but same day (now is noon; day-based)
			s("2026-07-15T23:59:00Z"), // previous day
		];
		expect(focusStats(sessions, "today", now, UTC)).toEqual({
			count: 2,
			minutes: 50,
		});
	});

	test("day boundary: 23:59 yesterday out, 00:01 today in", () => {
		expect(
			focusStats([s("2026-07-15T23:59:00Z")], "today", now, UTC).count,
		).toBe(0);
		expect(
			focusStats([s("2026-07-16T00:01:00Z")], "today", now, UTC).count,
		).toBe(1);
	});
});

describe("focusStats: week", () => {
	test("last 7 days including today: edge in, day 8 out", () => {
		const sessions = [
			s("2026-07-10T00:00:00Z"), // exactly 6 days back -> included
			s("2026-07-09T23:59:00Z"), // 7 days back -> excluded
			s("2026-07-16T08:00:00Z"), // today -> included
		];
		expect(focusStats(sessions, "week", now, UTC).count).toBe(2);
	});

	test("future sessions past today are excluded", () => {
		expect(
			focusStats([s("2026-07-17T01:00:00Z")], "week", now, UTC).count,
		).toBe(0);
	});
});

// The bug this signature exists for: an evening session west of UTC has a UTC
// date of the NEXT day, so it used to fall outside "today" for the user who
// just recorded it.
//
// Every instant below is chosen so the UTC date and the New York date actually
// DISAGREE. New York in July is UTC-4, so the two only diverge after 20:00
// local -- an "evening" of 19:30 is still the same UTC date and would prove
// nothing.
describe("focusStats: the day is the user's, not UTC's", () => {
	// 21:30 Jul 16 in New York, but already Jul 17 in UTC.
	const lateEvening = s("2026-07-17T01:30:00Z");
	const duringJul16NY = new Date("2026-07-16T16:00:00Z"); // 12:00 Jul 16 NY

	test("a late-evening session counts toward the evening the user is in", () => {
		expect(focusStats([lateEvening], "today", duringJul16NY, NY).count).toBe(1);
	});

	test("the same pair read in UTC disagrees, which is the bug", () => {
		// UTC calls the session Jul 17 and `now` Jul 16, so it falls out of range.
		expect(focusStats([lateEvening], "today", duringJul16NY, UTC).count).toBe(
			0,
		);
	});

	test("'today' itself is the user's day, not the UTC day", () => {
		// 23:30 Nov 3 in New York (EST, UTC-5) is already Nov 4 in UTC.
		const lateNov3NY = new Date("2026-11-04T04:30:00Z");
		const nov3Session = s("2026-11-03T20:00:00Z"); // 15:00 Nov 3 NY
		expect(focusStats([nov3Session], "today", lateNov3NY, NY).count).toBe(1);
		// Reading `now` as UTC puts today at Nov 4, so a Nov 3 session drops out.
		expect(focusStats([nov3Session], "today", lateNov3NY, UTC).count).toBe(0);
	});

	// A week spanning a DST transition is 7 calendar days but 169 hours.
	// Subtracting 6 x 24h from the instant lands on the wrong local day and
	// clips a day off the window; shiftDay counts calendar days instead.
	test("the week window is 7 calendar days across a DST transition", () => {
		// US DST ends 2026-11-01. At 23:30 Nov 3 local, the window is Oct 28..Nov 3.
		// Instant math would put the start at Oct 29 and wrongly exclude Oct 28.
		const lateNov3NY = new Date("2026-11-04T04:30:00Z");
		const oct28 = s("2026-10-28T16:00:00Z"); // 12:00 Oct 28 NY -> in
		const oct27 = s("2026-10-27T16:00:00Z"); // 12:00 Oct 27 NY -> out
		expect(focusStats([oct28], "week", lateNov3NY, NY).count).toBe(1);
		expect(focusStats([oct27], "week", lateNov3NY, NY).count).toBe(0);
	});
});

describe("focusStats: filtering + rounding", () => {
	test("break-kind sessions are excluded", () => {
		const sessions = [
			s("2026-07-16T09:00:00Z", 1500, "break"),
			s("2026-07-16T10:00:00Z", 1500, "work"),
		];
		expect(focusStats(sessions, "today", now, UTC)).toEqual({
			count: 1,
			minutes: 25,
		});
	});

	test("minutes round the summed seconds", () => {
		const sessions = [
			s("2026-07-16T09:00:00Z", 100),
			s("2026-07-16T10:00:00Z", 50),
		];
		// 150s -> 2.5min -> rounds to 3 (Math.round)
		expect(focusStats(sessions, "today", now, UTC).minutes).toBe(3);
	});

	test("empty input yields zeros", () => {
		expect(focusStats([], "today", now, UTC)).toEqual({ count: 0, minutes: 0 });
		expect(focusStats([], "week", now, UTC)).toEqual({ count: 0, minutes: 0 });
	});
});
