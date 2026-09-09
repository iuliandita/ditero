import { describe, expect, it } from "vitest";
import {
	AUTO_LOCK_CHOICES,
	autoLockMaxAgeMs,
	DEFAULT_AUTO_LOCK_MINUTES,
	isAutoLockMinutes,
} from "./auto-lock.ts";

describe("autoLockMaxAgeMs", () => {
	it("maps every offered choice to a usable max age", () => {
		for (const minutes of AUTO_LOCK_CHOICES) {
			const ms = autoLockMaxAgeMs(minutes);
			// Every choice must leave the keyring readable for a non-zero span.
			// The bug this guards is `0` meaning "never" arithmetically becoming
			// a 0 ms age, which expires the key on the tick it was unlocked.
			expect(ms, `${minutes} minutes`).toBeGreaterThan(0);
		}
	});

	it("treats 0 as never, not as instantly expired", () => {
		expect(autoLockMaxAgeMs(0)).toBe(Number.POSITIVE_INFINITY);
	});

	it("falls back to the default for anything unrecognised", () => {
		const fallback = autoLockMaxAgeMs(DEFAULT_AUTO_LOCK_MINUTES);
		for (const bad of [null, undefined, -1, 7, 1.5, "15", Number.NaN, {}]) {
			expect(autoLockMaxAgeMs(bad as number), JSON.stringify(bad)).toBe(
				fallback,
			);
		}
	});

	it("does not default to never", () => {
		// The unset default must be a real timeout: a key left unlocked forever
		// on a shared browser is the case the max age exists for.
		expect(autoLockMaxAgeMs(null)).toBeLessThan(Number.POSITIVE_INFINITY);
	});

	it("converts minutes to milliseconds", () => {
		expect(autoLockMaxAgeMs(15)).toBe(900_000);
		expect(autoLockMaxAgeMs(60)).toBe(3_600_000);
		expect(autoLockMaxAgeMs(480)).toBe(28_800_000);
	});
});

describe("isAutoLockMinutes", () => {
	it("accepts exactly the offered choices", () => {
		for (const minutes of AUTO_LOCK_CHOICES) {
			expect(isAutoLockMinutes(minutes), `${minutes}`).toBe(true);
		}
		for (const bad of [1, 30, 1440, -15, "15", null]) {
			expect(isAutoLockMinutes(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});
