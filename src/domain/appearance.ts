import { z } from "zod";
import {
	BUILTIN_THEME_DOCUMENTS,
	type ThemeDocument,
	validateThemeDocument,
} from "./theme-document.ts";

export const ACCENT_THEMES = [
	"teal",
	"blue",
	"clay",
	"violet",
	"berry",
	"ochre",
] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];
export const MAX_CUSTOM_THEMES = 20;
export const APPEARANCE_MAX_BYTES = 350_000;
export type ThemeLibrary = {
	selected: string;
	useAccent: boolean;
	documents: { id: string; document: ThemeDocument }[];
};
export type Appearance = ThemeLibrary & { accentTheme: AccentTheme };
export const DEFAULT_THEME_LIBRARY: ThemeLibrary = {
	selected: "default",
	useAccent: true,
	documents: [],
};
export const DEFAULT_APPEARANCE: Appearance = {
	...DEFAULT_THEME_LIBRARY,
	accentTheme: "teal",
};

function exactKeys(
	input: unknown,
	keys: readonly string[],
): asserts input is Record<string, unknown> {
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
		throw new Error("Unexpected appearance fields");
}
const identity = z
	.string()
	.min(1)
	.max(128)
	.refine(
		(value) => !["__proto__", "constructor", "prototype"].includes(value),
	);
const librarySchema = z
	.object({
		selected: identity,
		useAccent: z.boolean(),
		documents: z
			.array(z.object({ id: identity, document: z.unknown() }).strict())
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

export function validateThemeLibrary(input: unknown): ThemeLibrary {
	exactKeys(input, ["selected", "useAccent", "documents"]);
	if (
		new TextEncoder().encode(JSON.stringify(input)).byteLength >
		APPEARANCE_MAX_BYTES
	)
		throw new Error("Appearance is too large");
	if (Array.isArray(input.documents))
		for (const entry of input.documents) exactKeys(entry, ["id", "document"]);
	const parsed = librarySchema.parse(input);
	const documents = parsed.documents.map((entry) => ({
		id: entry.id,
		document: validateThemeDocument(entry.document),
	}));
	if (
		new Set(documents.map((entry) => entry.id)).size !== documents.length ||
		documents.some(
			(entry) =>
				entry.id === "default" ||
				Object.hasOwn(BUILTIN_THEME_DOCUMENTS, entry.id),
		)
	)
		throw new Error("Invalid theme identity");
	const library = { ...parsed, documents };
	if (library.selected !== "default" && !selectedThemeDocument(library))
		throw new Error("Missing selected theme");
	return library;
}

export function validateAppearance(input: unknown): Appearance {
	exactKeys(input, ["selected", "useAccent", "accentTheme", "documents"]);
	if (
		new TextEncoder().encode(JSON.stringify(input)).byteLength >
		APPEARANCE_MAX_BYTES
	)
		throw new Error("Appearance is too large");
	return {
		...validateThemeLibrary({
			selected: input.selected,
			useAccent: input.useAccent,
			documents: input.documents,
		}),
		accentTheme: z.enum(ACCENT_THEMES).parse(input.accentTheme),
	};
}

export function migrateLegacyAppearance(
	legacy: Appearance,
	next: Appearance,
): Appearance {
	const documents = [
		...new Map(
			[...legacy.documents, ...next.documents].map((entry) => [
				entry.id,
				entry,
			]),
		).values(),
	];
	return validateAppearance({ ...next, documents });
}

export const appearanceSchema = z
	.custom<Appearance>()
	.transform((value, context): Appearance => {
		try {
			return validateAppearance(value);
		} catch {
			context.addIssue({ code: "custom", message: "Invalid appearance" });
			return z.NEVER;
		}
	});
