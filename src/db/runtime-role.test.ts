import { describe, expect, test } from "vitest";
import { assertRuntimeRole } from "./runtime-role.ts";

const isolated = {
	superuser: false,
	bypassRLS: false,
	createRole: false,
	replication: false,
	memberOfPrivilegedRole: false,
	memberOfTableOwner: false,
};

describe("assertRuntimeRole", () => {
	test("accepts an isolated non-owner role", () => {
		expect(() =>
			assertRuntimeRole({
				role: "ditero_runtime",
				...isolated,
			}),
		).not.toThrow();
	});

	test.each([
		"superuser",
		"bypassRLS",
		"createRole",
		"replication",
		"memberOfPrivilegedRole",
		"memberOfTableOwner",
	] as const)("rejects %s", (flag) => {
		expect(() =>
			assertRuntimeRole({ role: "unsafe", ...isolated, [flag]: true }),
		).toThrow(/runtime database role/i);
	});
});
