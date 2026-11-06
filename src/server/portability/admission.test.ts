import { expect, test } from "vitest";
import { takePlanCreationToken } from "./admission.ts";

test("rate limits repeat plans per account, refills and retains other accounts' budgets", () => {
	const admission = new Set<string>();
	for (let index = 0; index < 4; index++)
		expect(takePlanCreationToken(admission, "first", 0)).toBe(true);
	expect(takePlanCreationToken(admission, "first", 14_999)).toBe(false);
	expect(takePlanCreationToken(admission, "second", 14_999)).toBe(true);
	expect(takePlanCreationToken(admission, "first", 15_000)).toBe(true);
	expect(takePlanCreationToken(admission, "first", 15_000)).toBe(false);
	expect(takePlanCreationToken(admission, "first", 75_000)).toBe(true);
});
