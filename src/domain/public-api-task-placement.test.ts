import { describe, expect, test } from "vitest";
import {
	canonicalApiTaskPlacement,
	parseApiTaskPlacement,
} from "./public-api-task-placement.ts";

const input = {
	workspaceId: "workspace",
	listId: "list",
	expectedState: "a".repeat(64),
	targetListId: "list",
	expectedTargetState: "b".repeat(64),
	sortKey: "a1",
	cascadeChildren: false,
	expectedChildrenState: null,
};
test("ordering preserves exact scope and key in a versioned canonical operation", () => {
	expect(canonicalApiTaskPlacement("task", input)).toBe(
		JSON.stringify({ operation: "task.place.v1", taskId: "task", ...input }),
	);
	expect(parseApiTaskPlacement({ ...input, sortKey: "a1V" }).sortKey).toBe(
		"a1V",
	);
});
test("relocation requires explicit complete children acknowledgment even when empty", () => {
	const moved = {
		...input,
		targetListId: "target",
		cascadeChildren: true,
		expectedChildrenState: { version: 1, count: 0, token: "c".repeat(64) },
	};
	expect(parseApiTaskPlacement(moved).expectedChildrenState?.count).toBe(0);
	for (const override of [
		{ cascadeChildren: false },
		{ expectedChildrenState: null },
	])
		expect(() => parseApiTaskPlacement({ ...moved, ...override })).toThrow();
	expect(() =>
		parseApiTaskPlacement({
			...input,
			cascadeChildren: true,
			expectedChildrenState: moved.expectedChildrenState,
		}),
	).toThrow();
});
test.each([
	"a",
	"a10",
	"a1!",
	"a1 ",
	"a1\n",
	"a1é",
	`a${"V".repeat(256)}`,
	"A0",
])("invalid opaque ordering key %j is refused without repair", (sortKey) =>
	expect(() => parseApiTaskPlacement({ ...input, sortKey })).toThrow());
describe("untrusted input descriptors", () => {
	test("rejects unknown fields and explicit undefined", () => {
		expect(() =>
			parseApiTaskPlacement({ ...input, parentId: "parent" }),
		).toThrow();
		expect(() =>
			parseApiTaskPlacement({ ...input, sortKey: undefined }),
		).toThrow();
	});
	test("does not evaluate hostile getters", () => {
		let invoked = false;
		const hostile = { ...input };
		Object.defineProperty(hostile, "sortKey", {
			enumerable: true,
			get() {
				invoked = true;
				throw new Error("getter");
			},
		});
		expect(() => parseApiTaskPlacement(hostile)).toThrow();
		expect(invoked).toBe(false);
	});
	test("rejects symbols, inherited fields and nested child accessors", () => {
		expect(() =>
			parseApiTaskPlacement({ ...input, [Symbol("hidden")]: true }),
		).toThrow();
		expect(() => parseApiTaskPlacement(Object.create(input))).toThrow();
		const children = Object.defineProperty(
			{ count: 0, token: "c".repeat(64) },
			"version",
			{
				enumerable: true,
				get() {
					throw new Error("getter");
				},
			},
		);
		expect(() =>
			parseApiTaskPlacement({
				...input,
				targetListId: "target",
				cascadeChildren: true,
				expectedChildrenState: children,
			}),
		).toThrow();
	});
});

test("maximum valid opaque key is accepted and IDs retain Unicode without unsafe code units", () => {
	expect(
		parseApiTaskPlacement({
			...input,
			sortKey: `a1${"V".repeat(254)}`,
			workspaceId: "é",
		}).sortKey.length,
	).toBe(256);
	for (const workspaceId of ["x\0", "x\uD800"])
		expect(() => parseApiTaskPlacement({ ...input, workspaceId })).toThrow();
});
