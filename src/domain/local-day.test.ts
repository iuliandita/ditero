import { describe, expect, it } from "vitest";
import { localDay, shiftDay } from "./local-day.ts";

describe("localDay", () => {
	it("keeps an evening completion west of UTC on the local day", () => {
		// 21:00 in New York is already the next calendar day in UTC.
		const at = new Date("2026-03-10T01:00:00Z");
		expect(at.toISOString().slice(0, 10)).toBe("2026-03-10");
		expect(localDay(at, "America/New_York")).toBe("2026-03-09");
	});

	it("rolls a morning completion east of UTC onto the local day", () => {
		// 08:00 in Auckland is still the previous calendar day in UTC.
		const at = new Date("2026-03-09T19:00:00Z");
		expect(at.toISOString().slice(0, 10)).toBe("2026-03-09");
		expect(localDay(at, "Pacific/Auckland")).toBe("2026-03-10");
	});

	it("tracks the offset change across a DST transition", () => {
		// 23:30 local the night before US spring-forward (EST, UTC-5).
		expect(localDay(new Date("2026-03-08T04:30:00Z"), "America/New_York")).toBe(
			"2026-03-07",
		);
		// 23:30 local the night after US fall-back, at the other offset (EST again
		// but reached from EDT); a fixed offset would put one of these on the
		// wrong day.
		expect(localDay(new Date("2026-11-02T03:30:00Z"), "America/New_York")).toBe(
			"2026-11-01",
		);
		// 23:30 local mid-EDT (UTC-4).
		expect(localDay(new Date("2026-07-02T03:30:00Z"), "America/New_York")).toBe(
			"2026-07-01",
		);
	});

	it("agrees with UTC when the zone is UTC", () => {
		expect(localDay(new Date("2026-03-10T01:00:00Z"), "UTC")).toBe(
			"2026-03-10",
		);
	});

	it("throws rather than guessing when the zone is missing", () => {
		expect(() => localDay(new Date(), "")).toThrow(/timezone/);
	});
});

describe("shiftDay", () => {
	it("moves by calendar days in both directions", () => {
		expect(shiftDay("2026-07-16", 1)).toBe("2026-07-17");
		expect(shiftDay("2026-07-16", -6)).toBe("2026-07-10");
		expect(shiftDay("2026-07-16", 0)).toBe("2026-07-16");
	});

	it("rolls over month and year boundaries", () => {
		expect(shiftDay("2026-07-31", 1)).toBe("2026-08-01");
		expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29"); // leap year
	});

	// The reason this is key arithmetic and not `ms + 86_400_000`: a DST day is
	// 23 or 25 hours, so adding a fixed day to an instant inside such a day lands
	// on the wrong local date. Day keys have no offset to get wrong.
	it("crosses a DST transition without skipping or repeating a day", () => {
		// US spring-forward 2026-03-08 (23h day).
		expect(shiftDay("2026-03-07", 1)).toBe("2026-03-08");
		expect(shiftDay("2026-03-08", 1)).toBe("2026-03-09");
		// US fall-back 2026-11-01 (25h day).
		expect(shiftDay("2026-10-31", 2)).toBe("2026-11-02");
	});

	it("spans a whole DST-containing week as exactly 7 days", () => {
		expect(shiftDay("2026-11-03", -6)).toBe("2026-10-28");
	});

	it("rejects a malformed key rather than producing NaN", () => {
		expect(() => shiftDay("2026-7-4", 1)).toThrow(/invalid day key/);
		expect(() => shiftDay("not a date", 1)).toThrow(/invalid day key/);
	});
});
