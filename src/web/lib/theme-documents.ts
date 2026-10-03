import { z } from "zod";
import {
	BUILTIN_THEME_DOCUMENTS,
	THEME_TOKENS,
	type ThemeDocument,
	validateThemeDocument,
} from "../../domain/theme-document.ts";
import { ACCENT_PALETTES, type AccentTheme } from "./accent-palettes.ts";

export const MAX_CUSTOM_THEMES = 20;
export type ThemeLibrary = {
	selected: string;
	useAccent: boolean;
	documents: { id: string; document: ThemeDocument }[];
};
export const DEFAULT_THEME_LIBRARY: ThemeLibrary = {
	selected: "default",
	useAccent: true,
	documents: [],
};
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
const librarySchema = z
	.object({
		selected: z.string().max(128),
		useAccent: z.boolean(),
		documents: z
			.array(
				z
					.object({ id: z.string().min(1).max(128), document: z.unknown() })
					.strict(),
			)
			.max(MAX_CUSTOM_THEMES),
	})
	.strict();

export function selectedThemeDocument(
	library: ThemeLibrary,
): ThemeDocument | null {
	if (library.selected === "default") return null;
	if (Object.hasOwn(BUILTIN_THEME_DOCUMENTS, library.selected))
		return BUILTIN_THEME_DOCUMENTS[
			library.selected as keyof typeof BUILTIN_THEME_DOCUMENTS
		];
	return (
		library.documents.find((entry) => entry.id === library.selected)
			?.document ?? null
	);
}

function storage(): ThemeStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function validateThemeLibrary(input: unknown): ThemeLibrary {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.keys(input).some(
			(key) => !["selected", "useAccent", "documents"].includes(key),
		)
	)
		throw new Error("Unexpected theme library fields");
	const rawDocuments = (input as Record<string, unknown>).documents;
	if (Array.isArray(rawDocuments))
		for (const entry of rawDocuments)
			if (
				typeof entry !== "object" ||
				entry === null ||
				Object.keys(entry).some((key) => !["id", "document"].includes(key))
			)
				throw new Error("Unexpected saved theme fields");
	const value = librarySchema.parse(input);
	const documents = value.documents.map((entry) => {
		if (Object.keys(entry).some((key) => !["id", "document"].includes(key)))
			throw new Error("Unexpected saved theme fields");
		return { id: entry.id, document: validateThemeDocument(entry.document) };
	});
	if (
		new Set(documents.map((entry) => entry.id)).size !== documents.length ||
		documents.some(
			(entry) =>
				entry.id === "default" ||
				Object.hasOwn(BUILTIN_THEME_DOCUMENTS, entry.id),
		)
	)
		throw new Error("Invalid theme identity");
	const library = { ...value, documents };
	if (library.selected !== "default" && !selectedThemeDocument(library))
		throw new Error("Missing selected theme");
	return library;
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
