import type { PanelSize } from "../../../domain/dashboard.ts";

// md+ grid column span per size preset (PANEL_SPANS); below md the grid is a
// single column so every panel renders full-width. Static strings because
// Tailwind can't see computed class names.
export const PANEL_SPAN_CLASS: Record<PanelSize, string> = {
	s: "md:col-span-3",
	m: "md:col-span-6",
	l: "md:col-span-8",
	full: "md:col-span-12",
};
