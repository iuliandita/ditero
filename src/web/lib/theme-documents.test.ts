import { describe, expect, test } from "vitest";
import {
	BUILTIN_THEME_DOCUMENTS,
	THEME_TOKENS,
	validateThemeDocument,
} from "../../domain/theme-document.ts";
import { ACCENT_THEMES } from "./display-preferences.ts";
import {
	applyThemeDocument,
	DEFAULT_THEME_LIBRARY,
	readThemeLibrary,
	resolveThemeDocument,
	writeThemeLibrary,
} from "./theme-documents.ts";

describe("account theme library", () => {
	test("keeps custom documents account-local and anonymous state empty", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		};
		const library = {
			selected: "custom",
			useAccent: false,
			documents: [{ id: "custom", document: BUILTIN_THEME_DOCUMENTS.paper }],
		};
		expect(writeThemeLibrary("first", library, storage)).toBe(true);
		expect(readThemeLibrary("first", storage)).toEqual(library);
		expect(readThemeLibrary("second", storage)).toEqual(DEFAULT_THEME_LIBRARY);
		expect(writeThemeLibrary(null, library, storage)).toBe(false);
		expect(readThemeLibrary(null, storage)).toEqual(DEFAULT_THEME_LIBRARY);
	});
	test("rejects corrupt, oversized and identity-conflicting stored libraries", () => {
		const entry = { id: "custom", document: BUILTIN_THEME_DOCUMENTS.paper };
		for (const value of [
			"{",
			"x".repeat(350_001),
			JSON.stringify({ selected: "missing", useAccent: false, documents: [] }),
			JSON.stringify({
				selected: "custom",
				useAccent: false,
				documents: [entry, entry],
			}),
			JSON.stringify({
				selected: "default",
				useAccent: true,
				documents: [{ ...entry, id: "paper" }],
			}),
			JSON.stringify({
				selected: "custom",
				useAccent: false,
				documents: Array(21).fill(entry),
			}),
		])
			expect(
				readThemeLibrary("first", { getItem: () => value, setItem: () => {} }),
			).toEqual(DEFAULT_THEME_LIBRARY);
	});
	test("storage failures never claim persistence", () => {
		const storage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readThemeLibrary("first", storage)).toEqual(DEFAULT_THEME_LIBRARY);
		expect(writeThemeLibrary("first", DEFAULT_THEME_LIBRARY, storage)).toBe(
			false,
		);
	});
	test("invalid writes preserve the previous saved theme", () => {
		let saved = "original";
		const storage = {
			getItem: () => saved,
			setItem: (_key: string, raw: string) => {
				saved = raw;
			},
		};
		expect(
			writeThemeLibrary(
				"first",
				{ ...DEFAULT_THEME_LIBRARY, selected: "missing" },
				storage,
			),
		).toBe(false);
		expect(saved).toBe("original");
	});
	test("accent replacement preserves theme surfaces and stays readable", () => {
		for (const document of Object.values(BUILTIN_THEME_DOCUMENTS))
			for (const accent of ACCENT_THEMES) {
				const resolved = resolveThemeDocument(document, accent, true);
				expect(resolved.light.background).toBe(document.light.background);
				expect(resolved.dark.background).toBe(document.dark.background);
				expect(() => validateThemeDocument(resolved)).not.toThrow();
			}
		expect(
			resolveThemeDocument(BUILTIN_THEME_DOCUMENTS.paper, "blue", false),
		).toBe(BUILTIN_THEME_DOCUMENTS.paper);
	});
	test("account teardown removes every alias without touching status or mode", () => {
		const values = new Map([["--priority-3", "red"]]);
		const root = {
			dataset: { highContrast: "true" } as Record<string, string>,
			style: {
				setProperty: (key: string, value: string) => {
					values.set(key, value);
				},
				removeProperty: (key: string) => {
					values.delete(key);
					return "";
				},
			},
		};
		applyThemeDocument(BUILTIN_THEME_DOCUMENTS.paper, root);
		expect(values.get("--theme-dark-background")).toBe("#211f1b");
		expect(values.size).toBe(THEME_TOKENS.length * 2 + 1);
		applyThemeDocument(null, root);
		expect([...values]).toEqual([["--priority-3", "red"]]);
		expect(root.dataset).toEqual({ highContrast: "true" });
	});
});
