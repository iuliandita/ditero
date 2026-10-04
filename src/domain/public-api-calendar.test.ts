import { expect, test } from "vitest";
import {
	CALENDAR_MAX_TASK_TEXT_BYTES,
	CALENDAR_MAX_TASKS,
	type CalendarTask,
	calendarTaskUid,
	calendarText,
	createCalendarSnapshot,
	foldCalendarLine,
	parseCalendarQuery,
} from "./public-api-calendar.ts";

const task: CalendarTask = {
	id: "task",
	title: "Task",
	notes: null,
	dueAt: null,
	dueAllDay: false,
	done: false,
	completedAt: null,
	priority: 0,
};
const stamp = new Date("2026-10-03T12:34:56.789Z");
const unfold = (value: string) => value.replace(/\r\n /g, "");
function snapshot(value: CalendarTask = task, timezone = "UTC") {
	const writer = createCalendarSnapshot(stamp, timezone);
	writer.add(value);
	return unfold(writer.finish());
}
test("VTODO has deterministic opaque UID and mandatory stamp, with no fabricated recurrence or identity", () => {
	const value = snapshot();
	expect(value).toContain("BEGIN:VTODO\r\n");
	expect(value).toContain("DTSTAMP:20261003T123456Z\r\n");
	expect(value).toContain(`UID:${calendarTaskUid("task")}\r\n`);
	expect(calendarTaskUid("task")).toMatch(/^[a-f0-9]{64}@ditero$/);
	expect(calendarTaskUid("other")).not.toBe(calendarTaskUid("task"));
	for (const field of [
		"RRULE:",
		"BEGIN:VEVENT",
		"ORGANIZER:",
		"ATTENDEE:",
		"BEGIN:VALARM",
	])
		expect(value).not.toContain(field);
	expect(value).toContain("STATUS:NEEDS-ACTION");
	expect(value).toContain("PRIORITY:0");
});
test("TEXT escapes separators, backslash and every line break without content-line injection", () => {
	const original =
		"Comma, semicolon; slash\\ line\r\nEND:VTODO\nBEGIN:VEVENT\rfinal";
	expect(calendarText(original)).toBe(
		"Comma\\, semicolon\\; slash\\\\ line\\nEND:VTODO\\nBEGIN:VEVENT\\nfinal",
	);
	const value = snapshot({ ...task, title: original, notes: original });
	expect(
		value.split("\r\n").filter((line) => line === "END:VTODO"),
	).toHaveLength(1);
	expect(value.split("\r\n")).not.toContain("BEGIN:VEVENT");
});
test("UTF8 folding includes continuation space in the75byte budget and round-trips Unicode", () => {
	for (const value of [
		`SUMMARY:${"a".repeat(70)}${"😀é中".repeat(50)}`,
		`DESCRIPTION:${"مرحبا".repeat(40)}`,
	]) {
		const folded = foldCalendarLine(value);
		expect(unfold(folded)).toBe(`${value}\r\n`);
		for (const line of folded.split("\r\n").filter(Boolean)) {
			expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
			expect(line).not.toContain("�");
		}
		expect(folded).toContain("\r\n ");
	}
});
test("all-day dates use the user timezone and timed due/completed properties use UTC seconds", () => {
	const dueAt = new Date("2026-10-03T23:30:00.999Z");
	expect(
		snapshot({ ...task, dueAt, dueAllDay: true }, "Europe/Berlin"),
	).toContain("DUE;VALUE=DATE:20261004");
	expect(
		snapshot({ ...task, dueAt, dueAllDay: true }, "America/Los_Angeles"),
	).toContain("DUE;VALUE=DATE:20261003");
	const value = snapshot({
		...task,
		dueAt,
		done: true,
		completedAt: new Date("2026-10-04T03:04:05.123Z"),
		priority: 3,
	});
	expect(value).toContain("DUE:20261003T233000Z");
	expect(value).toContain("COMPLETED:20261004T030405Z");
	expect(value).toContain("STATUS:COMPLETED");
	expect(value).toContain("PRIORITY:1");
});
test.each([
	"\0",
	"\x1f",
	"\x7f",
	"\ud800",
])("unrepresentable TEXT refuses %#", (value) =>
	expect(() => calendarText(value)).toThrow());
test("whole-snapshot limits fail closed, while an empty calendar is valid", () => {
	const writer = createCalendarSnapshot(stamp, "UTC");
	expect(writer.finish()).toBe(
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ditero//Task snapshot v1//EN\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n",
	);
	expect(() =>
		snapshot({ ...task, notes: "x".repeat(CALENDAR_MAX_TASK_TEXT_BYTES) }),
	).toThrow();
	const many = createCalendarSnapshot(stamp, "UTC");
	for (let i = 0; i < CALENDAR_MAX_TASKS; i++)
		many.add({ ...task, id: `task-${i}` });
	expect(() => many.add(task)).toThrow();
});
test.each([
	"?token=secret",
	"?access_token=secret",
	"?workspaceId=",
	"?listId=",
	"?listId=a&listId=b",
	"?done=false",
	`?workspaceId=${"a".repeat(257)}`,
])("strict calendar query refuses %s", (query) =>
	expect(() =>
		parseCalendarQuery(new URL(`http://localhost/api/v1/calendar.ics${query}`)),
	).toThrow());
test("calendar query accepts only the two explicit scope filters", () =>
	expect(
		parseCalendarQuery(
			new URL("http://localhost/api/v1/calendar.ics?workspaceId=w&listId=l"),
		),
	).toEqual({ workspaceId: "w", listId: "l" }));
