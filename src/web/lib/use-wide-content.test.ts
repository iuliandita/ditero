import { describe, expect, it } from "vitest";
import { isWideContent, WIDE_CONTENT_PX } from "./use-wide-content.ts";

describe("isWideContent", () => {
	it("keeps the viewport rule when no panel is open", () => {
		// 900px viewport, 280px sidebar: ~570px of content, still a desktop board.
		expect(isWideContent(true, false, 570)).toBe(true);
		expect(isWideContent(true, false, null)).toBe(true);
		expect(isWideContent(false, false, 1200)).toBe(false);
	});

	it("checks the measured width only beside an open panel", () => {
		expect(isWideContent(true, true, WIDE_CONTENT_PX)).toBe(true);
		// 1100px viewport, sidebar and docked panel: ~390px left.
		expect(isWideContent(true, true, 390)).toBe(false);
		expect(isWideContent(true, true, null)).toBe(false);
		expect(isWideContent(false, true, 1200)).toBe(false);
	});
});
