import { describe, expect, it } from "vitest";
import { isRtl, isSupportedLocale, LOCALES, nativeName } from "./locale.ts";

describe("locale registry", () => {
	it("lists the six supported locales", () => {
		expect(LOCALES).toEqual(["en", "de", "es", "fr", "ro", "ar"]);
	});
	it("matches Paraglide's compiled locale list", async () => {
		const { locales } = await import("../../paraglide/runtime.js");
		expect([...locales].sort()).toEqual([...LOCALES].sort());
	});
	it("validates membership", () => {
		expect(isSupportedLocale("de")).toBe(true);
		expect(isSupportedLocale("zz")).toBe(false);
	});
	it("marks arabic rtl and others ltr", () => {
		expect(isRtl("ar")).toBe(true);
		expect(isRtl("en")).toBe(false);
	});
	it("gives native display names", () => {
		expect(nativeName("de")).toBe("Deutsch");
		expect(nativeName("ar")).toBe("العربية");
	});
});
