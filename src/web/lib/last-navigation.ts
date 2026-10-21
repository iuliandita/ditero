// Device-local navigation uses the same account/server scope as recents.
export type LastNavigation = { workspaceId: string; listId: string | null };
type NavigationStorage = Pick<Storage, "getItem" | "setItem">;

export function lastNavigationKey(scope: string): string | null {
	return scope ? `ditero.navigation.${scope}` : null;
}

function storage(): NavigationStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function loadLastNavigation(
	scope: string,
	store = storage(),
): LastNavigation | null {
	const key = lastNavigationKey(scope);
	if (!key || !store) return null;
	try {
		const value: unknown = JSON.parse(store.getItem(key) ?? "null");
		if (!value || typeof value !== "object") return null;
		const { workspaceId, listId } = value as Record<string, unknown>;
		if (
			typeof workspaceId !== "string" ||
			!workspaceId ||
			!(listId === null || (typeof listId === "string" && listId))
		)
			return null;
		return { workspaceId, listId };
	} catch {
		return null;
	}
}

export function saveLastNavigation(
	scope: string,
	value: LastNavigation,
	store = storage(),
): void {
	const key = lastNavigationKey(scope);
	if (!key || !store) return;
	try {
		store.setItem(key, JSON.stringify(value));
	} catch {
		/* Navigation still works when storage is unavailable. */
	}
}
