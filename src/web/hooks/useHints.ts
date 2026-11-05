import { useCallback, useMemo, useSyncExternalStore } from "react";
import { createHintStore, markShortcutsSeen } from "../lib/hints.ts";
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
	const shortcutsSeen = useCallback(
		() => store.update(storageScope, markShortcutsSeen),
		[storageScope],
	);
	return useMemo(() => ({ hints, shortcutsSeen }), [hints, shortcutsSeen]);
}
