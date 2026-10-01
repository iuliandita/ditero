import { LOCALES, type Locale, nativeName } from "./locale.ts";
import { retireZeroClients } from "./zero-lifecycle.ts";

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
	persistLocale?: (locale: Locale) => Promise<boolean>;
	retireClients?: () => Promise<void>;
	shouldApply?: () => boolean;
};

// Reload is Paraglide's default and deliberate here: `m.*()` calls are not
// reactive, so a no-reload switch would only ever repaint the few components
// that happen to re-render for other reasons -- most of the UI would keep
// showing the old locale. The app is local-first (Zero rehydrates synced
// state from cache), so a full reload is cheap and guaranteed-correct.
export async function changeLocale(
	locale: Locale,
	deps: ChangeLocaleDeps,
): Promise<boolean> {
	if ((await deps.persistLocale?.(locale)) === false)
		throw new Error("Locale preference was not saved locally");
	await (deps.retireClients ?? retireZeroClients)();
	if (deps.shouldApply?.() === false) return false;
	deps.applyDocumentLocale(locale);
	deps.setLocale(locale);
	return true;
}

type LocaleChangeActionDeps = ChangeLocaleDeps & {
	isOwnerActive: () => boolean;
	isChildMounted: () => boolean;
	onPending: (pending: boolean) => void;
	onApplied: (locale: Locale) => void;
	onInlineError: () => void;
	onGlobalError: (retry: () => void) => void;
};

export function createLocaleChangeAction(
	locale: Locale,
	deps: LocaleChangeActionDeps,
) {
	let persisted = false;
	let pending = false;
	async function run(): Promise<void> {
		if (pending || !deps.isOwnerActive()) return;
		pending = true;
		if (deps.isChildMounted()) deps.onPending(true);
		try {
			const applied = await changeLocale(locale, {
				...deps,
				shouldApply: deps.isOwnerActive,
				persistLocale:
					deps.persistLocale && !persisted
						? async (next) => {
								const saved = await deps.persistLocale?.(next);
								if (saved === false) return false;
								persisted = true;
								return true;
							}
						: undefined,
			});
			if (applied && deps.isChildMounted()) deps.onApplied(locale);
		} catch {
			if (deps.isOwnerActive()) {
				if (deps.isChildMounted()) deps.onInlineError();
				else deps.onGlobalError(() => void run());
			}
		} finally {
			pending = false;
			if (deps.isChildMounted()) deps.onPending(false);
		}
	}
	return { run };
}
