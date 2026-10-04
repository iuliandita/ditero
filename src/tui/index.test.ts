import { describe, expect, it } from "vitest";
import type { TerminalState } from "./controller.ts";
import {
	footerHints,
	listHeader,
	parseTerminalArguments,
	terminalStatusLine,
} from "./index.ts";
import { fitHints, renderFrame } from "./render.ts";

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
			["invalid_input", "invalid_input"],
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
