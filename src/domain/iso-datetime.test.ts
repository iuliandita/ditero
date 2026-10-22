import { expect, test } from "vitest";
import { isoDateTimeSchema } from "./iso-datetime.ts";
import { parseApiTaskComplete } from "./public-api-completion.ts";
import { parseApiTaskUpdate } from "./public-api-task-update.ts";
import { parseApiTaskCreate } from "./public-api-writes.ts";

test("timestamp schemas preserve minute, second and millisecond precision with offset and Z", () => {
	for (const zone of ["+02:00", "-05:30", "Z"]) {
		for (const time of ["12:30", "12:30:45", "12:30:45.123"]) {
			const dueAt = `2026-10-22T${time}${zone}`;
			const expected = new Date(dueAt).toISOString();
			expect(isoDateTimeSchema({ offset: true }).parse(dueAt)).toBe(dueAt);
			expect(isoDateTimeSchema().safeParse(dueAt).success).toBe(zone === "Z");
			expect(
				parseApiTaskCreate({ listId: "list", title: "Task", dueAt }).dueAt,
			).toBe(expected);
			expect(
				parseApiTaskUpdate({
					listId: "list",
					expectedState: "a".repeat(64),
					patch: { dueAt },
				}).patch.dueAt,
			).toBe(expected);
			expect(
				parseApiTaskComplete({ listId: "list", expectedDueAt: dueAt })
					.expectedDueAt,
			).toBe(expected);
		}
	}
	for (const invalid of [
		"2026-10-22T12:30",
		"2026-02-30T12:30Z",
		"2026-10-22T24:30Z",
		"2026-10-22T12:60Z",
		"2026-10-22T12:30+24:00",
		"2026-10-22T12:30:60Z",
	])
		expect(isoDateTimeSchema({ offset: true }).safeParse(invalid).success).toBe(
			false,
		);
});
