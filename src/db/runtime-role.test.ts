import { describe, expect, test } from "vitest";
import { assertRuntimeRole } from "./runtime-role.ts";

const isolated: Omit<Parameters<typeof assertRuntimeRole>[0], "role"> = {
	superuser: false,
	bypassRLS: false,
	createRole: false,
	replication: false,
	privilegedRoles: [],
	ownedTables: [],
	canPruneFocusIntervals: true,
};

describe("assertRuntimeRole", () => {
	test("accepts an isolated non-owner role with cleanup access", () => {
		expect(() =>
			assertRuntimeRole({ role: "ditero_runtime", ...isolated }),
		).not.toThrow();
	});

	test.each([
		["superuser", "SUPERUSER"],
		["bypassRLS", "BYPASSRLS"],
		["createRole", "CREATEROLE"],
		["replication", "REPLICATION"],
	] as const)("names the role and forbidden %s attribute", (flag, attribute) => {
		expect(() =>
			assertRuntimeRole({ role: "unsafe", ...isolated, [flag]: true }),
		).toThrow(
			`Runtime database role unsafe has forbidden attributes: ${attribute}`,
		);
	});

	test("names the privileged membership and its attributes", () => {
		expect(() =>
			assertRuntimeRole({
				role: "unsafe",
				...isolated,
				privilegedRoles: ["provider_admin (CREATEROLE)"],
			}),
		).toThrow(
			"Runtime database role unsafe belongs to privileged roles: provider_admin (CREATEROLE)",
		);
	});

	test("names the protected table and owner", () => {
		expect(() =>
			assertRuntimeRole({
				role: "unsafe",
				...isolated,
				ownedTables: ["server_private.clock (owner migrator)"],
			}),
		).toThrow(
			"Runtime database role unsafe owns or belongs to the owner of RLS tables: server_private.clock (owner migrator)",
		);
	});

	test("provides a quoted grant for missing cleanup execution", () => {
		expect(() =>
			assertRuntimeRole({
				role: 'custom"runtime',
				...isolated,
				canPruneFocusIntervals: false,
			}),
		).toThrow(
			'GRANT EXECUTE ON FUNCTION public.prune_focus_intervals() TO "custom""runtime";',
		);
	});
});
