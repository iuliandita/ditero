import { describe, expect, test } from "vitest";
import { assertRuntimeRole } from "./runtime-role.ts";

describe("assertRuntimeRole", () => {
	test("accepts an isolated non-owner role", () => {
		expect(() =>
			assertRuntimeRole({
				role: "ditero_runtime",
				superuser: false,
				bypassRLS: false,
				memberOfTableOwner: false,
			}),
		).not.toThrow();
	});

	test.each([
		{ superuser: true, bypassRLS: false, memberOfTableOwner: false },
		{ superuser: false, bypassRLS: true, memberOfTableOwner: false },
		{ superuser: false, bypassRLS: false, memberOfTableOwner: true },
	])("rejects a role that can bypass RLS: %o", (flags) => {
		expect(() => assertRuntimeRole({ role: "unsafe", ...flags })).toThrow(
			/runtime database role/i,
		);
	});
});
