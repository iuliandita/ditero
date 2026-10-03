import { z } from "zod";

export const THEME_DOCUMENT_MAX_BYTES = 16_384;
export const THEME_TOKENS = [
	"background",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"border",
	"input",
	"control-border",
	"ring",
	"sidebar",
	"sidebar-foreground",
	"sidebar-accent",
	"sidebar-accent-foreground",
	"sidebar-border",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];
export type ThemePalette = Record<ThemeToken, string>;
export type ThemeDocument = {
	version: 1;
	name: string;
	light: ThemePalette;
	dark: ThemePalette;
};

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const paletteSchema = z
	.object(
		Object.fromEntries(THEME_TOKENS.map((token) => [token, color])) as Record<
			ThemeToken,
			typeof color
		>,
	)
	.strict();
const documentSchema = z
	.object({
		version: z.literal(1),
		name: z
			.string()
			.trim()
			.min(1)
			.max(64)
			.refine((name) =>
				[...name].every((character) => {
					const code = character.codePointAt(0) ?? 0;
					return code >= 32 && (code < 127 || code > 159);
				}),
			),
		light: paletteSchema,
		dark: paletteSchema,
	})
	.strict();

function luminance(colorValue: string): number {
	const channels = [1, 3, 5].map(
		(offset) => Number.parseInt(colorValue.slice(offset, offset + 2), 16) / 255,
	);
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

export function themeContrast(first: string, second: string): number {
	const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
	return (values[1] + 0.05) / (values[0] + 0.05);
}

const TEXT_PAIRS = [
	["foreground", "background"],
	["card-foreground", "card"],
	["popover-foreground", "popover"],
	["primary-foreground", "primary"],
	["secondary-foreground", "secondary"],
	["muted-foreground", "muted"],
	["muted-foreground", "background"],
	["accent-foreground", "accent"],
	["sidebar-foreground", "sidebar"],
	["sidebar-accent-foreground", "sidebar-accent"],
] as const;
const SURFACES = [
	"background",
	"card",
	"popover",
	"secondary",
	"muted",
	"accent",
	"sidebar",
	"sidebar-accent",
] as const;

export function validateThemeDocument(value: unknown): ThemeDocument {
	function exactKeys(input: unknown, keys: readonly string[]): void {
		if (
			typeof input !== "object" ||
			input === null ||
			Array.isArray(input) ||
			(Object.getPrototypeOf(input) !== Object.prototype &&
				Object.getPrototypeOf(input) !== null) ||
			Object.getOwnPropertySymbols(input).length > 0 ||
			Object.keys(input).length !== keys.length ||
			Object.keys(input).some((key) => !keys.includes(key))
		)
			throw new Error("Unexpected theme fields");
	}
	exactKeys(value, ["version", "name", "light", "dark"]);
	const raw = value as Record<string, unknown>;
	exactKeys(raw.light, THEME_TOKENS);
	exactKeys(raw.dark, THEME_TOKENS);
	const document = documentSchema.parse(value);
	for (const mode of ["light", "dark"] as const) {
		const palette = document[mode];
		if (
			TEXT_PAIRS.some(
				([text, surface]) =>
					themeContrast(palette[text], palette[surface]) < 4.5,
			)
		)
			throw new Error("Theme text contrast must be at least 4.5:1");
		if (
			SURFACES.some((surface) =>
				["foreground", "muted-foreground"].some(
					(text) =>
						themeContrast(palette[text as ThemeToken], palette[surface]) < 4.5,
				),
			)
		)
			throw new Error("Theme shared text contrast must be at least 4.5:1");
		// Keep the fixed high-contrast foreground overrides readable too.
		if (
			SURFACES.some((surface) =>
				mode === "light"
					? luminance(palette[surface]) < 0.7
					: luminance(palette[surface]) > 0.1,
			)
		)
			throw new Error("Theme surfaces must match their light or dark mode");
	}
	return document;
}

export function parseThemeDocument(raw: string): ThemeDocument {
	if (new TextEncoder().encode(raw).byteLength > THEME_DOCUMENT_MAX_BYTES)
		throw new Error("Theme document is too large");
	return validateThemeDocument(JSON.parse(raw));
}

export function serializeThemeDocument(document: ThemeDocument): string {
	return `${JSON.stringify(validateThemeDocument(document), null, 2)}\n`;
}

function palette(
	background: string,
	surface: string,
	soft: string,
	foreground: string,
	muted: string,
	border: string,
	primary: string,
	primaryForeground: string,
): ThemePalette {
	return {
		background,
		foreground,
		card: surface,
		"card-foreground": foreground,
		popover: surface,
		"popover-foreground": foreground,
		primary,
		"primary-foreground": primaryForeground,
		secondary: soft,
		"secondary-foreground": foreground,
		muted: soft,
		"muted-foreground": muted,
		accent: soft,
		"accent-foreground": foreground,
		border,
		input: border,
		"control-border": muted,
		ring: primary,
		sidebar: soft,
		"sidebar-foreground": foreground,
		"sidebar-accent": soft,
		"sidebar-accent-foreground": foreground,
		"sidebar-border": border,
	};
}

export const BUILTIN_THEME_DOCUMENTS = {
	paper: validateThemeDocument({
		version: 1,
		name: "Paper",
		light: palette(
			"#faf7f0",
			"#fffdf7",
			"#f0ede4",
			"#292720",
			"#625d52",
			"#d8d1c1",
			"#17695d",
			"#ffffff",
		),
		dark: palette(
			"#211f1b",
			"#292620",
			"#302c25",
			"#f6f1e5",
			"#c2b9a5",
			"#514b3f",
			"#3fb4a0",
			"#0f1a18",
		),
	}),
	slate: validateThemeDocument({
		version: 1,
		name: "Slate",
		light: palette(
			"#f4f7fb",
			"#ffffff",
			"#eaf0f7",
			"#202b3d",
			"#526176",
			"#cbd5e2",
			"#17695d",
			"#ffffff",
		),
		dark: palette(
			"#17202e",
			"#1c2737",
			"#243247",
			"#edf3fc",
			"#b3c2d7",
			"#41536d",
			"#3fb4a0",
			"#0f1a18",
		),
	}),
} as const;
