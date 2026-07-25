import { describe, expect, it } from "vitest";
import { habitDay } from "./habit-day.ts";

describe("habitDay", () => {
	it("keeps an evening completion west of UTC on the local day", () => {
		// 21:00 in New York is already the next calendar day in UTC.
		const at = new Date("2026-03-10T01:00:00Z");
		expect(at.toISOString().slice(0, 10)).toBe("2026-03-10");
		expect(habitDay(at, "America/New_York")).toBe("2026-03-09");
	});

	it("rolls a morning completion east of UTC onto the local day", () => {
		// 08:00 in Auckland is still the previous calendar day in UTC.
		const at = new Date("2026-03-09T19:00:00Z");
		expect(at.toISOString().slice(0, 10)).toBe("2026-03-09");
		expect(habitDay(at, "Pacific/Auckland")).toBe("2026-03-10");
	});

	it("tracks the offset change across a DST transition", () => {
		// 23:30 local the night before US spring-forward (EST, UTC-5).
		expect(habitDay(new Date("2026-03-08T04:30:00Z"), "America/New_York")).toBe(
			"2026-03-07",
		);
		// 23:30 local the night after US fall-back, at the other offset (EST again
		// but reached from EDT); a fixed offset would put one of these on the
		// wrong day.
		expect(habitDay(new Date("2026-11-02T03:30:00Z"), "America/New_York")).toBe(
			"2026-11-01",
		);
		// 23:30 local mid-EDT (UTC-4).
		expect(habitDay(new Date("2026-07-02T03:30:00Z"), "America/New_York")).toBe(
			"2026-07-01",
		);
	});

	it("agrees with UTC when the zone is UTC", () => {
		expect(habitDay(new Date("2026-03-10T01:00:00Z"), "UTC")).toBe(
			"2026-03-10",
		);
	});

	it("throws rather than guessing when the zone is missing", () => {
		expect(() => habitDay(new Date(), "")).toThrow(/timezone/);
	});
});
