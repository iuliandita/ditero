import { describe, expect, test } from "vitest";
import {
	BUILTIN_THEME_DOCUMENTS,
	parseThemeDocument,
	serializeThemeDocument,
	THEME_DOCUMENT_MAX_BYTES,
	validateThemeDocument,
} from "./theme-document.ts";

const valid = () => structuredClone(BUILTIN_THEME_DOCUMENTS.paper);

describe("theme documents", () => {
	test("round-trips complete builtin light and dark palettes", () => {
		for (const document of Object.values(BUILTIN_THEME_DOCUMENTS))
			expect(parseThemeDocument(serializeThemeDocument(document))).toEqual(
				document,
			);
	});
	test("rejects unknown, prototype, status and incomplete keys", () => {
		for (const key of [
			"__proto__",
			"constructor",
			"priority-3",
			"font-family",
			"background-image",
		]) {
			const document = valid();
			const raw = JSON.stringify(document).replace(
				'"background":',
				`${JSON.stringify(key)}:"#ffffff","background":`,
			);
			expect(() => parseThemeDocument(raw)).toThrow();
		}
		const document: Record<string, unknown> = { ...valid(), version: 2 };
		expect(() => validateThemeDocument(document)).toThrow();
		delete document.dark;
		expect(() => validateThemeDocument(document)).toThrow();
	});
	test("rejects executable and ambiguous color syntax", () => {
		for (const color of [
			"red",
			"#fff",
			"#ffffff00",
			"var(--foreground)",
			"url(https://example.test)",
			"#ffffff;display:none",
			"#ffffff\n",
		]) {
			const document = valid();
			document.light.background = color;
			expect(() => validateThemeDocument(document)).toThrow();
		}
	});
	test("rejects unreadable text and surfaces that defeat contrast mode", () => {
		const document = valid();
		document.light.foreground = document.light.background;
		expect(() => validateThemeDocument(document)).toThrow(/contrast/);
		const inverted = valid();
		inverted.dark = structuredClone(inverted.light);
		expect(() => validateThemeDocument(inverted)).toThrow(/surfaces/);
	});
	test("bounds bytes before JSON parsing and names after parsing", () => {
		expect(() =>
			parseThemeDocument(" ".repeat(THEME_DOCUMENT_MAX_BYTES + 1)),
		).toThrow(/large/);
		expect(() =>
			parseThemeDocument("é".repeat(THEME_DOCUMENT_MAX_BYTES / 2 + 1)),
		).toThrow(/large/);
		for (const name of ["", "x".repeat(65), "hidden\u0000name"]) {
			const document = valid();
			document.name = name;
			expect(() => validateThemeDocument(document)).toThrow();
		}
	});
});
