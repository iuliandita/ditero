import { describe, expect, it } from "vitest";
import { fitLine, renderFrame, safeText } from "./render.ts";

describe("terminal frames", () => {
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
