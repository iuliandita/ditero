import { createHash } from "node:crypto";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

export const CALENDAR_MAX_TASKS = 10_000;
export const CALENDAR_MAX_BYTES = 8 * 1024 * 1024;
export const CALENDAR_MAX_TASK_TEXT_BYTES = 128 * 1024;
export type CalendarQuery = {
	workspaceId: string | null;
	listId: string | null;
};
export type CalendarTask = {
	id: string;
	title: string;
	notes: string | null;
	dueAt: Date | null;
	dueAllDay: boolean;
	done: boolean;
	completedAt: Date | null;
	priority: number;
};
const tooLarge = () =>
	new PublicApiError(
		422,
		"calendar-too-large",
		"Narrow the calendar snapshot with workspaceId or listId",
	);
const invalid = () =>
	new PublicApiError(
		422,
		"invalid-calendar-data",
		"Task data cannot be represented as an iCalendar snapshot",
	);
export function parseCalendarQuery(url: URL): CalendarQuery {
	for (const key of url.searchParams.keys())
		if (
			!["workspaceId", "listId"].includes(key) ||
			url.searchParams.getAll(key).length !== 1
		)
			throw new PublicApiError(
				400,
				"invalid-query",
				"Invalid calendar query parameters",
			);
	const workspaceId = url.searchParams.get("workspaceId"),
		listId = url.searchParams.get("listId");
	for (const id of [workspaceId, listId])
		if (id !== null && !PUBLIC_API_ID.safeParse(id).success)
			throw new PublicApiError(
				400,
				"invalid-query",
				"Invalid calendar query parameters",
			);
	return { workspaceId, listId };
}
export function calendarText(value: string): string {
	for (const point of value) {
		const code = point.codePointAt(0) ?? 0;
		if (
			(code < 32 && ![9, 10, 13].includes(code)) ||
			code === 127 ||
			(code >= 0xd800 && code <= 0xdfff)
		)
			throw invalid();
	}
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\r\n|\r|\n/g, "\\n")
		.replace(/;/g, "\\;")
		.replace(/,/g, "\\,");
}
export function foldCalendarLine(value: string): string {
	const lines: string[] = [];
	let line = "",
		bytes = 0;
	for (const point of value) {
		const width = Buffer.byteLength(point);
		if (bytes + width > 75) {
			lines.push(line);
			line = " ";
			bytes = 1;
		}
		line += point;
		bytes += width;
	}
	lines.push(line);
	return `${lines.join("\r\n")}\r\n`;
}
export function calendarTaskUid(id: string): string {
	return `${createHash("sha256").update("ditero-task-v1\0").update(id).digest("hex")}@ditero`;
}
function instant(value: Date): string {
	if (
		!Number.isFinite(value.getTime()) ||
		value.getUTCFullYear() < 1 ||
		value.getUTCFullYear() > 9999
	)
		throw invalid();
	return `${value.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}
export function createCalendarSnapshot(stamp: Date, timezone: string) {
	let date: Intl.DateTimeFormat;
	try {
		date = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
	} catch {
		throw invalid();
	}
	const chunks: string[] = [];
	let bytes = 0,
		count = 0,
		finished = false;
	const append = (line: string) => {
		const encoded = foldCalendarLine(line);
		bytes += Buffer.byteLength(encoded);
		if (bytes > CALENDAR_MAX_BYTES) throw tooLarge();
		chunks.push(encoded);
	};
	append("BEGIN:VCALENDAR");
	append("VERSION:2.0");
	append("PRODID:-//Ditero//Task snapshot v1//EN");
	append("CALSCALE:GREGORIAN");
	return {
		add(task: CalendarTask) {
			if (finished) throw new Error("Calendar snapshot already finished");
			if (
				++count > CALENDAR_MAX_TASKS ||
				Buffer.byteLength(task.title) + Buffer.byteLength(task.notes ?? "") >
					CALENDAR_MAX_TASK_TEXT_BYTES
			)
				throw tooLarge();
			append("BEGIN:VTODO");
			append(`UID:${calendarTaskUid(task.id)}`);
			append(`DTSTAMP:${instant(stamp)}`);
			append(`SUMMARY:${calendarText(task.title)}`);
			if (task.notes !== null)
				append(`DESCRIPTION:${calendarText(task.notes)}`);
			append(`STATUS:${task.done ? "COMPLETED" : "NEEDS-ACTION"}`);
			if (task.dueAt !== null) {
				if (task.dueAllDay) {
					instant(task.dueAt);
					const parts = date.formatToParts(task.dueAt);
					const part = (name: string) =>
						parts.find((value) => value.type === name)?.value ?? "";
					const day =
						part("year").padStart(4, "0") + part("month") + part("day");
					if (!/^\d{8}$/.test(day)) throw invalid();
					append(`DUE;VALUE=DATE:${day}`);
				} else append(`DUE:${instant(task.dueAt)}`);
			}
			if (task.done && task.completedAt !== null)
				append(`COMPLETED:${instant(task.completedAt)}`);
			if (
				!Number.isInteger(task.priority) ||
				task.priority < 0 ||
				task.priority > 3
			)
				throw invalid();
			append(`PRIORITY:${[0, 9, 5, 1][task.priority]}`);
			append("END:VTODO");
		},
		finish() {
			if (finished) throw new Error("Calendar snapshot already finished");
			finished = true;
			append("END:VCALENDAR");
			return chunks.join("");
		},
	};
}
