import { describe, expect, it } from "vitest";
import { type EscalationPolicy, nextEscalation } from "./escalation.ts";

const NOW = new Date("2026-07-15T10:00:00Z");

function policy(over: Partial<EscalationPolicy> = {}): EscalationPolicy {
	return {
		repeatEveryMin: 10,
		maxRepeats: 3,
		fallbackUserId: "u-fallback",
		urgent: false,
		...over,
	};
}

describe("nextEscalation", () => {
	it("schedules the next repeat below the cap", () => {
		expect(nextEscalation({ fireCount: 1 }, policy(), NOW)).toEqual({
			kind: "repeat",
			at: new Date("2026-07-15T10:10:00Z"),
		});
	});

	it("escalates to the fallback at the cap", () => {
		expect(nextEscalation({ fireCount: 3 }, policy(), NOW)).toEqual({
			kind: "escalate",
			userId: "u-fallback",
		});
	});

	it("terminates at the cap when no fallback is set", () => {
		expect(
			nextEscalation({ fireCount: 3 }, policy({ fallbackUserId: null }), NOW),
		).toEqual({ kind: "terminal", reason: "exhausted" });
	});

	it("terminates past the cap even with a fallback", () => {
		expect(nextEscalation({ fireCount: 4 }, policy(), NOW)).toEqual({
			kind: "terminal",
			reason: "exhausted",
		});
	});

	it("terminates immediately when repeats are disabled", () => {
		expect(
			nextEscalation({ fireCount: 1 }, policy({ repeatEveryMin: null }), NOW),
		).toEqual({ kind: "terminal", reason: "no_repeat" });
	});

	it("terminates when maxRepeats is zero", () => {
		expect(
			nextEscalation({ fireCount: 1 }, policy({ maxRepeats: 0 }), NOW),
		).toEqual({ kind: "terminal", reason: "exhausted" });
	});

	it("rejects a null maxRepeats when repeats are enabled (must be resolved upstream)", () => {
		expect(() =>
			nextEscalation({ fireCount: 1 }, policy({ maxRepeats: null }), NOW),
		).toThrow(/maxRepeats/);
	});

	it("tolerates a null maxRepeats when repeats are already disabled", () => {
		expect(
			nextEscalation(
				{ fireCount: 1 },
				policy({ repeatEveryMin: null, maxRepeats: null }),
				NOW,
			),
		).toEqual({ kind: "terminal", reason: "no_repeat" });
	});

	it("rejects a non-positive repeatEveryMin", () => {
		expect(() =>
			nextEscalation({ fireCount: 1 }, policy({ repeatEveryMin: 0 }), NOW),
		).toThrow(/repeatEveryMin/);
		expect(() =>
			nextEscalation({ fireCount: 1 }, policy({ repeatEveryMin: -5 }), NOW),
		).toThrow(/repeatEveryMin/);
	});

	it("rejects a non-integer repeatEveryMin", () => {
		expect(() =>
			nextEscalation({ fireCount: 1 }, policy({ repeatEveryMin: 1.5 }), NOW),
		).toThrow(/repeatEveryMin/);
	});

	it("rejects a negative maxRepeats", () => {
		expect(() =>
			nextEscalation({ fireCount: 1 }, policy({ maxRepeats: -1 }), NOW),
		).toThrow(/maxRepeats/);
	});

	it("rejects a negative fireCount", () => {
		expect(() => nextEscalation({ fireCount: -1 }, policy(), NOW)).toThrow(
			/fireCount/,
		);
	});

	it("terminates deterministically as fireCount advances toward and past the cap", () => {
		const p = policy({ repeatEveryMin: 10, maxRepeats: 2 });
		expect(nextEscalation({ fireCount: 1 }, p, NOW).kind).toBe("repeat");
		expect(nextEscalation({ fireCount: 2 }, p, NOW).kind).toBe("escalate");
		expect(nextEscalation({ fireCount: 3 }, p, NOW).kind).toBe("terminal");
	});
});
