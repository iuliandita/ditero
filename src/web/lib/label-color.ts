import { m } from "../../paraglide/messages.js";

// The one label colour vocabulary. `label.color` is a free-form notNull column
// defaulting to "gray", and the two `label.create` call sites pass no colour at
// all, so "gray" was the whole vocabulary until this file. Anything that offers
// or renders a label colour reads it from here; a second list would let the
// manager offer values nothing else can draw.
export const LABEL_COLORS = [
	"gray",
	"red",
	"orange",
	"yellow",
	"green",
	"teal",
	"blue",
	"purple",
	"pink",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const DEFAULT_LABEL_COLOR: LabelColor = "gray";

const SWATCH_CLASSES: Record<string, string> = {
	gray: "bg-gray-400",
	red: "bg-red-500",
	orange: "bg-orange-500",
	yellow: "bg-yellow-400",
	green: "bg-green-500",
	teal: "bg-teal-500",
	blue: "bg-blue-500",
	purple: "bg-purple-500",
	pink: "bg-pink-500",
};

// Thunks, not calls: this map is module-level, so a resolved string would
// freeze the import-time locale (locale-freeze.test.ts probes it).
const COLOR_NAMES: Record<string, () => string> = {
	gray: m.color_gray,
	red: m.color_red,
	orange: m.color_orange,
	yellow: m.color_yellow,
	green: m.color_green,
	teal: m.color_teal,
	blue: m.color_blue,
	purple: m.color_purple,
	pink: m.color_pink,
};

// The stored value is an arbitrary string from the database (and null in the
// Zero row type, which carries the column default rather than the notNull), so
// both lookups are Object.hasOwn-guarded: a prototype key must not resolve
// through the chain and hand back something that is not ours.
export function labelColorClass(color: string | null): string {
	const key = color ?? DEFAULT_LABEL_COLOR;
	return Object.hasOwn(SWATCH_CLASSES, key)
		? SWATCH_CLASSES[key]
		: SWATCH_CLASSES[DEFAULT_LABEL_COLOR];
}

export function labelColorName(color: string | null): string {
	const key = color ?? DEFAULT_LABEL_COLOR;
	return Object.hasOwn(COLOR_NAMES, key) ? COLOR_NAMES[key]() : key;
}
