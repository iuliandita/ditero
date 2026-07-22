import { describe, expect, it } from "vitest";
import { classifyRetry, MAX_ATTEMPTS } from "./notification-retry.ts";

describe("classifyRetry", () => {
	it("treats a 2xx as done", () => {
		expect(classifyRetry({ ok: true, status: 200 }, 1, 0)).toEqual({
			kind: "done",
			retryClass: "ok",
		});
	});

	it("retries a 5xx with exponential backoff", () => {
		const first = classifyRetry({ ok: false, status: 503, error: "x" }, 1, 0);
		const second = classifyRetry({ ok: false, status: 503, error: "x" }, 2, 0);
		expect(first).toEqual({
			kind: "retry",
			delayMs: 1_000,
			retryClass: "server",
		});
		expect(second).toEqual({
			kind: "retry",
			delayMs: 2_000,
			retryClass: "server",
		});
	});

	it("honors Retry-After on a 429", () => {
		expect(
			classifyRetry(
				{ ok: false, status: 429, retryAfterSec: 30, error: "slow down" },
				1,
				0,
			),
		).toEqual({ kind: "retry", delayMs: 30_000, retryClass: "throttled" });
	});

	it("falls back to backoff on a 429 without Retry-After", () => {
		expect(
			classifyRetry({ ok: false, status: 429, error: "slow down" }, 1, 0),
		).toEqual({ kind: "retry", delayMs: 1_000, retryClass: "throttled" });
	});

	it("stops permanently on a 4xx that is not 429", () => {
		expect(
			classifyRetry({ ok: false, status: 401, error: "bad token" }, 1, 0),
		).toEqual({ kind: "permanent", retryClass: "client" });
	});

	it("retries a transport error", () => {
		expect(classifyRetry({ ok: false, error: "ECONNRESET" }, 1, 0)).toEqual({
			kind: "retry",
			delayMs: 1_000,
			retryClass: "transport",
		});
	});

	it("gives up after the attempt cap", () => {
		expect(
			classifyRetry({ ok: false, status: 503, error: "x" }, MAX_ATTEMPTS, 0),
		).toEqual({ kind: "permanent", retryClass: "exhausted" });
	});

	it("adds jitter within the bound", () => {
		const decision = classifyRetry(
			{ ok: false, status: 503, error: "x" },
			1,
			1,
		);
		expect(decision.kind).toBe("retry");
		if (decision.kind !== "retry") return;
		expect(decision.delayMs).toBeGreaterThanOrEqual(1_000);
		expect(decision.delayMs).toBeLessThanOrEqual(1_250);
	});

	// The plan's reference value (300_000 at attempt 6) was unreachable under
	// a clean doubling ladder (1_000, 2_000, ... only reaches 32_000 by
	// attempt 6). Fixed to the value the pinned-doubling formula actually
	// produces at attempt 6, well short of the cap.
	it("keeps doubling at attempt 6, short of the cap", () => {
		const decision = classifyRetry(
			{ ok: false, status: 503, error: "x" },
			6,
			0,
		);
		expect(decision).toEqual({
			kind: "retry",
			delayMs: 32_000,
			retryClass: "server",
		});
	});

	// raw = 1000 * 2^(10-1) = 512_000ms, the first attempt whose uncapped
	// value exceeds MAX_DELAY_MS (300_000ms), so attempt 10 is where the
	// ladder first flattens into the steady poll tail.
	it("reaches the cap at attempt 10", () => {
		expect(
			classifyRetry({ ok: false, status: 503, error: "x" }, 10, 0),
		).toEqual({ kind: "retry", delayMs: 300_000, retryClass: "server" });
	});

	// Pins the property that actually matters for delivery: the total time
	// budget across every retryable attempt (1..MAX_ATTEMPTS-1), not just
	// individual delays. Attempts 1-9 double from 1s to 256s (511s total);
	// attempts 10-14 hold flat at the 300s cap (1500s total) -- 2011s
	// (~33.5 min) overall, comfortably inside the 30-60 minute target. A
	// suite that only checks per-attempt delays can't catch a ladder whose
	// total span is far too short or too long; this is exactly the defect
	// that let MAX_ATTEMPTS=8 (a ~127s total budget) through unnoticed.
	it("keeps the cumulative retry span inside the 30-60 minute budget", () => {
		let totalMs = 0;
		for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
			const decision = classifyRetry(
				{ ok: false, status: 503, error: "x" },
				attempt,
				0,
			);
			expect(decision.kind).toBe("retry");
			if (decision.kind !== "retry") continue;
			totalMs += decision.delayMs;
		}
		expect(totalMs).toBe(2_011_000);
		expect(totalMs).toBeGreaterThanOrEqual(30 * 60 * 1_000);
		expect(totalMs).toBeLessThanOrEqual(60 * 60 * 1_000);
	});

	it("clamps an unbounded Retry-After to the cap", () => {
		expect(
			classifyRetry(
				{ ok: false, status: 429, retryAfterSec: 999_999_999, error: "x" },
				1,
				0,
			),
		).toEqual({ kind: "retry", delayMs: 300_000, retryClass: "throttled" });
	});

	it("falls back to backoff on a negative Retry-After", () => {
		expect(
			classifyRetry(
				{ ok: false, status: 429, retryAfterSec: -5, error: "x" },
				1,
				0,
			),
		).toEqual({ kind: "retry", delayMs: 1_000, retryClass: "throttled" });
	});

	it("falls back to backoff on a NaN Retry-After", () => {
		expect(
			classifyRetry(
				{ ok: false, status: 429, retryAfterSec: Number.NaN, error: "x" },
				1,
				0,
			),
		).toEqual({ kind: "retry", delayMs: 1_000, retryClass: "throttled" });
	});

	it("throws on a non-integer attempt", () => {
		expect(() =>
			classifyRetry({ ok: false, status: 503, error: "x" }, 1.5, 0),
		).toThrow(/attempt/);
	});

	it("throws on a zero or negative attempt", () => {
		expect(() =>
			classifyRetry({ ok: false, status: 503, error: "x" }, 0, 0),
		).toThrow(/attempt/);
	});

	it("throws on jitter outside [0, 1]", () => {
		expect(() =>
			classifyRetry({ ok: false, status: 503, error: "x" }, 1, 1.5),
		).toThrow(/jitter/);
		expect(() =>
			classifyRetry({ ok: false, status: 503, error: "x" }, 1, -0.1),
		).toThrow(/jitter/);
	});

	it("retries a 3xx or other unmodelled status as unexpected, not permanent", () => {
		expect(
			classifyRetry({ ok: false, status: 302, error: "redirected" }, 1, 0),
		).toEqual({
			kind: "retry",
			delayMs: 1_000,
			retryClass: "unexpected-status",
		});
		expect(
			classifyRetry({ ok: false, status: 0, error: "network" }, 1, 0),
		).toEqual({
			kind: "retry",
			delayMs: 1_000,
			retryClass: "unexpected-status",
		});
	});

	it("treats a safeFetch policy rejection as permanent", () => {
		expect(
			classifyRetry(
				{ ok: false, policyRejected: true, error: "blocked address" },
				1,
				0,
			),
		).toEqual({ kind: "permanent", retryClass: "policy" });
	});
});
