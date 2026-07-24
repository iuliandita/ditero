export const LOCALES = ["en", "de", "es", "fr", "ro", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

const RTL = new Set<string>(["ar"]);
const NATIVE: Record<Locale, string> = {
	en: "English",
	de: "Deutsch",
	es: "Español",
	fr: "Français",
	ro: "Română",
	ar: "العربية",
};

export function isSupportedLocale(v: string): v is Locale {
	return (LOCALES as readonly string[]).includes(v);
}

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
