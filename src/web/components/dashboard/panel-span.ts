import type { PanelSize } from "../../../domain/dashboard.ts";

// Grid column span per size preset (PANEL_SPANS) once the dashboard container
// is @2xl wide; narrower (a phone, or beside the docked task detail) the grid
// is a single column so every panel renders full-width. Static strings because
// Tailwind can't see computed class names.
export const PANEL_SPAN_CLASS: Record<PanelSize, string> = {
	s: "@2xl:col-span-3",
	m: "@2xl:col-span-6",
	l: "@2xl:col-span-8",
	full: "@2xl:col-span-12",
};
