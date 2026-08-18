import { describe, expect, test } from "vitest";
import { MutatorError, mutatorErrorCode } from "./mutator-error.ts";

describe("mutator error codes", () => {
	test("the human reason survives so server logs and message regexes still read", () => {
		const e = new MutatorError("denied", "access denied: need member+");
		expect(e.message).toMatch(/access denied/);
		expect(mutatorErrorCode(e)).toBe("denied");
	});

	test("classifies a rejection that crossed the wire as a bare string", () => {
		expect(
			mutatorErrorCode("label name already exists [code:label_name_taken]"),
		).toBe("label_name_taken");
		expect(
			mutatorErrorCode(
				new Error("label name already exists [code:label_name_taken]"),
			),
		).toBe("label_name_taken");
	});

	test("an unknown or absent code is not classified", () => {
		expect(mutatorErrorCode(new Error("task not found"))).toBeNull();
		expect(
			mutatorErrorCode(new Error("boom [code:not_a_real_code]")),
		).toBeNull();
		expect(mutatorErrorCode(undefined)).toBeNull();
	});
});
