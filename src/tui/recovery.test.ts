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
