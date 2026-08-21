// Three states, not two: "system" is the absence of an override, and it must be
// reachable again after a user has chosen one. The CSS in index.css already
// encodes exactly this -- .dark forces dark, .light beats the
// prefers-color-scheme block, no class follows the OS -- so applying a theme is
// only a matter of which class (if any) is on <html>.

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** The persisted form: null is "system". */
export type StoredTheme = "light" | "dark" | null;

const STORAGE_KEY = "ditero-theme";

export function isTheme(value: unknown): value is Theme {
	return (
		typeof value === "string" && (THEMES as readonly string[]).includes(value)
	);
}

export function toStored(theme: Theme): StoredTheme {
	return theme === "system" ? null : theme;
}

export function fromStored(stored: StoredTheme | undefined): Theme {
	return stored === "light" || stored === "dark" ? stored : "system";
}

export function applyTheme(theme: Theme, root: HTMLElement): void {
	root.classList.remove("light", "dark");
	if (theme !== "system") root.classList.add(theme);
}

// localStorage is the boot-time source of truth and user_pref is the
// cross-device one, mirroring how locale is handled. Reading localStorage can
// throw in a locked-down browser context, so it is guarded: an unreadable
// preference degrades to "system", never to a crash before React mounts.
export function readLocalTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return isTheme(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

export function writeLocalTheme(theme: Theme): void {
	try {
		localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// Non-fatal: the choice still applies for this page and still syncs
		// through user_pref. Only the pre-hydration boot hint is lost.
	}
}
