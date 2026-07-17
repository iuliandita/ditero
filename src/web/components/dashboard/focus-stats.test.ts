import { describe, expect, test } from "vitest";
import { type FocusStatsSession, focusStats } from "./focus-stats.ts";

const now = new Date("2026-07-16T12:00:00Z");

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
	test("counts work sessions started within the UTC day", () => {
		const sessions = [
			s("2026-07-16T00:01:00Z"), // just inside
			s("2026-07-16T23:59:00Z"), // late but same day (now is noon; day-based)
			s("2026-07-15T23:59:00Z"), // previous day
		];
		expect(focusStats(sessions, "today", now)).toEqual({
			count: 2,
			minutes: 50,
		});
	});

	test("day boundary: 23:59 yesterday out, 00:01 today in", () => {
		expect(focusStats([s("2026-07-15T23:59:00Z")], "today", now).count).toBe(0);
		expect(focusStats([s("2026-07-16T00:01:00Z")], "today", now).count).toBe(1);
	});
});

describe("focusStats: week", () => {
	test("last 7 UTC days including today: edge in, day 8 out", () => {
		const sessions = [
			s("2026-07-10T00:00:00Z"), // exactly 6 days back -> included
			s("2026-07-09T23:59:00Z"), // 7 days back -> excluded
			s("2026-07-16T08:00:00Z"), // today -> included
		];
		expect(focusStats(sessions, "week", now).count).toBe(2);
	});

	test("future sessions past today are excluded", () => {
		expect(focusStats([s("2026-07-17T01:00:00Z")], "week", now).count).toBe(0);
	});
});

describe("focusStats: filtering + rounding", () => {
	test("break-kind sessions are excluded", () => {
		const sessions = [
			s("2026-07-16T09:00:00Z", 1500, "break"),
			s("2026-07-16T10:00:00Z", 1500, "work"),
		];
		expect(focusStats(sessions, "today", now)).toEqual({
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
		expect(focusStats(sessions, "today", now).minutes).toBe(3);
	});

	test("empty input yields zeros", () => {
		expect(focusStats([], "today", now)).toEqual({ count: 0, minutes: 0 });
		expect(focusStats([], "week", now)).toEqual({ count: 0, minutes: 0 });
	});
});
