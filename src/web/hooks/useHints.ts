import { useZero } from "@rocicorp/zero/react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
	createHintStore,
	dismissSyntaxHint,
	markShortcutsSeen,
	recordSyntaxUse,
} from "../lib/hints.ts";

const store = createHintStore(() => {
	try {
		return localStorage;
	} catch {
		return null;
	}
});

export function useHints() {
	const userId = useZero().userID ?? "";
	const hints = useSyncExternalStore(store.subscribe, () => store.get(userId));
	const recordUse = useCallback(
		(tokenCount: number) =>
			store.update(userId, (h) => recordSyntaxUse(h, tokenCount)),
		[userId],
	);
	const dismissSyntax = useCallback(
		() => store.update(userId, dismissSyntaxHint),
		[userId],
	);
	const shortcutsSeen = useCallback(
		() => store.update(userId, markShortcutsSeen),
		[userId],
	);
	return useMemo(
		() => ({ hints, recordUse, dismissSyntax, shortcutsSeen }),
		[hints, recordUse, dismissSyntax, shortcutsSeen],
	);
}
