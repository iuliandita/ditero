import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	createHintStore,
	dismissSyntaxHint,
	markShortcutsSeen,
	recordSyntaxUse,
} from "../lib/hints.ts";
import { useAccountStorageScope } from "../lib/native-account.tsx";

const store = createHintStore(() => {
	try {
		return localStorage;
	} catch {
		return null;
	}
});

export function useHints() {
	const storageScope = useAccountStorageScope();
	const hints = useSyncExternalStore(store.subscribe, () =>
		store.get(storageScope),
	);
	const recordUse = useCallback(
		(tokenCount: number) =>
			store.update(storageScope, (h) => recordSyntaxUse(h, tokenCount)),
		[storageScope],
	);
	const dismissSyntax = useCallback(
		() => store.update(storageScope, dismissSyntaxHint),
		[storageScope],
	);
	const shortcutsSeen = useCallback(
		() => store.update(storageScope, markShortcutsSeen),
		[storageScope],
	);
	return useMemo(
		() => ({ hints, recordUse, dismissSyntax, shortcutsSeen }),
		[hints, recordUse, dismissSyntax, shortcutsSeen],
	);
}
