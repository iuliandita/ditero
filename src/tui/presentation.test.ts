import { describe, expect, it } from "vitest";
import type { Locale } from "../domain/locale.ts";
import * as m from "../paraglide/messages.js";
import type { Entry } from "./api.ts";
import type { Review } from "./controller.ts";
import { type OrderingPlan, proposeOrdering } from "./ordering.ts";
import {
	entryDetails,
	exactPayloadLines,
	exactPayloadParts,
	helpDetails,
	loadedTaskCounts,
	orderDetails,
	priorityLabel,
	reviewDetails,
	reviewParts,
	reviewPayload,
	taskRow,
} from "./presentation.ts";
import {
	renderFrame,
	safeText,
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
		{ columns: 40, color: false },
		{ columns: 60, color: false },
		{ columns: 100, color: false },
		{ columns: 100, color: true },
	])("keeps nested exact JSON indentation and structure at $columns columns (color $color)", ({
		columns,
		color,
	}) => {
		const payload = {
			a: { b: ["x  y‮ ", { c: null }], d: 1 },
			k: "p q",
		};
		const expected = exactPayloadLines(payload);
		expect(expected).toContain('      "x\\u0020\\u0020y\\u202e\\u00a0",');
		const wrapped = wrapParts(exactPayloadParts(payload), columns - 5);
		expect(wrapped).toHaveLength(expected.length);
		expect(
			wrapped.map((line) => line.map((part) => part.text).join("")),
		).toEqual(expected);
		const output = renderFrame(
			{
				title: "JSON",
				status: "Ready",
				footer: "",
				rows: [],
				selected: 0,
				detailParts: wrapped,
				framed: true,
				color,
			},
			columns,
			40,
		);
		const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
		const text = output.replace(sgr, "");
		const unsafe =
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserts no terminal controls survive
			/[\u0000-\u0009\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;
		expect(text).not.toMatch(unsafe);
		if (!color) expect(output).not.toContain(String.fromCharCode(27));
		// Framed output (80+ columns) has a border row and "│ " / " │" sides.
		const framed = columns >= 80;
		const rendered = text
			.split("\n")
			.slice(framed ? 3 : 2, (framed ? 3 : 2) + expected.length)
			.map((line) => (framed ? line.slice(2, -2) : line).trimEnd());
		expect(rendered).toEqual(expected.map((line) => line.trimEnd()));
		expect(JSON.parse(rendered.join("\n"))).toEqual(payload);
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
		).toBe(exactPayloadLines(payload).join(""));
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
			expect(topics.filter((line) => line === "")).toHaveLength(7);
			expect(topics).toContain(m.tui_help_order({}, { locale }));
			expect(topics.join(" ")).not.toContain("undefined");
			const wrapped = wrapWords(topics, 39);
			expect(wrapped.filter((line) => line === "")).toHaveLength(7);
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

// Manual order: ID order and key order deliberately disagree.
const siblings = [
	{ id: "id-9", title: "Zulu", sortKey: "a0", done: false },
	{ id: "id-1", title: "Alpha", sortKey: "a1", done: true },
	{ id: "id-5", title: "Mike", sortKey: "a2", done: false },
] as const;
const orderPlan: OrderingPlan = {
	taskId: "id-5",
	title: "Mike",
	workspaceId: "workspace",
	listId: "list",
	parentId: null,
	parentTitle: null,
	siblings,
	index: 2,
	childCount: 0,
	placementToken: "c".repeat(64),
	listToken: "d".repeat(64),
};
const controls = new RegExp(
	`[${String.fromCharCode(27, 155, 8238, 8294)}]`,
	"u",
);

describe("terminal task ordering presentation", () => {
	it("lists siblings by manual key, not ID, with done rows and the selected marker", () => {
		const lines = orderDetails(orderPlan, "", context);
		const rows = lines.filter((line) => /^[> ] \d+\. /u.test(line));
		expect(rows).toEqual(["  1. ○ Zulu", "  2. ● Alpha", "> 3. ○ Mike"]);
		expect(lines.slice(0, 3)).toEqual([
			"Type a position from 1 to 3, then press Enter.",
			"> ",
			"",
		]);
		expect(lines[3]).toBe(
			m.tui_order_title({ title: "Mike" }, { locale: "en" }),
		);
		expect(lines).toContain(m.tui_order_group_root({}, { locale: "en" }));
		expect(lines).toContain(
			m.tui_order_current({ position: "3", total: "3" }, { locale: "en" }),
		);
		expect(lines).toContain(m.tui_order_browse_note({}, { locale: "en" }));
		expect(lines).toContain(m.tui_order_readonly({}, { locale: "en" }));
		expect(lines).toContain(
			m.tui_order_position_prompt({ total: "3" }, { locale: "en" }),
		);
		expect(lines[1]).toBe("> ");
		expect(orderDetails(orderPlan, "12", context)[1]).toBe("> 12");
		expect(
			orderDetails(orderPlan, "", { ...context, ascii: true }).filter((line) =>
				/^[> ] \d+\. /u.test(line),
			),
		).toEqual(["  1. ( ) Zulu", "  2. (x) Alpha", "> 3. ( ) Mike"]);
	});
	it.each([
		["", "> "],
		["12", "> 12"],
	])("shows the position prompt and %j echo in the first 40x20 frame with 105 siblings", (typed, echo) => {
		const many = Array.from({ length: 105 }, (_, index) => ({
			id: `id-${index + 1}`,
			title: `Task ${index + 1}`,
			sortKey: `a${String(index).padStart(3, "0")}`,
			done: false,
		}));
		const plan: OrderingPlan = { ...orderPlan, siblings: many, index: 99 };
		const details = orderDetails(plan, typed, context);
		expect(details).toContain("Group: top-level tasks");
		expect(details).toContain(
			"Now at position 100 of 105. Completed tasks count.",
		);
		expect(details).toContain(
			"Rows are in manual order. Browse lists stay in ID order.",
		);
		const frame = renderFrame(
			{
				title: "Order",
				status: "Ready",
				footer: "",
				rows: [],
				selected: 0,
				framed: true,
				detail: wrapLines(details, 39),
				detailScrollHint: ["Scroll", "Up/Down"],
				detailOffset: 0,
			},
			40,
			20,
		).split("\n");
		const prompt = frame.findIndex((line) =>
			line.includes("Type a position from 1 to 105"),
		);
		const field = frame.findIndex((line) => line.trimEnd() === echo.trimEnd());
		expect(prompt).toBeGreaterThanOrEqual(0);
		expect(field).toBeGreaterThan(prompt);
		// Title, context, then the first detail rows: the field is in the top 6.
		expect(field).toBeLessThan(6);
	});
	it("names the subtask parent group and the untouched children, only when they exist", () => {
		const root = orderDetails(orderPlan, "", context).join("\n");
		expect(root).not.toContain(
			m.tui_order_children_stay({ count: 0 }, { locale: "en" }),
		);
		const nested: OrderingPlan = {
			...orderPlan,
			parentId: "parent-id",
			parentTitle: "Weekly\u001b[2J plan‮",
			childCount: 2,
		};
		const lines = orderDetails(nested, "", context);
		expect(lines).toContain(
			m.tui_order_group_subtasks(
				{ parent: safeText("Weekly\u001b[2J plan‮") },
				{ locale: "en" },
			),
		);
		expect(lines).toContain(
			m.tui_order_children_stay({ count: 2 }, { locale: "en" }),
		);
		expect(lines.join("\n")).not.toMatch(controls);
		expect(
			orderDetails({ ...nested, parentTitle: null }, "", context),
		).toContain(
			m.tui_order_group_subtasks({ parent: "parent-id" }, { locale: "en" }),
		);
	});
	it("renders hostile titles and IDs without terminal controls", () => {
		const hostile: OrderingPlan = {
			...orderPlan,
			title: "Mike\u001b[2J‮",
			siblings: [
				{
					id: "id\u009b9",
					title: "Zu\u001b[31mlu⁦",
					sortKey: "a0",
					done: false,
				},
				{ id: "id-5", title: "Mike\u001b[2J‮", sortKey: "a2", done: false },
			],
			index: 1,
		};
		expect(orderDetails(hostile, "", context).join("\n")).not.toMatch(controls);
		const proposal = proposeOrdering(hostile, 1);
		const review: Review = {
			kind: "place",
			taskId: "id-5",
			title: "Mike",
			body: proposal.body,
			order: proposal.order,
			requestId: "request",
			uncertain: false,
		};
		const summary = reviewDetails(review, context, false);
		expect(summary.join("\n")).not.toMatch(controls);
		expect(summary).toContain(
			m.tui_order_before(
				{ task: `${safeText("Zu\u001b[31mlu⁦")} (${safeText("id\u009b9")})` },
				{ locale: "en" },
			),
		);
	});
	const proposal = proposeOrdering(orderPlan, 1);
	const placeReview = (
		extra: Partial<Extract<Review, { kind: "place" }>> = {},
	): Review => ({
		kind: "place",
		taskId: "id-5",
		title: "Mike",
		body: proposal.body,
		order: proposal.order,
		requestId: "request",
		uncertain: false,
		...extra,
	});
	it("summarizes the frozen move, neighbors, key and non-atomic caveat", () => {
		const lines = reviewDetails(placeReview(), context, false);
		const en = { locale: "en" as const };
		expect(lines).toContain(
			m.tui_order_move({ from: "3", to: "1", total: "3" }, en),
		);
		expect(lines).toContain(m.tui_order_start({}, en));
		expect(lines).toContain(m.tui_order_before({ task: "Zulu (id-9)" }, en));
		expect(lines).toContain(m.tui_order_key({ key: proposal.order.key }, en));
		expect(lines).toContain(m.tui_order_not_atomic({}, en));
		expect(lines).not.toContain(m.tui_order_children_stay({ count: 0 }, en));
		expect(lines).toContain("PATCH /api/v1/tasks/id-5/placement");
		const middle = proposeOrdering(orderPlan, 2);
		const end = proposeOrdering({ ...orderPlan, index: 0 }, 3);
		const children = {
			...placeReview({ order: { ...proposal.order, childCount: 2 } }),
		};
		expect(reviewDetails(children, context, false)).toContain(
			m.tui_order_children_stay({ count: 2 }, en),
		);
		expect(
			reviewDetails(placeReview({ order: middle.order }), context, false),
		).toContain(m.tui_order_after({ task: "Zulu (id-9)" }, en));
		expect(
			reviewDetails(placeReview({ order: end.order }), context, false),
		).toContain(m.tui_order_end({}, en));
		const caveat = reviewParts(placeReview(), context)
			.flat()
			.find((part) => part.text === m.tui_order_not_atomic({}, en));
		expect(caveat?.tone).toBe("warning");
	});
	it("sends and shows exactly one placement PATCH payload with the encoded task ID", () => {
		const review = placeReview({ taskId: "id/5 x" });
		const payload = reviewPayload(review);
		expect(payload).toEqual({
			requestId: "request",
			endpoint: "/api/v1/tasks/id%2F5%20x/placement",
			method: "PATCH",
			body: proposal.body,
		});
		expect(payload.body).toBe(proposal.body);
		expect(proposal.body).toEqual({
			workspaceId: "workspace",
			listId: "list",
			expectedState: "c".repeat(64),
			targetListId: "list",
			expectedTargetState: "d".repeat(64),
			sortKey: proposal.order.key,
			cascadeChildren: false,
			expectedChildrenState: null,
		});
		const exact = reviewDetails(review, context, true);
		expect(exact[1]).toBe("PATCH /api/v1/tasks/id%2F5%20x/placement");
		expect(JSON.parse(exact.slice(2).join("\n"))).toEqual(payload);
		expect(
			reviewParts(review, context, true).map((line) =>
				line.map((part) => part.text).join(""),
			),
		).toEqual(exact);
	});
	it.each([
		"en",
		"de",
		"es",
		"fr",
		"ro",
		"ar",
	] as Locale[])("has no missing order text or unfilled parameters in %s", (locale) => {
		const current = { ...context, locale };
		const text = [
			...orderDetails({ ...orderPlan, childCount: 2 }, "2", current),
			...reviewDetails(placeReview(), current, false),
		].join("\n");
		expect(text).not.toContain("undefined");
		expect(text).not.toMatch(/\{[A-Za-z]+\}/u);
		expect(text).toContain(m.tui_order_not_atomic({}, { locale }));
	});
});
