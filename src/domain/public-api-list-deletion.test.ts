import { expect, test } from "vitest";
import { PublicApiError } from "./public-api.ts";
import {
	apiListDeleteAckSchema,
	apiListDeletionObservationSchema,
	canonicalApiListDelete,
	parseApiListDelete,
} from "./public-api-list-deletion.ts";

const input = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	expectedTasksState: { version: 1 as const, count: 0, token: "b".repeat(64) },
	cascadeTasks: false,
};
const snapshot = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "List",
	kind: "tasks" as const,
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink" as const,
};
test("strict canonical deletion binds list, workspace, count, tokens and explicit cascade", () => {
	expect(parseApiListDelete(input)).toEqual(input);
	expect(canonicalApiListDelete("list", input)).toContain(
		'"operation":"list.delete.v1"',
	);
	expect(
		canonicalApiListDelete("list", {
			...input,
			expectedTasksState: {
				token: input.expectedTasksState.token,
				count: 0,
				version: 1,
			},
		}),
	).toBe(canonicalApiListDelete("list", input));
	for (const changed of [
		{ ...input, workspaceId: "other" },
		{ ...input, expectedState: "c".repeat(64) },
		{ ...input, cascadeTasks: true },
		{ ...input, expectedTasksState: { ...input.expectedTasksState, count: 1 } },
		{
			...input,
			expectedTasksState: {
				...input.expectedTasksState,
				token: "c".repeat(64),
			},
		},
	])
		expect(canonicalApiListDelete("list", changed)).not.toBe(
			canonicalApiListDelete("list", input),
		);
	expect(canonicalApiListDelete("other", input)).not.toBe(
		canonicalApiListDelete("list", input),
	);
});
test.each([
	null,
	[],
	{},
	{ ...input, extra: true },
	{ ...input, cascadeTasks: undefined },
	{ ...input, cascadeTasks: 0 },
	{ ...input, workspaceId: "" },
	{ ...input, workspaceId: "bad\0id" },
	{ ...input, workspaceId: "bad\uD800" },
	{ ...input, expectedState: "A".repeat(64) },
	...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((count) => ({
		...input,
		expectedTasksState: { ...input.expectedTasksState, count },
	})),
	{ ...input, expectedTasksState: { ...input.expectedTasksState, version: 2 } },
	{
		...input,
		expectedTasksState: { ...input.expectedTasksState, extra: true },
	},
	Object.assign(Object.create({}), input),
	{ ...input, [Symbol("extra")]: true },
])("refuses malformed fields %j", (value) =>
	expect(() => parseApiListDelete(value)).toThrow(PublicApiError));
test("does not evaluate accessors and rejects nonenumerable fields", () => {
	let called = false;
	const value = Object.defineProperty({ ...input }, "cascadeTasks", {
		enumerable: true,
		get() {
			called = true;
			return false;
		},
	});
	expect(() => parseApiListDelete(value)).toThrow();
	expect(called).toBe(false);
	expect(() =>
		parseApiListDelete(
			Object.defineProperty({ ...input }, "cascadeTasks", {
				enumerable: false,
				value: false,
			}),
		),
	).toThrow();
});
test("observation and deletion acknowledgement are strict original list contracts", () => {
	expect(
		apiListDeletionObservationSchema.parse({
			snapshot,
			stateToken: input.expectedState,
			tasksState: input.expectedTasksState,
		}).snapshot,
	).toEqual(snapshot);
	expect(
		apiListDeleteAckSchema.parse({
			kind: "list-delete-ack",
			snapshot,
			deletedTasks: 0,
		}).snapshot,
	).toEqual(snapshot);
	for (const bad of [
		{ kind: "list-update-ack", snapshot, deletedTasks: 0 },
		{
			kind: "list-delete-ack",
			snapshot: { ...snapshot, extra: true },
			deletedTasks: 0,
		},
		{ kind: "list-delete-ack", snapshot, deletedTasks: -1 },
	])
		expect(apiListDeleteAckSchema.safeParse(bad).success).toBe(false);
});
