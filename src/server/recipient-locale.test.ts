import { describe, expect, it, vi } from "vitest";
import { localeFromPref, resolveRecipientLocale } from "./recipient-locale.ts";

type ResolverDb = Parameters<typeof resolveRecipientLocale>[0];

// resolveRecipientLocale issues exactly one select: the user's stored locale.
function stubDb(
	rows: Array<{ locale: string | null }>,
	spy?: () => void,
): ResolverDb {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows),
	};
	return {
		select: () => {
			spy?.();
			return chain;
		},
	} as unknown as ResolverDb;
}

function throwingDb(): ResolverDb {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.reject(new Error("db down")),
	};
	return { select: () => chain } as unknown as ResolverDb;
}

describe("localeFromPref", () => {
	it("keeps a supported stored locale", () => {
		expect(localeFromPref("de")).toBe("de");
		expect(localeFromPref("ar")).toBe("ar");
	});

	it("falls back to en for unsupported, empty, null, or absent values", () => {
		expect(localeFromPref("xx")).toBe("en");
		expect(localeFromPref("")).toBe("en");
		expect(localeFromPref(null)).toBe("en");
		expect(localeFromPref(undefined)).toBe("en");
	});
});

describe("resolveRecipientLocale", () => {
	it("returns en for a null user without touching the database", async () => {
		const selected = vi.fn();
		const locale = await resolveRecipientLocale(
			stubDb([{ locale: "de" }], selected),
			null,
		);
		expect(locale).toBe("en");
		expect(selected).not.toHaveBeenCalled();
	});

	it("returns the user's supported stored locale", async () => {
		expect(await resolveRecipientLocale(stubDb([{ locale: "de" }]), "u1")).toBe(
			"de",
		);
	});

	it("falls back to en for an unsupported stored locale", async () => {
		expect(await resolveRecipientLocale(stubDb([{ locale: "xx" }]), "u1")).toBe(
			"en",
		);
	});

	it("falls back to en for a null stored locale", async () => {
		expect(await resolveRecipientLocale(stubDb([{ locale: null }]), "u1")).toBe(
			"en",
		);
	});

	it("falls back to en when the user has no pref row", async () => {
		expect(await resolveRecipientLocale(stubDb([]), "u1")).toBe("en");
	});

	it("falls back to en, without throwing, when the lookup fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await resolveRecipientLocale(throwingDb(), "u1")).toBe("en");
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
