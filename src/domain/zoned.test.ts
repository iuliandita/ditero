import { describe, expect, it } from "vitest";
import { instantToWallClock, offsetMsAt, wallClockToInstant } from "./zoned.ts";

const BUCHAREST = "Europe/Bucharest";

describe("offsetMsAt", () => {
	it("returns the standard-time offset in winter", () => {
		expect(offsetMsAt(new Date("2026-01-15T00:00:00Z"), BUCHAREST)).toBe(
			2 * 3_600_000,
		);
	});

	it("returns the daylight offset in summer", () => {
		expect(offsetMsAt(new Date("2026-07-15T00:00:00Z"), BUCHAREST)).toBe(
			3 * 3_600_000,
		);
	});

	it("handles UTC", () => {
		expect(offsetMsAt(new Date("2026-07-15T00:00:00Z"), "UTC")).toBe(0);
	});
});

describe("wallClockToInstant", () => {
	it("resolves an ordinary wall-clock time", () => {
		const at = wallClockToInstant("2026-07-15", "08:00", BUCHAREST);
		expect(at.toISOString()).toBe("2026-07-15T05:00:00.000Z");
	});

	it("resolves across the winter offset", () => {
		const at = wallClockToInstant("2026-01-15", "08:00", BUCHAREST);
		expect(at.toISOString()).toBe("2026-01-15T06:00:00.000Z");
	});

	// 2026-03-29: Bucharest jumps 03:00 -> 04:00. 03:30 does not exist.
	it("fires a nonexistent spring-forward time at the end of the gap", () => {
		const at = wallClockToInstant("2026-03-29", "03:30", BUCHAREST);
		expect(at.toISOString()).toBe("2026-03-29T01:00:00.000Z");
	});

	// 2026-10-25: Bucharest repeats 03:00 -> 04:00 becomes 03:00 again. 03:30 occurs twice.
	it("fires an ambiguous fall-back time at its first occurrence", () => {
		const at = wallClockToInstant("2026-10-25", "03:30", BUCHAREST);
		expect(at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
	});

	it("keeps a fixed wall-clock across a DST boundary", () => {
		const before = wallClockToInstant("2026-03-28", "08:00", BUCHAREST);
		const after = wallClockToInstant("2026-03-30", "08:00", BUCHAREST);
		expect(before.toISOString()).toBe("2026-03-28T06:00:00.000Z");
		expect(after.toISOString()).toBe("2026-03-30T05:00:00.000Z");
	});

	// Southern hemisphere: Sydney falls back (DST -> standard) in April.
	// 2026-04-05 02:30 local occurs twice: first under +11 (daylight), then +10.
	it("fires an ambiguous fall-back time at its first occurrence (reversed hemisphere)", () => {
		const at = wallClockToInstant("2026-04-05", "02:30", "Australia/Sydney");
		expect(at.toISOString()).toBe("2026-04-04T15:30:00.000Z");
	});

	// Southern hemisphere: Sydney springs forward (standard -> DST) in October.
	// 2026-10-04 jumps 02:00 -> 03:00 local; 02:30 does not exist.
	it("fires a nonexistent spring-forward time at the end of the gap (reversed hemisphere)", () => {
		const at = wallClockToInstant("2026-10-04", "02:30", "Australia/Sydney");
		expect(at.toISOString()).toBe("2026-10-03T16:00:00.000Z");
	});

	it("resolves an ordinary time in a sub-hour offset zone", () => {
		const at = wallClockToInstant("2026-06-01", "10:00", "Asia/Kathmandu");
		expect(at.toISOString()).toBe("2026-06-01T04:15:00.000Z");
	});

	it("throws on an out-of-range time", () => {
		expect(() => wallClockToInstant("2026-01-01", "25:00", "UTC")).toThrow();
	});

	it("throws on an invalid calendar date", () => {
		expect(() => wallClockToInstant("2026-02-30", "08:00", "UTC")).toThrow();
	});
});

describe("instantToWallClock", () => {
	it("round-trips an ordinary time", () => {
		const at = new Date("2026-07-15T05:00:00Z");
		expect(instantToWallClock(at, BUCHAREST)).toEqual({
			date: "2026-07-15",
			time: "08:00",
		});
	});
});
