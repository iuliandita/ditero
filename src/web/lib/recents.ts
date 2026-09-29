// What the user last opened, for the command palette's Recent section. Kept in
// browser storage per user id: it is a convenience, so a private window, a
// full quota or a throwing accessor degrades to "no recents", never an error.

export type RecentKind = "task" | "list" | "view" | "dashboard";
export type Recent = { kind: RecentKind; id: string };

export const RECENTS_MAX = 8;

type RecentsStorage = Pick<Storage, "getItem" | "setItem">;

const KINDS: ReadonlySet<string> = new Set([
	"task",
	"list",
	"view",
	"dashboard",
]);

// No key for a missing user: an anonymous bucket would leak one account's
// history into the next sign-in on the same browser.
export function recentsKey(userId: string | null | undefined): string | null {
	return userId ? `ditero.recents.${userId}` : null;
}

export function pushRecent(
	list: readonly Recent[],
	next: Recent,
	max = RECENTS_MAX,
): Recent[] {
	return [
		next,
		...list.filter((r) => r.kind !== next.kind || r.id !== next.id),
	].slice(0, max);
}

export function parseRecents(raw: string | null): Recent[] {
	if (!raw) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const out: Recent[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const { kind, id } = item as { kind?: unknown; id?: unknown };
		if (typeof kind !== "string" || !KINDS.has(kind)) continue;
		if (typeof id !== "string" || id === "") continue;
		out.push({ kind: kind as RecentKind, id });
		if (out.length === RECENTS_MAX) break;
	}
	return out;
}

function defaultStorage(): RecentsStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function loadRecents(
	userId: string | null | undefined,
	storage: RecentsStorage | null = defaultStorage(),
): Recent[] {
	const key = recentsKey(userId);
	if (!key || !storage) return [];
	try {
		return parseRecents(storage.getItem(key));
	} catch {
		return [];
	}
}

export function recordRecent(
	userId: string | null | undefined,
	next: Recent,
	storage: RecentsStorage | null = defaultStorage(),
): void {
	const key = recentsKey(userId);
	if (!key || !storage || !next.id) return;
	try {
		const list = pushRecent(parseRecents(storage.getItem(key)), next);
		storage.setItem(key, JSON.stringify(list));
	} catch {
		// Storage refused (quota, privacy mode): the palette just has no recents.
	}
}
