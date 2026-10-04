import { describe, expect, it } from "vitest";
import type { TerminalState } from "./controller.ts";
import {
	detailScrollHints,
	footerHints,
	helpFooter,
	listHeader,
	parseTerminalArguments,
	terminalStatusLine,
} from "./index.ts";
import { fitHints, renderFrame, wrapLines } from "./render.ts";

const env = {
	DITERO_URL: "https://example.com",
	DITERO_TOKEN: `ditero_pat_${"a".repeat(43)}`,
};
describe("terminal presentation options", () => {
	it("supports NO_COLOR including an empty value and the explicit flag", () => {
		expect(parseTerminalArguments([], env)?.color).toBe(true);
		expect(parseTerminalArguments([], { ...env, NO_COLOR: "" })?.color).toBe(
			false,
		);
		expect(
			parseTerminalArguments(["--no-color", "--locale", "ar"], env),
		).toMatchObject({ color: false, locale: "ar" });
	});
	it("uses portable glyphs only when explicitly requested", () => {
		expect(parseTerminalArguments([], env)?.ascii).toBe(false);
		expect(
			parseTerminalArguments(["--ascii", "--no-color"], env),
		).toMatchObject({ ascii: true, color: false });
	});
	it.each([
		40, 60, 100,
	])("keeps the captured immutable list identity within %s columns", (columns) => {
		const id = "c6760000-0000-4000-8000-000000000001";
		const header = listHeader("Weekly plan - demo", id, columns - 1);
		expect(header).toContain(id);
		expect(header.length).toBeLessThanOrEqual(columns - 1);
		if (columns >= 60) expect(header).toContain("Weekly plan - demo");
		expect(listHeader(undefined, id, columns - 1)).toBe(id);
	});

	it("keeps whole delete hints and omits cancellation for uncertain writes", () => {
		const hints = footerHints(
			"q quit | ? help | e edit | d delete",
			"en",
			false,
			false,
			false,
		);
		expect(fitHints(hints, 35)).toContain("d delete");
		expect(
			fitHints(hints, 31)
				.split(" | ")
				.every((hint) => hints.includes(hint)),
		).toBe(true);
		expect(fitHints(hints, 31)).not.toContain("d delete");
		expect(fitHints(hints, 31)).toContain("q quit");
		expect(fitHints(hints, 31)).toContain("? help");
		const tasks = footerHints(
			"q quit | Enter open | Esc back | ? help | r refresh | p next page | n add | c complete | e edit | d delete",
			"en",
			false,
			false,
			false,
		);
		expect(fitHints(tasks, 59)).toBe(
			"Esc back | q quit | Enter open | c complete | ? help",
		);

		expect(tasks.indexOf("c complete")).toBeLessThan(tasks.indexOf("n add"));
		expect(tasks.indexOf("c complete")).toBeLessThan(tasks.indexOf("e edit"));
		expect(fitHints(tasks, 39)).toBe("Esc back | q quit | Enter open | ? help");
		const review = footerHints(
			"q quit | r retry same request | Esc cancel",
			"en",
			true,
			false,
			true,
		);
		expect(review).not.toContain("Esc cancel");
		expect(review).toContain("v exact payload");
	});
});

