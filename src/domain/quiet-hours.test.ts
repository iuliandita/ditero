import { describe, expect, it } from "vitest";
import { quietHoursDecision } from "./quiet-hours.ts";

const TZ = "Europe/Bucharest";
const NIGHT = { start: "22:00", end: "07:00" };
const DAY = { start: "13:00", end: "14:00" };

describe("quietHoursDecision", () => {
	it("fires when no quiet hours are configured", () => {
		const at = new Date("2026-07-15T00:00:00Z");
		expect(quietHoursDecision(null, TZ, at, false)).toEqual({ kind: "fire" });
	});

	it("fires outside quiet hours", () => {
		// 12:00 local
		const at = new Date("2026-07-15T09:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, false)).toEqual({ kind: "fire" });
	});

	it("defers to the window end inside an overnight window", () => {
		// 23:00 local on the 15th
		const at = new Date("2026-07-15T20:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, false)).toEqual({
			kind: "defer",
			until: new Date("2026-07-16T04:00:00Z"), // 07:00 local on the 16th
		});
	});

	it("defers to the same morning when already past midnight", () => {
		// 03:00 local on the 16th
		const at = new Date("2026-07-16T00:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, false)).toEqual({
			kind: "defer",
			until: new Date("2026-07-16T04:00:00Z"),
		});
	});

	it("defers inside a same-day window", () => {
		// 13:30 local
		const at = new Date("2026-07-15T10:30:00Z");
		expect(quietHoursDecision(DAY, TZ, at, false)).toEqual({
			kind: "defer",
			until: new Date("2026-07-15T11:00:00Z"), // 14:00 local
		});
	});

	it("fires regardless when the reminder is urgent", () => {
		const at = new Date("2026-07-15T20:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, true)).toEqual({ kind: "fire" });
	});

	it("fires exactly at the window end", () => {
		// 07:00 local
		const at = new Date("2026-07-15T04:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, false)).toEqual({ kind: "fire" });
	});

	it("defers exactly at the window start", () => {
		// 22:00 local
		const at = new Date("2026-07-15T19:00:00Z");
		expect(quietHoursDecision(NIGHT, TZ, at, false).kind).toBe("defer");
	});

	it("fires always when start equals end (empty window, not all-day)", () => {
		const same = { start: "09:00", end: "09:00" };
		const at = new Date("2026-07-15T09:00:00Z");
		expect(quietHoursDecision(same, TZ, at, false)).toEqual({ kind: "fire" });
	});

	it("throws on a malformed start time", () => {
		const at = new Date("2026-07-15T09:00:00Z");
		expect(() =>
			quietHoursDecision({ start: "25:00", end: "07:00" }, TZ, at, false),
		).toThrow();
	});

	it("throws on a non-numeric time string", () => {
		const at = new Date("2026-07-15T09:00:00Z");
		expect(() =>
			quietHoursDecision({ start: "abc", end: "07:00" }, TZ, at, false),
		).toThrow();
	});

	it("the deferred instant is always strictly after at, across a DST spring-forward gap", () => {
		// Europe/Bucharest springs forward on 2026-03-29 at 03:00 -> 04:00 local.
		// A window ending inside the gap (03:30) must still resolve to a real,
		// later instant, not fire immediately or fall before `at`.
		const window = { start: "22:00", end: "03:30" };
		const at = new Date("2026-03-28T21:00:00Z"); // 23:00 local on the 28th
		const decision = quietHoursDecision(window, TZ, at, false);
		expect(decision.kind).toBe("defer");
		if (decision.kind === "defer") {
			expect(decision.until.getTime()).toBeGreaterThan(at.getTime());
		}
	});
});
