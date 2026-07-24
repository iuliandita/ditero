export const LOCALES = ["en", "de", "es", "fr", "ro", "ar"] as const;
export type Locale = (typeof LOCALES)[number];

export function isSupportedLocale(v: string): v is Locale {
	return (LOCALES as readonly string[]).includes(v);
}