describe("terminal rendered status", () => {
	const state: TerminalState = {
		location: { resource: "tasks", listId: "list" },
		entries: [],
		selected: 0,
		status: "ready",
		error: null,
		nextCursor: null,
		detail: null,
		detailOffset: 0,
		help: false,
		payload: false,
		page: 1,
		breadcrumb: [],
		authorityRefused: false,
		form: null,
		deletion: null,
		review: null,
	};
	const count = { loaded: 0, open: 0, done: 0, overdue: 0 };
	it.each([
		"ready",
		"empty",
	] as const)("keeps validation errors ahead of counts in %s", (status) => {
		for (const [error, expected] of [
			["no_changes", "No fields changed. Edit a value or press Esc to cancel."],
			["invalid_input", "Invalid value. Edit and press Enter."],
		]) {
			const statusLine = terminalStatusLine(
				{ ...state, status, error },
				"Ready",
				"en",
				100,
				count,
			);
			const output = renderFrame(
				{
					title: "Edit",
					status: "Ready",
					statusLine,
					footer: "",
					rows: [],
					selected: 0,
					framed: true,
				},
				100,
				15,
			);
			expect(output).toContain(expected);
			expect(output).not.toContain("Loaded:");
		}
	});
	it("gives invalid priority a local correction while retaining transport failure advice", () => {
		const form: NonNullable<TerminalState["form"]> = {
			kind: "update",
			field: "priority",
			title: "Milk",
			notes: "",
			due: "",
			allDay: false,
			priority: "9",
			dirty: { priority: true },
			observation: {
				stateToken: "a".repeat(64),
				snapshot: {
					version: 1,
					taskId: "task",
					listId: "list",
					workspaceId: "workspace",
					title: "Milk",
					notes: null,
					dueAt: null,
					dueAllDay: false,
					priority: 0,
					createdAt: "2026-10-04T12:00:00Z",
					done: false,
					completedAt: null,
					listKind: "tasks",
					rrule: null,
					recurrenceRelative: false,
					recurrenceAnchorAt: null,
					recurrenceConsumed: null,
				},
			},
		};
		const statusLine = terminalStatusLine(
			{ ...state, error: "invalid_input", form },
			"Ready",
			"en",
			40,
			count,
		);
		expect(statusLine).toBe("Priority: use 0, 1, 2 or 3.");
		const output = renderFrame(
			{
				title: "Priority",
				status: "Ready",
				statusLine,
				footer: "",
				rows: [],
				selected: 0,
				framed: true,
			},
			40,
			12,
		);
		expect(output).toContain("Priority: use 0, 1, 2 or 3.");
		expect(output).not.toContain("connection");
		const invalidDue = {
			...form,
			due: "invalid date",
			priority: "0",
			dirty: { due: true as const },
		};
		expect(
			terminalStatusLine(
				{ ...state, error: "invalid_input", form: invalidDue },
				"Ready",
				"en",
				40,
				count,
			),
		).toBe("Invalid value. Edit and press Enter.");
		const invalidAllDay = {
			...form,
			due: "",
			allDay: true,
			priority: "0",
			dirty: { allDay: true as const },
		};
		expect(
			terminalStatusLine(
				{ ...state, error: "invalid_input", form: invalidAllDay },
				"Ready",
				"en",
				40,
				count,
			),
		).toBe("Invalid value. Edit and press Enter.");
		expect(
			terminalStatusLine(
				{ ...state, error: "request_failed", form },
				"Ready",
				"en",
				100,
				count,
			),
		).toBe(
			"Request failed (request_failed). Check access and connection before retrying.",
		);
	});
	it("keeps Esc back in localized help footers, including help over an uncertain review", () => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"] as const) {
			const hints = footerHints(
				helpFooter(locale),
				locale,
				false,
				false,
				false,
			);
			expect(fitHints(hints, 39)).toContain("Esc");
			expect(fitHints(hints, 39)).toContain("q");
			expect(fitHints(hints, 39)).toContain("?");
			expect(hints.some((hint) => hint.startsWith("y "))).toBe(false);
			expect(hints.some((hint) => hint.startsWith("r "))).toBe(false);
		}
	});

	it("does not advertise scrolling for a long create form while retaining clipped review guidance", () => {
		const title = Array.from({ length: 70 }, (_, index) => `word${index}`).join(
			" ",
		);
		const create: TerminalState = {
			...state,
			form: {
				kind: "create",
				target: { kind: "list", selector: { id: "list" }, personal: false },
				title,
				due: "",
				field: "title",
			},
		};
		const detail = wrapLines(["Task title", title, "Due day", ""], 39);
		const frame = {
			title: "Create",
			status: "Ready",
			footer: "",
			rows: [],
			selected: 0,
			framed: true,
			detail,
		};
		const creating = renderFrame(
			{ ...frame, detailScrollHint: detailScrollHints(create, "en") },
			40,
			13,
		);
		expect(creating).not.toContain("Up/Down");
		expect(creating).not.toContain("Home/End");
		expect(creating).toContain(detail[8]?.trim());
		const review: TerminalState = {
			...state,
			status: "review",
			review: {
				kind: "complete",
				task: { id: "task", listId: "list", dueAt: null },
				title,
				recurring: false,
				requestId: "request",
				uncertain: false,
			},
		};
		const reviewing = renderFrame(
			{
				...frame,
				statusLine: "NOT SENT",
				detailScrollHint: detailScrollHints(review, "en"),
			},
			40,
			13,
		);
		expect(reviewing).toContain("Up/Down scroll | Home/End jump");
		expect(reviewing).toContain("NOT SENT");
		expect(reviewing).not.toContain(detail[8]?.trim());
		expect(detailScrollHints({ ...state, help: true }, "en")).toBeDefined();
		expect(
			detailScrollHints(
				{ ...state, detail: { id: "task", label: "Milk", data: {} } },
				"en",
			),
		).toBeDefined();
		expect(detailScrollHints(state, "en")).toBeUndefined();
	});

	it("retains UNCONFIRMED with a transport error and otherwise shows NOT SENT", () => {
		const review = {
			kind: "complete" as const,
			task: { id: "task", listId: "list", dueAt: null },
			title: "Milk",
			recurring: false,
			requestId: "request",
			uncertain: true,
		};
		const statusLine = terminalStatusLine(
			{ ...state, status: "error", error: "request_failed", review },
			"Error",
			"en",
			100,
			count,
		);
		const output = renderFrame(
			{
				title: "Review",
				status: "Error",
				statusLine,
				footer: "",
				rows: [],
				selected: 0,
				framed: true,
			},
			100,
			15,
		);
		expect(output).toContain("UNCONFIRMED");
		expect(output).not.toContain("request_failed");
		expect(
			terminalStatusLine(
				{ ...state, status: "review", review: { ...review, uncertain: false } },
				"Ready",
				"en",
				100,
				count,
			),
		).toBe("NOT SENT");
		expect(terminalStatusLine(state, "Ready", "en", 100, count)).toContain(
			"Loaded:",
		);
	});
});
