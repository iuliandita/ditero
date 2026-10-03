import { describe, expect, test } from "vitest";
import { BUILTIN_THEME_DOCUMENTS } from "../../domain/theme-document.ts";
import { DEFAULT_THEME_LIBRARY, MAX_CUSTOM_THEMES } from "./theme-documents.ts";
import { saveEditedTheme } from "./theme-editor.ts";

describe("saving an edited theme", () => {
	test("creates a custom copy without modifying the builtin or source library", () => {
		const document = structuredClone(BUILTIN_THEME_DOCUMENTS.paper);
		document.name = "Home";
		document.light.background = "#ffffff";
		const source = { ...DEFAULT_THEME_LIBRARY, selected: "paper" };
		const saved = saveEditedTheme(source, "paper", document, "new-theme");
		expect(saved).toEqual({
			selected: "new-theme",
			useAccent: false,
			documents: [{ id: "new-theme", document }],
		});
		expect(source.documents).toEqual([]);
		expect(BUILTIN_THEME_DOCUMENTS.paper.light.background).toBe("#faf7f0");
	});
	test("updates the selected custom identity and preserves other themes", () => {
		const first = { id: "first", document: BUILTIN_THEME_DOCUMENTS.paper };
		const second = { id: "second", document: BUILTIN_THEME_DOCUMENTS.slate };
		const source = {
			selected: "first",
			useAccent: true,
			documents: [first, second],
		};
		const edited = { ...structuredClone(first.document), name: "Updated" };
		const saved = saveEditedTheme(source, "first", edited, "unused");
		expect(saved.selected).toBe("first");
		expect(saved.documents).toEqual([
			{ id: "first", document: edited },
			second,
		]);
		expect(source.documents[0].document.name).toBe("Paper");
	});
	test("rejects unreadable edits and a full library while allowing an existing theme update", () => {
		const source = {
			selected: "theme-0",
			useAccent: false,
			documents: Array.from({ length: MAX_CUSTOM_THEMES }, (_, index) => ({
				id: `theme-${index}`,
				document: BUILTIN_THEME_DOCUMENTS.paper,
			})),
		};
		const edited = structuredClone(BUILTIN_THEME_DOCUMENTS.paper);
		expect(() => saveEditedTheme(source, "paper", edited, "extra")).toThrow(
			/full/,
		);
		expect(
			saveEditedTheme(source, "theme-0", edited, "unused").documents,
		).toHaveLength(MAX_CUSTOM_THEMES);
		edited.light.foreground = edited.light.background;
		expect(() => saveEditedTheme(source, "theme-0", edited, "unused")).toThrow(
			/contrast/,
		);
		expect(source.documents[0].document.light.foreground).toBe("#292720");
	});
});
