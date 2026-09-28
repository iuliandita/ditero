import { describe, expect, test } from "vitest";
import {
	EMPTY_SNACKBAR,
	pauseCountdown,
	resumeCountdown,
	snackbarReducer,
	startCountdown,
} from "./snackbar-state.ts";

describe("snackbarReducer", () => {
	test("show assigns increasing ids", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, { type: "show", message: "a" });
		const s2 = snackbarReducer(s1, { type: "show", message: "b" });
		expect(s1.snack?.id).toBe(1);
		expect(s2.snack?.id).toBe(2);
	});

	test("the newest snack replaces the current one", () => {
		const run = () => {};
		const s1 = snackbarReducer(EMPTY_SNACKBAR, {
			type: "show",
			message: "a",
			action: { label: "Undo", run },
		});
		const s2 = snackbarReducer(s1, { type: "show", message: "b" });
		expect(s2.snack?.message).toBe("b");
		expect(s2.snack?.action).toBeUndefined();
	});

	test("dismissing the current id clears it", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, { type: "show", message: "a" });
		const id = s1.snack?.id ?? 0;
		expect(snackbarReducer(s1, { type: "dismiss", id }).snack).toBeNull();
	});

	test("a stale dismiss for a replaced snack leaves the successor alone", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, { type: "show", message: "a" });
		const staleId = s1.snack?.id ?? 0;
		const s2 = snackbarReducer(s1, { type: "show", message: "b" });
		const s3 = snackbarReducer(s2, { type: "dismiss", id: staleId });
		expect(s3).toBe(s2);
		expect(s3.snack?.message).toBe("b");
	});
});

describe("snackbarReducer: dismissKey", () => {
	test("retracts the current snack about that key", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, {
			type: "show",
			message: "a",
			key: "task-1",
		});
		expect(
			snackbarReducer(s1, { type: "dismissKey", key: "task-1" }).snack,
		).toBeNull();
	});

	test("leaves a snack about something else alone", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, {
			type: "show",
			message: "a",
			key: "task-2",
		});
		expect(snackbarReducer(s1, { type: "dismissKey", key: "task-1" })).toBe(s1);
	});

	test("a keyless snack is never retracted by key", () => {
		const s1 = snackbarReducer(EMPTY_SNACKBAR, { type: "show", message: "a" });
		expect(snackbarReducer(s1, { type: "dismissKey", key: "" })).toBe(s1);
	});
});

describe("countdown", () => {
	test("a countdown started paused keeps its full time until resumed", () => {
		const c = startCountdown(5000, 1000, true);
		expect(c).toEqual({ remaining: 5000, startedAt: null });
		expect(pauseCountdown(c, 9000).remaining).toBe(5000);
		expect(resumeCountdown(c, 9000)).toEqual({
			remaining: 5000,
			startedAt: 9000,
		});
	});

	test("pause keeps the unspent time and resume restarts from it", () => {
		const c0 = startCountdown(5000, 1000);
		const paused = pauseCountdown(c0, 3000);
		expect(paused).toEqual({ remaining: 3000, startedAt: null });
		// Time spent paused is not charged.
		expect(pauseCountdown(paused, 9000)).toBe(paused);
		const resumed = resumeCountdown(paused, 9000);
		expect(resumed).toEqual({ remaining: 3000, startedAt: 9000 });
		expect(pauseCountdown(resumed, 10000).remaining).toBe(2000);
	});

	test("remaining never goes negative", () => {
		expect(pauseCountdown(startCountdown(100, 0), 500).remaining).toBe(0);
	});

	test("resume on a running countdown is a no-op", () => {
		const c = startCountdown(100, 0);
		expect(resumeCountdown(c, 50)).toBe(c);
	});
});
