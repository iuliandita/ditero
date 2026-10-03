import type { PoolClient } from "pg";
import { expect, test, vi } from "vitest";
import { canonicalChildRow } from "../server/public-api/deletion-observation.ts";
import { PublicApiError } from "./public-api.ts";
import {
	canonicalApiTaskDelete,
	parseApiTaskDelete,
} from "./public-api-task-deletion.ts";

const input = {
	listId: "list",
	expectedState: "a".repeat(64),
	expectedChildrenState: {
		version: 1 as const,
		count: 0,
		token: "b".repeat(64),
	},
	cascadeChildren: false,
};
test("delete canonicalization binds operation, target, scope, count and state independent of key order", () => {
	expect(canonicalApiTaskDelete("task", input)).toBe(
		canonicalApiTaskDelete(
			"task",
			parseApiTaskDelete({
				cascadeChildren: false,
				expectedChildrenState: { token: "b".repeat(64), count: 0, version: 1 },
				expectedState: input.expectedState,
				listId: "list",
			}),
		),
	);
	expect(canonicalApiTaskDelete("task", input)).toContain(
		'"operation":"task.delete.v1"',
	);
	for (const change of [
		{ listId: "other" },
		{ expectedState: "c".repeat(64) },
		{ cascadeChildren: true },
		{ expectedChildrenState: { ...input.expectedChildrenState, count: 1 } },
	])
		expect(canonicalApiTaskDelete("task", { ...input, ...change })).not.toBe(
			canonicalApiTaskDelete("task", input),
		);
});
test.each([
	{},
	{ ...input, cascadeChildren: undefined },
	{ ...input, cascadeChildren: "true" },
	{ ...input, extra: true },
	{
		...input,
		expectedChildrenState: { ...input.expectedChildrenState, count: -1 },
	},
	{
		...input,
		expectedChildrenState: { ...input.expectedChildrenState, count: 1.5 },
	},
	{
		...input,
		expectedChildrenState: { ...input.expectedChildrenState, extra: 1 },
	},
	{ ...input, expectedState: "A".repeat(64) },
])("invalid strict deletion body refuses %#", (value) =>
	expect(() => parseApiTaskDelete(value)).toThrow(PublicApiError));
test("nested accessors, symbols, hidden keys and prototypes are refused without getter execution", () => {
	let calls = 0;
	const state = { ...input.expectedChildrenState };
	Object.defineProperty(state, "token", {
		get() {
			calls++;
			return input.expectedChildrenState.token;
		},
		enumerable: true,
	});
	expect(() =>
		parseApiTaskDelete({ ...input, expectedChildrenState: state }),
	).toThrow(PublicApiError);
	expect(calls).toBe(0);
	for (const value of [
		{ ...input, [Symbol("extra")]: true },
		Object.assign(Object.create({}), input),
		{
			...input,
			expectedChildrenState: JSON.parse(
				'{"version":1,"count":0,"token":"' +
					input.expectedChildrenState.token +
					'","__proto__":{}}',
			),
		},
	])
		expect(() => parseApiTaskDelete(value)).toThrow(PublicApiError);
});
test("child canonical framing sorts all persisted keys without dropping opaque future fields", () => {
	expect(canonicalChildRow({ z: null, a: "x" })).toBe('{"a":"x","z":null}');
	expect(canonicalChildRow({ z: null, a: "x", future: false })).not.toBe(
		canonicalChildRow({ a: "x", z: null }),
	);
});

test("an elapsed child observation deadline closes its cursor without returning a partial token", async () => {
	const commands: string[] = [];
	let clock = 0;
	const client = {
		query: async (text: string) => {
			commands.push(text);
			if (text.startsWith("fetch")) {
				clock = 5001;
				return {
					rowCount: 1,
					rows: [{ row: { id: "child", list_id: "list" } }],
				};
			}
			return { rowCount: 0, rows: [] };
		},
	} as unknown as PoolClient;
	const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
	try {
		const { observeDeletionChildren } = await import(
			"../server/public-api/deletion-observation.ts"
		);
		await expect(
			observeDeletionChildren(client, "task", "list"),
		).rejects.toMatchObject({ status: 503, code: "temporarily-unavailable" });
		expect(
			commands.some((value) => value.startsWith("fetch forward 256")),
		).toBe(true);
		expect(commands.at(-1)).toBe("close api_deletion_children");
	} finally {
		now.mockRestore();
	}
});
