import { expect, test } from "vitest";
import { parseContentProvider } from "./content.ts";
import type { ContentOptions } from "./content-common.ts";

const options: ContentOptions = {
	exportedAt: "2026-10-22T00:00:00.000Z",
	projectFolderName: "Project",
	unsectionedListName: "Tasks",
	timezone: "Europe/Bucharest",
};
const bytes = (text: string) => new TextEncoder().encode(text);

test("skipped Todoist task owns neither following notes nor descendants", async () => {
	const result = await parseContentProvider(
		"todoist",
		bytes(
			"TYPE,CONTENT,INDENT\ntask,Good,1\ntask,@label,1\nnote,Rejected note,\ntask,Child,2\ntask,Grandchild,3\ntask,Next,1\nnote,Next note,\n",
		),
		options,
	);
	expect(
		result.document.data.tasks.map((task) => [
			task.title,
			task.notes,
			task.parentId,
		]),
	).toEqual([
		["Good", null, null],
		["Next", "Next note", null],
	]);
	for (const row of [3, 4, 5, 6])
		expect(result.notices).toContainEqual({
			code: "row-skipped",
			path: `row:${row}`,
			count: 1,
		});
});

test.each([
	"x".repeat(32_769),
	"😀".repeat(20_000),
])("oversized CSV cell keeps other rows and names its row (%#)", async (notes) => {
	const result = await parseContentProvider(
		"generic-csv",
		bytes(`title,notes\nBefore,ok\nLong,"${notes}"\nAfter,fine\n`),
		options,
	);
	expect(result.document.data.tasks.map((task) => task.title)).toEqual([
		"Before",
		"Long",
		"After",
	]);
	const shortened = result.document.data.tasks[1]?.notes ?? "";
	expect(shortened.length).toBeGreaterThan(0);
	expect(new TextEncoder().encode(shortened).byteLength).toBeLessThan(32_768);
	expect(shortened.isWellFormed()).toBe(true);
	expect(
		result.notices.some(
			(notice) =>
				notice.code === "field-truncated" && notice.path === "row:3:notes",
		),
	).toBe(true);
});

test.each([
	["2026-10-22T14:00", "2026-10-22T11:00:00.000Z"],
	["2026-10-22T14:00:12", "2026-10-22T11:00:12.000Z"],
	["2026-10-22T14:00:12Z", "2026-10-22T14:00:12.000Z"],
	["2026-10-22T14:00:12+02:00", "2026-10-22T12:00:12.000Z"],
	["2026-10-22T14:00-0400", "2026-10-22T18:00:00.000Z"],
])("Todoist ISO datetime delegates %s to the common validator", async (value, expected) => {
	const result = await parseContentProvider(
		"todoist",
		bytes(`TYPE,CONTENT,DATE\ntask,Timed,${value}\n`),
		options,
	);
	expect(result.document.data.tasks[0]?.dueAt).toBe(expected);
	expect(result.document.data.tasks[0]?.dueAllDay).toBe(false);
	expect(
		result.notices.some((notice) => notice.code === "unsupported-date"),
	).toBe(false);
});

test("a skipped Todoist child preserves the parent of its next valid sibling", async () => {
	const result = await parseContentProvider(
		"todoist",
		bytes(
			"TYPE,CONTENT,INDENT\ntask,Parent,1\ntask,@label,2\nnote,Rejected note,\ntask,Grandchild,3\ntask,Sibling,2\nnote,Sibling note,\n",
		),
		options,
	);
	const [parent, sibling] = result.document.data.tasks;
	expect(result.document.data.tasks).toHaveLength(2);
	expect(parent).toMatchObject({
		title: "Parent",
		notes: null,
		parentId: null,
	});
	expect(sibling).toMatchObject({
		title: "Sibling",
		notes: "Sibling note",
		parentId: parent?.id,
	});
	for (const row of [3, 4, 5])
		expect(result.notices).toContainEqual({
			code: "row-skipped",
			path: `row:${row}`,
			count: 1,
		});
	expect(result.notices.some((notice) => notice.path === "row:6:INDENT")).toBe(
		false,
	);
});
