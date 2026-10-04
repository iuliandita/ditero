import { describe, expect, it } from "vitest";
import {
	type Frame,
	fitHints,
	fitLine,
	renderFrame,
	safeText,
	visibleCells,
	wrapParts,
	wrapWords,
} from "./render.ts";

describe("terminal frames", () => {
	it("adds only trusted SGR after layout, preserving monochrome text and widths", () => {
		const frame = {
			title: "Ditero",
			status: "Online",
			footer: "",
			rows: ["Milk\u001b[2J猫"],
			rowMetadata: ["P3 | Due: tomorrow"],
			rowTones: ["danger" as const],
			selected: 0,
			footerHints: ["q quit", "? help", "d delete"],
		};
		const plain = renderFrame(frame, 28, 8);
		const colored = renderFrame({ ...frame, color: true }, 28, 8);
		const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
		expect(colored.replace(sgr, "")).toBe(plain);
		expect(colored).toContain("\u001b[31;7m> Milk");
		expect(colored).not.toContain("\u001b[2J");
		expect(colored.replace(sgr, "")).not.toContain("\u001b");
		for (const line of plain.split("\n")) expect(fitLine(line, 27)).toBe(line);
		expect(plain).toContain("P3 | Due: tomorrow");
	});
	it("fits whole localized hints and keeps exit on a narrow viewport", () => {
		expect(fitHints(["q quit", "? help", "d delete"], 21)).toBe(
			"q quit | ? help",
		);
		expect(fitHints(["q quit", "? help", "d delete"], 26)).toBe(
			"q quit | ? help | d delete",
		);
		expect(
			fitHints(
				["q quit", "y confirm/retry", "Esc cancel before sending", "? help"],
				20,
			),
		).toBe("q | y | Esc | ?");
		expect(
			renderFrame(
				{
					title: "",
					status: "Online",
					footer: "",
					footerHints: ["q quit", "? help"],
					rows: [],
					selected: 0,
				},
				10,
				2,
			),
		).toBe("q | ?");
	});
	it("neutralizes server terminal commands and direction controls", () => {
		const hostile = "task\u001b[2J\u009b31m\r\n\u202ehidden\u2066";
		expect(safeText(hostile)).toBe("task [2J 31m hidden ");
		expect(
			renderFrame(
				{
					title: hostile,
					status: "",
					footer: "",
					rows: [hostile],
					selected: 0,
				},
				80,
				8,
			),
		).toBeDefined();
		for (const character of ["\u001b", "\u009b", "\u202e", "\u2066"])
			expect(safeText(hostile)).not.toContain(character);
	});
	it("clips complete graphemes to terminal cells", () => {
		expect(fitLine("猫🙂e\u0301x", 5)).toBe("猫🙂e\u0301");
		expect(fitLine("🙂x", 1)).toBe("");
		expect(fitLine("abc", 0)).toBe("");
	});
	it("keeps selection visible and reserves a nonwrapping footer", () => {
		const frame = renderFrame(
			{
				title: "Tasks",
				status: "Ready",
				footer: "Quit",
				rows: Array.from({ length: 100 }, (_, i) => `Task ${i}`),
				selected: 99,
			},
			25,
			7,
		);
		expect(frame.split("\n")).toHaveLength(7);
		expect(frame).toContain("> Task 99");
		expect(frame).not.toContain("Task 0");
		expect(frame.split("\n").at(-1)).toBe("Quit");
	});
	it.each([
		40, 60, 100,
	])("frames a %s-column viewport without overflow or losing safety keys", (columns) => {
		const frame: Frame = {
			title: "Ditero Tasks",
			status: "Ready",
			statusLine: "Loaded: 2",
			context: "Demo / Shopping",
			viewportTitle: "Tasks",
			footer: "",
			footerHints: ["y send", "Esc cancel", "q quit", "? help", "d delete"],
			rows: ["Milk", "Bread"],
			rowParts: [
				[
					{ text: "○ ", tone: "plain" },
					{ text: "High ", tone: "danger" },
					{ text: "Milk", tone: "plain" },
				],
				[{ text: "○ Bread", tone: "plain" }],
			],
			rowMetadataParts: [
				[
					{ text: "Due: tomorrow", tone: "info" },
					{ text: "Repeat", tone: "recurring" },
				],
				[{ text: "2 L", tone: "plain" }],
			],
			selected: 0,
			framed: true,
		};
		const plain = renderFrame(frame, columns, 15);
		const colored = renderFrame({ ...frame, color: true }, columns, 15);
		const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
		expect(colored.replace(sgr, "")).toBe(plain);
		expect(plain.split("\n")).toHaveLength(15);
		for (const line of plain.split("\n"))
			expect(Array.from(line).length).toBeLessThanOrEqual(columns - 1);
		expect(plain.split("\n").at(-1)).toMatch(/y.*Esc.*q.*\?/u);
		expect(colored).toContain("\u001b[36;7;1mHigh ");
		expect(colored).not.toContain("\u001b[31;7m");
	});
	it("uses one row at 100, two at 60, and expands only selection at 40", () => {
		const frame: Frame = {
			title: "Tasks",
			status: "",
			footer: "q quit",
			rows: ["First", "Second"],
			rowMetadata: ["first metadata", "second metadata"],
			selected: 0,
			framed: true,
		};
		const narrow = renderFrame(frame, 40, 16);
		expect(narrow).toContain("first metadata");
		expect(narrow).not.toContain("second metadata");
		const medium = renderFrame(frame, 60, 16);
		expect(medium).toContain("first metadata");
		expect(medium).toContain("second metadata");
		const wide = renderFrame(frame, 100, 16);
		expect(wide.split("\n").find((line) => line.includes("First"))).toContain(
			"first metadata",
		);
	});
	it("limits the FIGlet-style wordmark to the wide start view and preserves its spacing", () => {
		const frame: Frame = {
			title: "Ditero",
			status: "Ready",
			footer: "q quit",
			rows: ["Workspaces"],
			selected: 0,
			framed: true,
			start: true,
			startInfo: ["ditero-tui 0.0.1-alpha.2", "API read (reported)"],
		};
		expect(renderFrame(frame, 100, 30)).toContain(
			"| (_| | | ||  __/ | | (_) |",
		);
		expect(renderFrame({ ...frame, start: false }, 100, 30)).not.toContain(
			"| (_| | | ||  __/ | | (_) |",
		);
		expect(renderFrame(frame, 60, 30)).not.toContain(
			"| (_| | | ||  __/ | | (_) |",
		);
		const ascii = renderFrame({ ...frame, ascii: true }, 100, 30);
		expect(ascii).toContain("| (_| | | ||  __/ | | (_) |");
		expect(ascii).not.toMatch(/[┌┐└┘─│✓]/u);
	});
	it("colors cues rather than unselected titles and drops whole metadata groups", () => {
		const frame: Frame = {
			title: "Tasks",
			status: "Ready",
			footer: "q quit",
			rows: ["Selected", "Normal"],
			rowParts: [
				[{ text: "Selected", tone: "plain" }],
				[
					{ text: "High ", tone: "danger" },
					{ text: "Normal", tone: "plain" },
				],
			],
			rowMetadataParts: [
				[],
				[
					{ text: "Due", tone: "info" },
					{
						text: "very long recurrence text that cannot fit in this terminal",
						tone: "recurring",
					},
				],
			],
			selected: 0,
			framed: true,
			color: true,
		};
		const output = renderFrame(frame, 60, 16);
		expect(output).toContain("\u001b[31mHigh \u001b[0mNormal");
		expect(output).not.toContain("\u001b[31mNormal");
		expect(output).not.toContain(" · ");
	});
	it("keeps selection primary, semantic cues bold and completed titles dim", () => {
		const frame: Frame = {
			title: "Tasks",
			status: "NOT SENT",
			statusTone: "warning",
			footer: "",
			footerHints: ["y send", "Esc cancel", "? help"],
			rows: ["Milk", "Done"],
			selected: 0,
			framed: true,
			rowParts: [
				[
					{ text: "High", tone: "danger", fieldWidth: 7 },
					{ text: "Milk", tone: "plain" },
				],
				[{ text: "Done", tone: "plain", dim: true }],
			],
			rowMetadataParts: [[{ text: "Overdue", tone: "danger" }], []],
		};
		const output = renderFrame({ ...frame, color: true }, 60, 12);
		expect(output).toContain("\u001b[36;7;1mHigh   ");
		expect(output).toContain("\u001b[36;7;1mOverdue");
		expect(output).toContain("\u001b[2mDone");
		expect(output).toContain("\u001b[33;1mNOT SENT");
		expect(output).toContain("\u001b[36;1my\u001b[0m\u001b[2m send");
		expect(output.split("\n")[0]).not.toContain(";7m");
		expect(
			output.replace(
				new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
				"",
			),
		).toBe(renderFrame(frame, 60, 12));
	});
	it("places multihue static art beside sanitized key/value data", () => {
		const frame: Frame = {
			title: "Ditero",
			status: "Ready",
			footer: "",
			rows: ["Workspaces"],
			selected: 0,
			framed: true,
			start: true,
			startInfo: [
				"ditero-tui 0.0.1-alpha.2",
				"API read (reported)",
				"Locale: en",
			],
		};
		const output = renderFrame({ ...frame, color: true }, 110, 30);
		const plain = output.replace(
			new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
			"",
		);
		expect(plain.split("\n").find((line) => line.includes("_ _ _"))).toContain(
			"ditero-tui 0.0.1-alpha.2",
		);
		expect(plain.split("\n").find((line) => line.includes("__|"))).toContain(
			"API read (reported)",
		);
		for (const color of [36, 34, 35, 33, 32])
			expect(output).toContain(`\u001b[${color};1m`);
		expect(output).toContain("\u001b[36;1mLocale:");
	});

	it("aligns narrow metadata under its title and dims only lower-priority cues", () => {
		const frame: Frame = {
			title: "Tasks",
			status: "Ready",
			footer: "",
			rows: ["Milk"],
			selected: 1,
			framed: true,
			rowParts: [
				[
					{ text: "○ ", tone: "plain" },
					{ text: "!!!", tone: "danger", fieldWidth: 4 },
					{ text: "Milk", tone: "plain" },
				],
			],
			rowMetadataParts: [[{ text: "Repeat", tone: "recurring" }]],
		};
		const plain = renderFrame(frame, 60, 15);
		const lines = plain.split("\n");
		const title = lines.find((line) => line.includes("Milk"));
		const meta = lines.find((line) => line.includes("Repeat"));
		if (!title || !meta || !frame.rowParts || !frame.rowMetadataParts)
			throw new Error(
				"Expected task title, metadata, and structured row parts",
			);
		expect(meta.indexOf("Repeat")).toBe(title.indexOf("Milk"));
		const colored = renderFrame(
			{
				...frame,
				rows: ["Other", "Milk"],
				rowParts: [[{ text: "Other", tone: "plain" }], ...frame.rowParts],
				rowMetadataParts: [[], ...frame.rowMetadataParts],
				selected: 0,
				color: true,
			},
			60,
			15,
		);
		expect(colored).toContain("\u001b[35;2mRepeat");
	});
	it("uses a continuous top border when its title is intentionally omitted", () => {
		const output = renderFrame(
			{
				title: "Ditero",
				viewportTitle: "",
				status: "Ready",
				footer: "",
				rows: [],
				selected: 0,
				framed: true,
			},
			100,
			12,
		);
		expect(output.split("\n")[2]).toMatch(/^┌─+┐$/u);
	});
	it("wraps styled human review without exposing hostile controls or changing text", () => {
		const input = [
			[
				{ text: "Title: ", tone: "brand" as const, bold: true },
				{ text: "猫🙂 é Milk\u001b[2J", tone: "plain" as const },
			],
			[{ text: "Request ID: request", tone: "plain" as const, dim: true }],
		];
		const lines = wrapParts(input, 12);
		for (const parts of lines)
			expect(
				visibleCells(parts.map((part) => part.text).join("")),
			).toBeLessThanOrEqual(12);
		const frame: Frame = {
			title: "Review",
			status: "NOT SENT",
			footer: "",
			rows: [],
			selected: 0,
			detailParts: lines,
			framed: true,
		};
		const colored = renderFrame({ ...frame, color: true }, 40, 15);
		expect(colored).toContain("\u001b[36;1mTitle:");
		expect(colored).toContain("\u001b[2mRequest ID:");
		expect(colored).not.toContain("\u001b[2J");
		expect(
			colored.replace(
				new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
				"",
			),
		).toBe(renderFrame(frame, 40, 15));
	});

	it.each([
		40, 60, 100,
	])("reserves a scroll cue for clipped detail and every scrolled offset at %s columns", (columns) => {
		const detail = Array.from(
			{ length: 25 },
			(_, index) => `Payload line ${index}`,
		);
		const frame: Frame = {
			title: "Review",
			status: "NOT SENT",
			statusLine: "NOT SENT",
			footer: "",
			rows: [],
			selected: 0,
			framed: true,
			detail,
			detailScrollHint: [
				"Up/Down scroll through the payload | Home/End jump to its ends",
				"Up/Down | Home/End",
			],
		};
		const top = renderFrame(frame, columns, 13);
		expect(top).toContain("Up/Down");
		expect(top).toContain("Home/End");
		expect(top).toContain("Payload line 0");
		expect(top).not.toContain("Payload line 24");
		expect(top).toContain("NOT SENT");
		const end = renderFrame(
			{
				...frame,
				detail: detail.slice(-1),
				detailOffset: 24,
				statusLine: "UNCONFIRMED",
			},
			columns,
			13,
		);
		expect(end).toContain("Payload line 24");
		expect(end).toContain("Up/Down");
		expect(end).toContain("UNCONFIRMED");
		expect(
			renderFrame({ ...frame, detail: ["Fits"] }, columns, 13),
		).not.toContain("Up/Down");
		expect(top.split("\n")).toHaveLength(13);
		for (const line of top.split("\n"))
			expect(visibleCells(line)).toBeLessThan(columns);
	});
	it("keeps styled payload parts unchanged and the cue separate from payload bytes", () => {
		const detailParts = Array.from({ length: 20 }, (_, index) => [
			{ text: `"key${index}": "value"`, tone: "brand" as const },
		]);
		const before = JSON.stringify(detailParts);
		const frame: Frame = {
			title: "JSON",
			status: "Error",
			statusLine: "Priority: use 0, 1, 2 or 3.",
			footer: "",
			rows: [],
			selected: 0,
			framed: true,
			detailParts,
			detailScrollHint: [
				"Up/Down scroll | Home/End jump",
				"Up/Down | Home/End",
			],
		};
		const plain = renderFrame(frame, 40, 12);
		const colored = renderFrame({ ...frame, color: true }, 40, 12);
		expect(
			colored.replace(
				new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu"),
				"",
			),
		).toBe(plain);
		expect(plain).toContain("Up/Down scroll | Home/End jump");
		expect(plain).toContain("Priority: use 0, 1, 2 or 3.");
		expect(JSON.stringify(detailParts)).toBe(before);
	});
	it("wraps help at word boundaries with blank topics and bounded overlong Unicode words", () => {
		expect(
			wrapWords(["Use arrows and Enter to browse.", "", "Esc returns."], 16),
		).toEqual(["Use arrows and", "Enter to browse.", "", "Esc returns."]);
		const word = "猫🙂e\u0301".repeat(12);
		const wrapped = wrapWords([word], 7);
		expect(wrapped.join("")).toBe(word);
		for (const line of wrapped)
			expect(visibleCells(line)).toBeLessThanOrEqual(7);
		expect(wrapWords(["Hostile\u001b[2J text"], 20).join(" ")).not.toContain(
			String.fromCharCode(27),
		);
	});

	it("remains bounded on tiny and malformed viewport sizes", () => {
		const frame = {
			title: "Tasks",
			status: "Resize terminal",
			footer: "Quit",
			rows: ["one"],
			selected: 0,
		};
		expect(renderFrame(frame, 10, 2)).toBe("Resize te");
		expect(renderFrame(frame, 0, 0)).toBe("");
		expect(renderFrame(frame, 80, 8)).not.toContain("undefined");
	});
});
