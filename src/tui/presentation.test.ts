import { describe, expect, it } from "vitest";
import type { Locale } from "../domain/locale.ts";
import type { Entry } from "./api.ts";
import type { Review } from "./controller.ts";
import {
	entryDetails,
	exactPayloadLines,
	exactPayloadParts,
	helpDetails,
	loadedTaskCounts,
	priorityLabel,
	reviewDetails,
	reviewParts,
	reviewPayload,
	taskRow,
} from "./presentation.ts";
import {
	renderFrame,
	visibleCells,
	wrapLines,
	wrapParts,
	wrapWords,
} from "./render.ts";

const context = {
	locale: "en" as Locale,
	timezone: "America/Los_Angeles",
	now: Date.parse("2026-10-04T03:00:00Z"),
};
const entry: Entry = {
	id: "task",
	label: "Milk",
	data: {
		id: "task",
		title: "Milk",
		done: false,
		dueAt: "2026-10-04T01:00:00Z",
		dueAllDay: true,
		priority: 3,
		notes: "First\nSecond",
		rrule: "FREQ=DAILY",
		recurrenceRelative: true,
		quantity: "2",
		unit: "L",
		assigneeIds: ["person"],
		labelIds: ["label-1", "label-2"],
	},
};
describe("terminal task presentation", () => {
	it("keeps exact JSON string bytes through safe terminal layout", () => {
		const payload = {
			title: "A  B\u202e\u00a0C\u2028D\u2029E\u2003F\u3000G",
			notes: 'Quote " and slash \\ plus\nnewline',
			labels: ["a b"],
		};
		const lines = exactPayloadLines(payload);
		expect(JSON.parse(wrapLines(lines, 1000).join("\n"))).toEqual(payload);
		expect(lines.join("\n")).not.toContain("\u202e");
	});
	it("highlights JSON tokens without changing escaped keys, values or numeric exponents", () => {
		const key = 'key " \\';
		const value = 'true null 42 "quoted" \\ \u001b[2J\u202e\u00a0';
		const payload = {
			[key]: value,
			numbers: [-12.5, 1e-7, 1e21],
			flags: [true, false, null],
		};
		const parts = exactPayloadParts(payload);
		const lines = parts.map((line) => line.map((part) => part.text).join(""));
		expect(lines).toEqual(exactPayloadLines(payload));
		expect(JSON.parse(lines.join("\n"))).toEqual(payload);
		const tokens = parts.flat();
		expect(
			tokens
				.filter((part) => part.tone === "brand")
				.map((part) => JSON.parse(part.text)),
		).toEqual(Object.keys(payload));
		expect(
			JSON.parse(
				tokens.find((part) => part.tone === "success")?.text ?? "null",
			),
		).toBe(value);
		expect(
			tokens.filter((part) => part.tone === "warning").map((part) => part.text),
		).toEqual(["-12.5", "1e-7", "1e+21"]);
		expect(
			tokens
				.filter((part) => part.tone === "recurring")
				.map((part) => part.text),
		).toEqual(["true", "false"]);
		expect(tokens).toContainEqual({ text: "null", tone: "info", dim: true });
		expect(lines.join("\n")).not.toContain(String.fromCharCode(27));
	});
	it.each([
		40, 60, 100,
	])("preserves exact JSON and no-color layout through wrapping at %s columns", (columns) => {
		const payload = {
			title: 'Long "title" with \\ and spaces'.repeat(3),
			done: true,
			priority: 3,
			notes: null,
		};
		const wrapped = wrapParts(exactPayloadParts(payload), columns - 5);
		expect(
			wrapped
				.flat()
				.map((part) => part.text)
				.join(""),
		).toBe(wrapLines(exactPayloadLines(payload), columns - 5).join(""));
		for (const line of wrapped)
			expect(
				visibleCells(line.map((part) => part.text).join("")),
			).toBeLessThanOrEqual(columns - 5);
		const frame = {
			title: "JSON",
			status: "Ready",
			footer: "",
			rows: [],
			selected: 0,
			detailParts: wrapped,
			framed: true,
		};
		const plain = renderFrame(frame, columns, 40);
		const colored = renderFrame({ ...frame, color: true }, columns, 40);
		expect(
			colored.replace(
				new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
				"",
			),
		).toBe(plain);
		expect(plain).not.toContain(String.fromCharCode(27));
		for (const code of [36, 32, 33, 35])
			expect(colored).toContain(`${String.fromCharCode(27)}[${code}m`);
		expect(colored).toContain(`${String.fromCharCode(27)}[34;2mnull`);
	});

	it("separates help topics and keeps narrow English words intact in all available help", () => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as Locale[]) {
			const topics = helpDetails({ ...context, locale });
			expect(topics.filter((line) => line === "")).toHaveLength(5);
			expect(topics.join(" ")).not.toContain("undefined");
			const wrapped = wrapWords(topics, 39);
			expect(wrapped.filter((line) => line === "")).toHaveLength(5);
			for (const line of wrapped)
				expect(visibleCells(line)).toBeLessThanOrEqual(39);
		}
		const source = helpDetails(context)[0] ?? "";
		const words = new Set(source.split(" "));
		for (const line of wrapWords([source], 39))
			for (const word of line.split(" ")) expect(words.has(word)).toBe(true);
	});

	it("uses the account day boundary for dates and overdue all-day tasks", () => {
		const row = taskRow(entry, context);
		expect(row.text).toBe("○ High   Milk");
		expect(row.metadata).toContain("Oct 3, 2026");
		expect(row.metadata).not.toContain("Overdue");
		expect(
			taskRow(entry, { ...context, now: Date.parse("2026-10-04T08:00:00Z") })
				.metadata,
		).toContain("Overdue");
		expect(row.metadata).toContain("2 L");
		expect(row.metadata).toContain("@1 #2");
		expect(row.parts).toContainEqual({
			text: "High",
			tone: "danger",
			fieldWidth: 7,
		});
		expect(row.parts.at(-1)).toEqual({
			text: "Milk",
			tone: "plain",
			dim: false,
		});
		expect(row.tone).toBe("plain");
	});
	it.each([
		"en",
		"de",
		"es",
		"fr",
		"ro",
		"ar",
	] as Locale[])("renders available metadata and honest identifiers in %s", (locale) => {
		const current = { ...context, locale };
		expect(taskRow(entry, current).metadata).not.toContain("undefined");
		const detail = entryDetails(entry, current);
		expect(detail).toContain("First");
		expect(detail).toContain("Second");
		expect(detail.join("\n")).toContain("person");
		expect(detail.join("\n")).not.toContain("synced");
	});
	it("shows completion and recurrence without depending on color", () => {
		expect(
			taskRow({ ...entry, data: { ...entry.data, done: true } }, context),
		).toMatchObject({ text: "● High   Milk", tone: "plain" });
		expect(taskRow(entry, context).metadata).toContain("Repeat");
	});
	it("uses the planner timezone for create review, with the exact request and identity", () => {
		const review: Review = {
			kind: "create",
			requestId: "request",
			uncertain: false,
			timezone: "Asia/Tokyo",
			list: Object.freeze({ id: "list", name: "Weekly plan" }),
			task: {
				title: "Milk",
				listId: "list",
				notes: null,
				dueAt: "2026-10-04T01:00:00.000Z",
				dueAllDay: false,
				priority: 0,
				assigneeIds: [],
				labelIds: [],
			},
		};
		const summary = reviewDetails(review, context, false).join("\n");
		expect(summary).toContain("Oct 4, 2026");
		expect(summary).toContain("10:00 AM");
		expect(summary).toContain("POST /api/v1/tasks");
		expect(summary.indexOf("Task title: Milk")).toBeLessThan(
			summary.indexOf("Request ID:"),
		);
		expect(summary.indexOf("Oct 4, 2026")).toBeLessThan(
			summary.indexOf("Request ID:"),
		);
		const parts = reviewParts(review, context);
		expect(parts.find((line) => line[0]?.text === "Task title: ")).toEqual([
			{ text: "Task title: ", tone: "brand", bold: true },
			{ text: "Milk", tone: "plain", bold: true, dim: false },
		]);
		expect(
			parts.find((line) => line[0]?.text === "Request ID: request"),
		).toEqual([{ text: "Request ID: request", tone: "plain", dim: true }]);
		expect(
			parts.find((line) => line[0]?.text === "POST /api/v1/tasks"),
		).toEqual([{ text: "POST /api/v1/tasks", tone: "plain", dim: true }]);
		expect(
			parts.find((line) => line[0]?.text === "Notes: ")?.[1],
		).toMatchObject({ text: "None", dim: true });
		expect(
			reviewParts(
				{ ...review, task: { ...review.task, title: "None" } },
				context,
			).find((line) => line[0]?.text === "Task title: ")?.[1],
		).toMatchObject({ text: "None", bold: true, dim: false });
		expect(summary).toContain("Priority: None");
		expect(summary).not.toContain("Priority: None (0)");
		expect(
			JSON.parse(reviewDetails(review, context, true).slice(2).join("\n")).body
				.priority,
		).toBe(0);
		expect(summary).toContain("List: Weekly plan");
		expect(summary).toContain("List ID: list");
		expect(
			reviewDetails(
				{ ...review, list: { id: "other", name: "Wrong" } },
				context,
				false,
			).join("\n"),
		).not.toContain("Wrong");
		expect(summary).not.toContain("Not sent");
		expect(summary).toContain("All day: No");
		expect(reviewPayload(review).body).toBe(review.task);
		expect(reviewDetails(review, context, true).join("\n")).toContain(
			JSON.stringify(review.task, null, 2).split("\n")[1],
		);
	});
	it("keeps semantic priority, round glyphs and loaded counts honest without color", () => {
		expect([3, 2, 1, 0].map((value) => priorityLabel(value, "en"))).toEqual([
			"High",
			"Medium",
			"Low",
			"None",
		]);
		expect(taskRow(entry, { ...context, columns: 40, ascii: true }).text).toBe(
			"( ) !!! Milk",
		);
		expect(
			taskRow(
				{ ...entry, data: { ...entry.data, done: true } },
				{ ...context, ascii: true },
			).text,
		).toBe("(x) High   Milk");
		expect(
			loadedTaskCounts(
				[
					entry,
					{ ...entry, data: { ...entry.data, done: true } },
					{ id: "list", label: "List", data: { name: "List" } },
				],
				context,
			),
		).toEqual({ loaded: 2, open: 1, done: 1, overdue: 0 });
	});
	it.each([
		{ cascade: false, count: 0 },
		{ cascade: true, count: 0 },
		{ cascade: true, count: 2 },
	])("shows the captured deletion choice and observed child count: %o", ({
		cascade,
		count,
	}) => {
		const body = Object.freeze({
			listId: "list",
			expectedState: "a".repeat(64),
			expectedChildrenState: Object.freeze({
				version: 1 as const,
				count,
				token: "b".repeat(64),
			}),
			cascadeChildren: cascade,
		});
		const review: Review = {
			kind: "delete",
			taskId: "task",
			title: "Milk",
			requestId: "request",
			uncertain: false,
			body,
		};
		const summary = reviewDetails(review, context, false).join("\n");
		expect(summary).toContain(
			cascade
				? "Delete the task and all observed children"
				: "Delete only when there are no children",
		);
		expect(summary).toContain(`Observed child count: ${count}`);
		expect(summary).toContain("cannot be undone");
		expect(reviewPayload(review).body).toBe(body);
		expect(
			reviewParts(review, context, true).map((line) =>
				line.map((part) => part.text).join(""),
			),
		).toEqual(reviewDetails(review, context, true));
		expect(reviewParts(review, context, true).flat()).toContainEqual({
			text: '"request"',
			tone: "success",
		});
		expect(review.requestId).toBe("request");
	});
	it.each([
		40, 60, 100,
	])("aligns all priority titles at %s columns in all six locales", (columns) => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as Locale[]) {
			const rows = [3, 2, 1, 0].map((priority) =>
				taskRow(
					{ ...entry, data: { ...entry.data, priority } },
					{ ...context, columns, locale },
				),
			);
			const frame = renderFrame(
				{
					title: "Tasks",
					status: "Ready",
					footer: "",
					rows: rows.map((row) => row.text),
					rowParts: rows.map((row) => row.parts),
					selected: 0,
					framed: true,
				},
				columns,
				15,
			);
			const prefixes = frame
				.split("\n")
				.filter((line) => line.includes("Milk"))
				.map((line) => visibleCells(line.slice(0, line.indexOf("Milk"))));
			expect(prefixes).toHaveLength(4);
			expect(new Set(prefixes).size).toBe(1);

			expect(rows.map((row) => row.parts.at(-1)?.text)).toEqual([
				"Milk",
				"Milk",
				"Milk",
				"Milk",
			]);
		}
	});

	it("summarizes only the immutable patch, preserving omission and explicit null", () => {
		const body = Object.freeze({
			listId: "list",
			expectedState: "a".repeat(64),
			patch: Object.freeze({ notes: null, priority: 2 }),
		});
		const review: Review = {
			kind: "update",
			taskId: "task",
			title: "Milk",
			requestId: "request",
			uncertain: true,
			body,
		};
		const summary = reviewDetails(review, context, false).join("\n");
		expect(summary).toContain("Notes: None");
		expect(summary).toContain("Priority: Medium");
		expect(summary).not.toContain("Priority: Medium (2)");
		expect(summary).not.toContain("Due:");
		expect(summary).toContain("PATCH /api/v1/tasks/task");
		expect(summary).toContain("unconfirmed");
		expect(reviewPayload(review).body).toBe(body);
		expect(
			reviewParts(review, context, true).map((line) =>
				line.map((part) => part.text).join(""),
			),
		).toEqual(reviewDetails(review, context, true));
		expect(reviewParts(review, context, true).flat()).toContainEqual({
			text: '"request"',
			tone: "success",
		});
		expect(review.requestId).toBe("request");
		expect(
			JSON.parse(reviewDetails(review, context, true).slice(3).join("\n")).body,
		).toEqual(body);
	});
});
