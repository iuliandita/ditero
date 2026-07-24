import { LOCALES, type Locale, nativeName } from "./locale.ts";

export type LocaleOption = { value: Locale; label: string };

export function localeOptions(): LocaleOption[] {
	return LOCALES.map((value) => ({ value, label: nativeName(value) }));
}

export type ChangeLocaleDeps = {
	setLocale: (locale: Locale, options?: { reload?: boolean }) => void;
	applyDocumentLocale: (locale: Locale) => void;
	// Omitted pre-auth, where there is no Zero client to persist through -- its
	// presence/absence *is* the authed/not-authed distinction, so there is no
	// separate flag to keep in sync with it.
	persistLocale?: (locale: Locale) => void;
};

// Reload is Paraglide's default and deliberate here: `m.*()` calls are not
// reactive, so a no-reload switch would only ever repaint the few components
// that happen to re-render for other reasons -- most of the UI would keep
// showing the old locale. The app is local-first (Zero rehydrates synced
// state from cache), so a full reload is cheap and guaranteed-correct.
export function changeLocale(locale: Locale, deps: ChangeLocaleDeps): void {
	deps.persistLocale?.(locale);
	deps.applyDocumentLocale(locale);
	deps.setLocale(locale);
}
