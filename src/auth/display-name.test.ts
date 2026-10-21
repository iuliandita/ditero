import { describe, expect, test } from "vitest";
import { normalizeDisplayName, signupDisplayName } from "./display-name.ts";

describe("display names", () => {
	test("trims names and defaults blank signup names to the email local part", () => {
		expect(normalizeDisplayName("  Maya Chen  ")).toBe("Maya Chen");
		expect(signupDisplayName("  ", "maya.chen83@example.test")).toBe(
			"maya.chen83",
		);
		expect(normalizeDisplayName("مريم")).toBe("مريم");
		expect(normalizeDisplayName("a".repeat(80))).toHaveLength(80);
	});

	test.each([
		"",
		"  ",
		"a".repeat(81),
		"Maya\n",
		"Ma\u0000ya",
		"Ma\u202eya",
	])("rejects invalid names: %j", (name) => {
		expect(() => normalizeDisplayName(name)).toThrow("INVALID_DISPLAY_NAME");
	});
});
