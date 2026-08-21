import { describe, expect, test } from "vitest";
import { e2eEnabled } from "./e2e.ts";

describe("e2eEnabled", () => {
	test("defaults to off", () => {
		expect(e2eEnabled({})).toBe(false);
		expect(e2eEnabled({ DITERO_E2E_ENABLED: "" })).toBe(false);
	});

	test("reads an explicit setting in both directions", () => {
		expect(e2eEnabled({ DITERO_E2E_ENABLED: "true" })).toBe(true);
		expect(e2eEnabled({ DITERO_E2E_ENABLED: "false" })).toBe(false);
	});

	// booleanFlag is strict by design: a near-miss spelling must fail loudly
	// rather than silently leaving the subsystem off while the operator reads
	// their own config as having enabled it.
	test("refuses a value that only looks boolean", () => {
		for (const raw of ["1", "yes", "TRUE", "on"]) {
			expect(() => e2eEnabled({ DITERO_E2E_ENABLED: raw })).toThrow(
				/expected "true" or "false"/,
			);
		}
	});
});
