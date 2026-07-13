import { describe, expect, test } from "vitest";
import { keyBetween, keysAreOrdered } from "./sort-key.ts";

describe("keyBetween", () => {
	test("first key", () => expect(keyBetween(null, null) > "").toBe(true));
	test("orders between neighbors", () => {
		const a = keyBetween(null, null);
		const b = keyBetween(a, null);
		const mid = keyBetween(a, b);
		expect(a < mid && mid < b).toBe(true);
	});
	test("jitter: two same-slot inserts differ", () => {
		const a = keyBetween(null, null);
		const b = keyBetween(a, null);
		expect(keyBetween(a, b)).not.toBe(keyBetween(a, b)); // design 2.8(a)
	});
	test("hotspot growth bounded ~1 char/insert", () => {
		let lo = keyBetween(null, null);
		const hi = keyBetween(lo, null);
		for (let i = 0; i < 50; i++) lo = keyBetween(lo, hi);
		expect(lo.length).toBeLessThan(60); // 2.8(b) accepted growth, no rebalance
	});
	test("jittered key accepted as input", () => {
		expect(() => keyBetween(keyBetween(null, null), null)).not.toThrow();
	});
	test("tight range: distinct in-bounds keys, no unjittered fallback", () => {
		const k1 = keyBetween("a1", "a1101");
		const k2 = keyBetween("a1", "a1101");
		expect(k1).not.toBe(k2);
		expect("a1" < k1 && k1 < "a1101").toBe(true);
		expect("a1" < k2 && k2 < "a1101").toBe(true);
		expect(() => keyBetween(k1, "a1101")).not.toThrow();
	});
});

describe("keysAreOrdered", () => {
	test("true for ordered list", () => {
		const a = keyBetween(null, null);
		const b = keyBetween(a, null);
		const c = keyBetween(b, null);
		expect(keysAreOrdered([a, b, c])).toBe(true);
	});
	test("false for out-of-order list", () => {
		const a = keyBetween(null, null);
		const b = keyBetween(a, null);
		expect(keysAreOrdered([b, a])).toBe(false);
	});
});
