import { LOCALES, type Locale, nativeName } from "./locale.ts";

export type LocaleOption = { value: Locale; label: string };

export function localeOptions(): LocaleOption[] {
	return LOCALES.map((value) => ({ value, label: nativeName(value) }));
}

export type ChangeLocaleDeps = {
	setLocale: (locale: Locale, options?: { reload?: boolean }) => void;
	applyDocumentLocale: (locale: Locale) => void;
	persistLocale: (locale: Locale) => void;
	authed: boolean;
};

// Reload is Paraglide's default and deliberate here: `m.*()` calls are not
// reactive, so a no-reload switch would only ever repaint the few components
// that happen to re-render for other reasons -- most of the UI would keep
// showing the old locale. The app is local-first (Zero rehydrates synced
// state from cache), so a full reload is cheap and guaranteed-correct.
export function changeLocale(locale: Locale, deps: ChangeLocaleDeps): void {
	if (deps.authed) deps.persistLocale(locale);
	deps.applyDocumentLocale(locale);
	deps.setLocale(locale);
}
