import { expect, test } from "vitest";
import {
	canonicalApiTaskCreate,
	parseApiIdempotencyKey,
	parseApiTaskCreate,
} from "./public-api-writes.ts";

test("canonicalizes defaults, identifier sets and equivalent due instants", () => {
	const first = parseApiTaskCreate({
		listId: "private",
		title: "  Tomorrow  ",
		dueAt: "2026-10-04T10:00:00+02:00",
		assigneeIds: ["z", "a"],
	});
	const second = parseApiTaskCreate({
		title: "Tomorrow",
		listId: "private",
		dueAt: "2026-10-04T08:00:00Z",
		assigneeIds: ["a", "z"],
		labelIds: [],
		dueAllDay: false,
		priority: 0,
		notes: null,
	});
	expect(canonicalApiTaskCreate(first)).toBe(canonicalApiTaskCreate(second));
	expect(first.dueAt).toBe("2026-10-04T08:00:00.000Z");
	expect(first.assigneeIds).toEqual(["a", "z"]);
});

test.each([
	{ listId: "private", title: "" },
	{ listId: "", title: "Task" },
	{ listId: "private", title: "Task", priority: 4 },
	{ listId: "private", title: "Task", assigneeIds: ["a", "a"] },
	{ listId: "private", title: "Task", labelIds: ["a", "a"] },
	{ listId: "private", title: "Task", dueAt: "tomorrow" },
	{ listId: "private", title: "Task", dueAllDay: true },
	{ listId: "private", title: "Task", invite: "Alex" },
	JSON.parse('{"listId":"private","title":"Task","__proto__":{}}'),
	{ listId: "private", title: "Task", notes: "a".repeat(32_769) },
	{
		listId: "private",
		title: "Task",
		assigneeIds: Array.from({ length: 21 }, (_, n) => String(n)),
	},
])("rejects malformed, ambiguous and oversized input %j", (input) => {
	expect(() => parseApiTaskCreate(input)).toThrow();
});

test("requires an explicit UUID retry key and normalizes its case", () => {
	const key = "ABCD1234-ABCD-4123-8123-ABCDEF123456";
	expect(parseApiIdempotencyKey(key)).toBe(key.toLowerCase());
	for (const value of [
		null,
		"",
		"task",
		"abcd1234-abcd-4123-8123-abcdef123456,abcd1234-abcd-4123-8123-abcdef123456",
	])
		expect(() => parseApiIdempotencyKey(value)).toThrow();
});
