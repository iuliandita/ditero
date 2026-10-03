import { expect, test } from "vitest";
import { taskStateToken } from "../server/public-api/task-observation.ts";
import { PublicApiError } from "./public-api.ts";
import {
	type ApiTaskSnapshot,
	canonicalApiTaskSnapshot,
	canonicalApiTaskUpdate,
	parseApiTaskUpdate,
} from "./public-api-task-update.ts";

const token = "a".repeat(64);
const input = { listId: "list", expectedState: token, patch: { title: "New" } };
const snapshot: ApiTaskSnapshot = {
	version: 1,
	taskId: "task",
	listId: "list",
	workspaceId: "workspace",
	title: "Task",
	notes: null,
	dueAt: null,
	dueAllDay: false,
	priority: 0,
	createdAt: "2026-10-03T10:00:00.000Z",
	done: false,
	completedAt: null,
	listKind: "tasks",
	rrule: null,
	recurrenceRelative: false,
	recurrenceAnchorAt: null,
	recurrenceConsumed: null,
};

test("canonical update preserves omission and normalizes provided fields without supplying defaults", () => {
	const first = parseApiTaskUpdate({
		...input,
		patch: { dueAt: "2026-10-04T10:00:00+02:00", title: " New ", notes: null },
	});
	const second = parseApiTaskUpdate({
		...input,
		patch: { notes: null, title: "New", dueAt: "2026-10-04T08:00:00.000Z" },
	});
	expect(canonicalApiTaskUpdate("task", first)).toBe(
		canonicalApiTaskUpdate("task", second),
	);
	expect(first.patch).toEqual({
		title: "New",
		notes: null,
		dueAt: "2026-10-04T08:00:00.000Z",
	});
	expect(canonicalApiTaskUpdate("task", parseApiTaskUpdate(input))).not.toBe(
		canonicalApiTaskUpdate(
			"task",
			parseApiTaskUpdate({ ...input, patch: { title: "New", notes: null } }),
		),
	);
	expect(canonicalApiTaskUpdate("task", first)).toContain(
		'"operation":"task.update.v1"',
	);
});

test.each([
	{},
	{ ...input, patch: {} },
	{ ...input, patch: { title: "" } },
	{ ...input, patch: { title: "a".repeat(501) } },
	{ ...input, patch: { notes: "a".repeat(32769) } },
	{ ...input, patch: { priority: 4 } },
	{ ...input, patch: { priority: 1.5 } },
	{ ...input, patch: { dueAt: "tomorrow" } },
	{ ...input, patch: { done: true } },
	{ ...input, patch: { listId: "other" } },
	{ ...input, expectedState: "A".repeat(64) },
	{ ...input, patch: { title: undefined } },
])("invalid bounded patch refuses %#", (value) => {
	expect(() => parseApiTaskUpdate(value)).toThrow(PublicApiError);
});

test("raw own-key validation refuses prototype keys, symbols, accessors and hidden fields without invoking getters", () => {
	for (const key of ["__proto__", "constructor", "prototype"]) {
		for (const nesting of [false, true]) {
			const value = JSON.parse(JSON.stringify(input));
			Object.defineProperty(nesting ? value.patch : value, key, {
				value: {},
				enumerable: true,
			});
			expect(() => parseApiTaskUpdate(value)).toThrow(PublicApiError);
		}
	}
	let calls = 0;
	const accessor = { ...input, patch: {} };
	Object.defineProperty(accessor.patch, "title", {
		get: () => {
			calls++;
			return "Bad";
		},
		enumerable: true,
	});
	expect(() => parseApiTaskUpdate(accessor)).toThrow(PublicApiError);
	expect(calls).toBe(0);
	const hidden = { ...input };
	Object.defineProperty(hidden, "listId", { value: "list", enumerable: false });
	expect(() => parseApiTaskUpdate(hidden)).toThrow(PublicApiError);
	expect(() =>
		parseApiTaskUpdate({ ...input, [Symbol("extra")]: true }),
	).toThrow(PublicApiError);
	expect(() =>
		parseApiTaskUpdate(Object.assign(Object.create({}), input)),
	).toThrow(PublicApiError);
});

test("observation canonicalizes UTC milliseconds and every declared scalar affects the token", () => {
	expect(
		canonicalApiTaskSnapshot({
			...snapshot,
			createdAt: "2026-10-03T12:00:00+02:00",
		}),
	).toBe(canonicalApiTaskSnapshot(snapshot));
	const changes: Partial<ApiTaskSnapshot>[] = [
		{ taskId: "other" },
		{ listId: "other" },
		{ workspaceId: "other" },
		{ title: "Other" },
		{ notes: "Note" },
		{ dueAt: "2026-10-04T10:00:00.000Z" },
		{ dueAllDay: true },
		{ priority: 1 },
		{ createdAt: "2026-10-03T10:00:00.001Z" },
		{ done: true },
		{ completedAt: "2026-10-04T10:00:00.000Z" },
		{ listKind: "habits" },
		{ rrule: "FREQ=DAILY" },
		{ recurrenceRelative: true },
		{ recurrenceAnchorAt: "2026-10-04T10:00:00.000Z" },
		{ recurrenceConsumed: 1 },
	];
	const baseline = taskStateToken(snapshot);
	expect(baseline).toMatch(/^[a-f0-9]{64}$/);
	for (const change of changes)
		expect(taskStateToken({ ...snapshot, ...change })).not.toBe(baseline);
});
