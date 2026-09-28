import { expect, test } from "vitest";
import { isValidQuantity, isValidUnit } from "./quantity.ts";

test("quantity accepts positive numbers with either decimal separator", () => {
	for (const q of ["2", "12", "0.5", "1,5", "1.25", "999999", ""])
		expect(isValidQuantity(q), q).toBe(true);
});

test("quantity rejects zero, negatives, words, and overlong input", () => {
	for (const q of [
		"0",
		"0,0",
		"-1",
		"abc",
		"1,5,5",
		"1.2345",
		"1e3",
		" 2",
		"NaN",
		"Infinity",
		"1234567",
		".5",
	])
		expect(isValidQuantity(q), q).toBe(false);
});

test("unit must be trimmed and short", () => {
	expect(isValidUnit("")).toBe(true);
	expect(isValidUnit("kg")).toBe(true);
	expect(isValidUnit("x".repeat(16))).toBe(true);
	expect(isValidUnit("x".repeat(17))).toBe(false);
	expect(isValidUnit(" kg")).toBe(false);
	expect(isValidUnit("kg ")).toBe(false);
});
