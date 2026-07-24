import { describe, expect, it, vi } from "vitest";
import { changeLocale, localeOptions } from "./language-switcher.ts";
import { LOCALES, nativeName } from "./locale.ts";

describe("localeOptions", () => {
	it("lists all six locales with native names", () => {
		expect(localeOptions()).toEqual(
			LOCALES.map((value) => ({ value, label: nativeName(value) })),
		);
	});
});

describe("changeLocale", () => {
	it("persists, applies the document locale, then calls setLocale when authed", () => {
		const calls: string[] = [];
		const setLocale = vi.fn(() => calls.push("setLocale"));
		const applyDocumentLocale = vi.fn(() => calls.push("applyDocumentLocale"));
		const persistLocale = vi.fn(() => calls.push("persistLocale"));

		changeLocale("de", {
			setLocale,
			applyDocumentLocale,
			persistLocale,
			authed: true,
		});

		expect(persistLocale).toHaveBeenCalledWith("de");
		expect(applyDocumentLocale).toHaveBeenCalledWith("de");
		expect(setLocale).toHaveBeenCalledWith("de");
		expect(calls).toEqual([
			"persistLocale",
			"applyDocumentLocale",
			"setLocale",
		]);
	});

	it("does not persist when not authed", () => {
		const setLocale = vi.fn();
		const applyDocumentLocale = vi.fn();
		const persistLocale = vi.fn();

		changeLocale("ar", {
			setLocale,
			applyDocumentLocale,
			persistLocale,
			authed: false,
		});

		expect(persistLocale).not.toHaveBeenCalled();
		expect(applyDocumentLocale).toHaveBeenCalledWith("ar");
		expect(setLocale).toHaveBeenCalledWith("ar");
	});
});
