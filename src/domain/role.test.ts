import { describe, expect, test } from "vitest";
import { ADMIN_ROLES, ROLES, WRITE_ROLES } from "./role.ts";

describe("role sets", () => {
	test("ROLES lists every role exactly once", () => {
		expect(ROLES).toEqual(["owner", "admin", "member", "viewer"]);
		expect(new Set(ROLES).size).toBe(ROLES.length);
	});

	test("write roles are everyone but viewer", () => {
		expect([...WRITE_ROLES].sort()).toEqual(["admin", "member", "owner"]);
		expect(WRITE_ROLES.has("viewer")).toBe(false);
	});

	test("admin roles are owner and admin only", () => {
		expect([...ADMIN_ROLES].sort()).toEqual(["admin", "owner"]);
		expect(ADMIN_ROLES.has("member")).toBe(false);
	});

	test("every admin role is also a write role", () => {
		for (const role of ADMIN_ROLES) expect(WRITE_ROLES.has(role)).toBe(true);
	});
});
