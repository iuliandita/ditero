export const READING_SIZES = ["standard", "comfortable", "large"] as const;
export type ReadingSize = (typeof READING_SIZES)[number];
export const ACCENT_THEMES = [
	"teal",
	"blue",
	"clay",
	"violet",
	"berry",
	"ochre",
] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];
export type DisplayPreferences = {
	accentTheme: AccentTheme;
	readingSize: ReadingSize;
	highContrast: boolean;
};

export const DEFAULT_DISPLAY_PREFERENCES: Readonly<DisplayPreferences> = {
	accentTheme: "teal",
	readingSize: "standard",
	highContrast: false,
};

type DisplayStorage = Pick<Storage, "getItem" | "setItem">;

export function displayPreferencesKey(
	userId: string | null | undefined,
): string | null {
	return userId ? `ditero.display.${userId}` : null;
}

export function parseDisplayPreferences(
	raw: string | null,
): DisplayPreferences {
	try {
		const value: unknown = raw ? JSON.parse(raw) : null;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const { readingSize, highContrast, accentTheme } = value as Record<
				string,
				unknown
			>;
			if (
				READING_SIZES.some((size) => size === readingSize) &&
				typeof highContrast === "boolean"
			)
				return {
					readingSize: readingSize as ReadingSize,
					highContrast,
					accentTheme: ACCENT_THEMES.some((theme) => theme === accentTheme)
						? (accentTheme as AccentTheme)
						: "teal",
				};
		}
	} catch {
		// Invalid stored settings use the same defaults as a new account.
	}
	return { ...DEFAULT_DISPLAY_PREFERENCES };
}

function defaultStorage(): DisplayStorage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function readDisplayPreferences(
	userId: string | null | undefined,
	storage: DisplayStorage | null = defaultStorage(),
): DisplayPreferences {
	const key = displayPreferencesKey(userId);
	if (key && storage) {
		try {
			return parseDisplayPreferences(storage.getItem(key));
		} catch {
			// Locked-down storage must not prevent sign-in.
		}
	}
	return { ...DEFAULT_DISPLAY_PREFERENCES };
}

export function writeDisplayPreferences(
	userId: string | null | undefined,
	preferences: DisplayPreferences,
	storage: DisplayStorage | null = defaultStorage(),
): boolean {
	const key = displayPreferencesKey(userId);
	if (!key || !storage) return false;
	try {
		storage.setItem(key, JSON.stringify(preferences));
		return true;
	} catch {
		return false;
	}
}

export function applyDisplayPreferences(
	preferences: DisplayPreferences,
	root: Pick<HTMLElement, "dataset">,
): void {
	root.dataset.accentTheme = preferences.accentTheme;
	root.dataset.readingSize = preferences.readingSize;
	root.dataset.highContrast = String(preferences.highContrast);
}
