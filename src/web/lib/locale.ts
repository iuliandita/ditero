import type { Locale } from "../../domain/locale.ts";

export {
	isSupportedLocale,
	LOCALES,
	type Locale,
} from "../../domain/locale.ts";

const RTL = new Set<string>(["ar"]);
const NATIVE: Record<Locale, string> = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	ro: "Română",
	ar: "العربية",
};

export function isRtl(locale: string): boolean {
	return RTL.has(locale);
}

export function nativeName(locale: Locale): string {
	return NATIVE[locale];
}

export function applyDocumentLocale(locale: string): void {
	document.documentElement.lang = locale;
	document.documentElement.dir = isRtl(locale) ? "rtl" : "ltr";
}
