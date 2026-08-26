import { describe, expect, test } from "vitest";
import { ROLES } from "../../domain/role.ts";
import {
	canCreateFolder,
	canCreateList,
	shareableWorkspaces,
} from "./create-gates.ts";

describe("create gates", () => {
	test("only write roles may create a folder", () => {
		expect(ROLES.filter((r) => canCreateFolder(r))).toEqual([
			"owner",
			"admin",
			"member",
		]);
		expect(canCreateFolder("viewer")).toBe(false);
		expect(canCreateFolder(null)).toBe(false);
	});

	test("only write roles may create a list", () => {
		expect(ROLES.filter((r) => canCreateList(r))).toEqual([
			"owner",
			"admin",
			"member",
		]);
		expect(canCreateList("viewer")).toBe(false);
		expect(canCreateList(null)).toBe(false);
	});

	test("a viewer's workspace is not offered as a share target", () => {
		const ws = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const roles = new Map([
			["a", "owner" as const],
			["b", "viewer" as const],
		]);
		// "c" has no membership row at all.
		expect(shareableWorkspaces(ws, roles)).toEqual([{ id: "a" }]);
	});
});
