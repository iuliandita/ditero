import type { Locale } from "./locale.ts";

type ReconciliationDeps = {
	currentLocale: () => Locale;
	isOwnerActive: () => boolean;
	retireClients: (retryFailed: boolean) => Promise<void>;
	applyLocale: (locale: Locale) => void;
	onError: (retry: () => void) => void;
};

export function createLocaleReconciler(deps: ReconciliationDeps) {
	let latest: Locale | null = null;
	let attempted = false;
	let pending: Promise<boolean> | undefined;

	function start(retryFailed: boolean): Promise<boolean> {
		if (pending) return pending;
		if (!deps.isOwnerActive()) return Promise.resolve(false);
		attempted = true;
		pending = (async () => {
			await deps.retireClients(retryFailed);
			if (!deps.isOwnerActive()) return false;
			// Retirement already closed the client. Reload even if the preference
			// changed back to the current locale while persistence was pending.
			deps.applyLocale(latest ?? deps.currentLocale());
			return true;
		})().then(
			(applied) => {
				pending = undefined;
				return applied;
			},
			() => {
				pending = undefined;
				if (deps.isOwnerActive()) deps.onError(() => void start(true));
				return false;
			},
		);
		return pending;
	}

	return {
		update(locale: Locale | null): Promise<boolean> {
			latest = locale;
			if (pending) return pending;
			if (attempted) return Promise.resolve(false);
			if (locale === null || locale === deps.currentLocale()) {
				attempted = true;
				return Promise.resolve(false);
			}
			return start(false);
		},
	};
}

const reconcilers = new WeakMap<
	object,
	ReturnType<typeof createLocaleReconciler>
>();

export function reconcileStoredLocale(
	owner: object,
	locale: Locale | null,
	deps: ReconciliationDeps,
): Promise<boolean> {
	let reconciler = reconcilers.get(owner);
	if (!reconciler) {
		reconciler = createLocaleReconciler(deps);
		reconcilers.set(owner, reconciler);
	}
	return reconciler.update(locale);
}
