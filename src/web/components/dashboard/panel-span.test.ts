import { describe, expect, it } from "vitest";
import { PANEL_SPANS, type PanelSize } from "../../../domain/dashboard.ts";
import { PANEL_SPAN_CLASS } from "./panel-span.ts";

describe("PANEL_SPAN_CLASS", () => {
	it("stays in lockstep with PANEL_SPANS", () => {
		for (const size of Object.keys(PANEL_SPANS) as PanelSize[]) {
			expect(PANEL_SPAN_CLASS[size]).toBe(`md:col-span-${PANEL_SPANS[size]}`);
		}
	});
});
