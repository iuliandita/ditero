import { describe, expect, it } from "vitest";
import { serializeRetryRecord } from "./recovery.ts";

describe("terminal retry records", () => {
	it.each([
		[
			"DEL and C1",
			Array.from({ length: 33 }, (_, index) =>
				String.fromCharCode(127 + index),
			).join(""),
		],
		[
			"bidi controls",
			"\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069",
		],
		["line separators", "\u2028\u2029"],
	])("escapes %s while retaining exact retry payload", (_name, characters) => {
		const record = {
			requestId: "00000000-0000-4000-8000-000000000001",
			endpoint: "/api/v1/tasks",
			body: {
				title: `Milk${characters}عربي`,
				notes: "\u0000\n\t\u001b",
				dueAt: null,
				labelIds: [],
			},
		};
		const serialized = serializeRetryRecord(record);
		for (const character of characters)
			expect(serialized.includes(character)).toBe(false);
		expect(JSON.parse(serialized)).toEqual(record);
		expect(serialized.split("\n")).toHaveLength(1);
	});
});

it("retains the exact placement PATCH, UUID, endpoint and guarded body for one explicit retry", () => {
	const record = {
		method: "PATCH" as const,
		endpoint: "/api/v1/tasks/task%2Fid/placement",
		requestId: "00000000-0000-4000-8000-000000000001",
		body: {
			workspaceId: "workspace",
			listId: "list",
			expectedState: "a".repeat(64),
			targetListId: "list",
			expectedTargetState: "b".repeat(64),
			sortKey: "a5",
			cascadeChildren: false,
			expectedChildrenState: null,
		},
	};
	const text = serializeRetryRecord(record);
	expect(JSON.parse(text)).toEqual(record);
	expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(record));
	expect(text.split("\n")).toHaveLength(1);
	// Serializing never changes the record, so a retry reuses identical bytes.
	expect(serializeRetryRecord(record)).toBe(text);
	expect(JSON.parse(text).body.sortKey).toBe("a5");
});

it.each([
	"PATCH",
	"DELETE",
] as const)("retains the %s method and exact guarded body without terminal controls", (method) => {
	const record = {
		method,
		endpoint: "/api/v1/tasks/task",
		requestId: "00000000-0000-4000-8000-000000000001",
		body: {
			listId: "list",
			expectedState: "a".repeat(64),
			patch: { notes: "first\nsecond\u009b" },
		},
	};
	const text = serializeRetryRecord(record);
	expect(JSON.parse(text)).toEqual(record);
	expect(text).not.toContain("\u009b");
	expect(text.split("\n")).toHaveLength(1);
});
