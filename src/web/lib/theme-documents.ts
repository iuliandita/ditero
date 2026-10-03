import {
	DEFAULT_THEME_LIBRARY,
	type ThemeLibrary,
	validateThemeLibrary,
} from "../../domain/appearance.ts";
import {
	THEME_TOKENS,
	type ThemeDocument,
} from "../../domain/theme-document.ts";
import { ACCENT_PALETTES, type AccentTheme } from "./accent-palettes.ts";

export {
	DEFAULT_THEME_LIBRARY,
	MAX_CUSTOM_THEMES,
	selectedThemeDocument,
	type ThemeLibrary,
	validateThemeLibrary,
} from "../../domain/appearance.ts";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): ThemeStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function readThemeLibrary(
	userId: string | null,
	source: ThemeStorage | null = storage(),
): ThemeLibrary {
	if (!userId || !source) return { ...DEFAULT_THEME_LIBRARY, documents: [] };
	try {
		const raw = source.getItem(`ditero.themes.${userId}`);
		if (!raw || new TextEncoder().encode(raw).byteLength > 350_000)
			return { ...DEFAULT_THEME_LIBRARY, documents: [] };
		return validateThemeLibrary(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_THEME_LIBRARY, documents: [] };
	}
}

export function writeThemeLibrary(
	userId: string | null,
	library: ThemeLibrary,
	source: ThemeStorage | null = storage(),
): boolean {
	if (!userId || !source) return false;
	try {
		const raw = JSON.stringify(validateThemeLibrary(library));
		if (new TextEncoder().encode(raw).byteLength > 350_000) return false;
		source.setItem(`ditero.themes.${userId}`, raw);
		return true;
	} catch {
		return false;
	}
}

export function resolveThemeDocument(
	document: ThemeDocument,
	accent: AccentTheme,
	useAccent: boolean,
): ThemeDocument {
	if (!useAccent) return document;
	const brand = ACCENT_PALETTES[accent];
	const resolved = {
		...document,
		light: { ...document.light },
		dark: { ...document.dark },
	};
	for (const mode of ["light", "dark"] as const) {
		resolved[mode].primary = brand[mode].accent;
		resolved[mode]["primary-foreground"] = brand[mode].buttonInk;
		resolved[mode].ring = brand[mode].accent;
	}
	return resolved;
}

export function applyThemeDocument(
	document: ThemeDocument | null,
	root: {
		style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
		dataset: DOMStringMap;
	},
): void {
	for (const mode of ["light", "dark"] as const)
		for (const token of THEME_TOKENS) {
			const key = `--theme-${mode}-${token}`;
			if (document) root.style.setProperty(key, document[mode][token]);
			else root.style.removeProperty(key);
		}
	if (document) root.dataset.themeDocument = "true";
	else delete root.dataset.themeDocument;
}
