import { describe, expect, test } from "vitest";
import {
	DEFAULT_LABEL_COLOR,
	LABEL_COLORS,
	labelColorClass,
	labelColorName,
} from "./label-color.ts";

// Expected values are catalog literals, not `m.*()`: routing both sides through
// the same message passes even against an emptied entry.

describe("label colours", () => {
	// The vocabulary and its two maps live in one file so they cannot drift. An
	// offered colour with no swatch would render as gray while claiming to be
	// something else; one with no name would announce its raw id.
	test("every offered colour has a distinct swatch and a name", () => {
		const swatches = LABEL_COLORS.map(labelColorClass);
		expect(new Set(swatches).size).toBe(LABEL_COLORS.length);
		const unnamed = LABEL_COLORS.filter((c) => labelColorName(c) === c);
		expect(unnamed).toEqual([]);
	});

	test("the schema default is part of the vocabulary", () => {
		expect(LABEL_COLORS).toContain(DEFAULT_LABEL_COLOR);
		expect(DEFAULT_LABEL_COLOR).toBe("gray");
	});

	test("resolves in the caller's locale", () => {
		expect(labelColorName("purple")).toBe("Purple");
	});

	// The colour arrives from a stored label row, so an unknown or inherited key
	// must not resolve through the prototype chain.
	test("an unknown, null or inherited key falls back safely", () => {
		expect(labelColorClass(null)).toBe(labelColorClass("gray"));
		expect(labelColorName(null)).toBe(labelColorName("gray"));
		expect(labelColorClass("chartreuse")).toBe(labelColorClass("gray"));
		expect(labelColorClass("constructor")).toBe(labelColorClass("gray"));
		expect(labelColorClass("toString")).toBe(labelColorClass("gray"));
		expect(labelColorName("constructor")).toBe("constructor");
		expect(labelColorName("toString")).toBe("toString");
	});
});
