import { describe, expect, it } from "vitest";
import { isWideContent, WIDE_CONTENT_PX } from "./use-wide-content.ts";

describe("isWideContent", () => {
	it("needs a desktop viewport and enough measured width", () => {
		expect(isWideContent(true, WIDE_CONTENT_PX)).toBe(true);
		// 1100px viewport, sidebar and docked panel: ~370px left.
		expect(isWideContent(true, 370)).toBe(false);
		expect(isWideContent(false, 1200)).toBe(false);
	});

	it("trusts the viewport before the first measurement", () => {
		expect(isWideContent(true, null)).toBe(true);
		expect(isWideContent(false, null)).toBe(false);
	});
});
