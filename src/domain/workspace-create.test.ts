import { describe, expect, test } from "vitest";
import {
	workspaceCreateSchema,
	workspaceNameSchema,
} from "./workspace-create.ts";

const input = {
	id: "12345678-1234-4234-8234-123456789012",
	membershipId: "22345678-1234-4234-8234-123456789012",
	name: " Group ",
};

describe("workspace creation input", () => {
	test("canonicalizes surrounding spaces and preserves multilingual names", () => {
		expect(workspaceCreateSchema.parse(input).name).toBe("Group");
		expect(workspaceNameSchema.parse("  نادي 家族 👨‍👩‍👧  ")).toBe(
			"نادي 家族 👨‍👩‍👧",
		);
	});
	test.each([
		"",
		"  ",
		"x".repeat(101),
		"😀".repeat(51),
		"\nGroup",
		"Group\u0000",
		"Group\u0085",
		"\ud800",
		"\udc00",
		"x\ud800y",
	])("refuses unsafe or unbounded name %j", (name) => {
		expect(workspaceNameSchema.safeParse(name).success).toBe(false);
	});
	test("bounds UTF16 units without splitting valid pairs", () => {
		expect(workspaceNameSchema.parse("😀".repeat(50)).length).toBe(100);
	});
	test.each(["id", "membershipId"])("requires UUID %s", (key) => {
		expect(
			workspaceCreateSchema.safeParse({ ...input, [key]: "foreign" }).success,
		).toBe(false);
	});
	test.each([
		"ownerId",
		"kind",
		"role",
		"userId",
		"rotationRequired",
	])("refuses caller-controlled %s", (key) => {
		expect(
			workspaceCreateSchema.safeParse({ ...input, [key]: "owner" }).success,
		).toBe(false);
	});
});
