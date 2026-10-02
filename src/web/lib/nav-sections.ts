import { useCallback, useEffect, useState } from "react";

// An absent choice follows the content: empty advanced groups fold away. An
// explicit choice survives new items, reloads, and switches between surfaces.
export type NavSection = "views" | "dashboards";
export type NavSectionPreferences = Partial<Record<NavSection, boolean>>;
const SECTIONS: readonly NavSection[] = ["views", "dashboards"];

export function navSectionsKey(userId: string): string {
	return `ditero.nav.collapsed.${userId}`;
}

export function parseNavSections(raw: string | null): NavSectionPreferences {
	if (!raw) return {};
	try {
		const value: unknown = JSON.parse(raw);
		// Earlier versions saved the complete collapsed set, including [] when
		// the user deliberately expanded every group. Preserve both choices.
		if (Array.isArray(value)) {
			return {
				views: !value.includes("views"),
				dashboards: !value.includes("dashboards"),
			};
		}
		if (typeof value !== "object" || value === null) return {};
		const preferences: NavSectionPreferences = {};
		for (const section of SECTIONS) {
			if (Object.hasOwn(value, section)) {
				const open = (value as Record<string, unknown>)[section];
				if (typeof open === "boolean") preferences[section] = open;
			}
		}
		return preferences;
	} catch {
		return {};
	}
}

export function readNavSections(
	userId: string,
	storage: Pick<Storage, "getItem"> | null = safeStorage(),
): NavSectionPreferences {
	try {
		return parseNavSections(storage?.getItem(navSectionsKey(userId)) ?? null);
	} catch {
		return {};
	}
}

export function writeNavSections(
	userId: string,
	preferences: NavSectionPreferences,
	storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
	try {
		storage?.setItem(navSectionsKey(userId), JSON.stringify(preferences));
	} catch {
		// Private mode or blocked storage: the toggle still works for this visit.
	}
}

export function navSectionOpen(
	preferences: NavSectionPreferences,
	section: NavSection,
	hasItems: boolean,
): boolean {
	return preferences[section] ?? hasItems;
}

export function toggleNavSection(
	preferences: NavSectionPreferences,
	section: NavSection,
	hasItems: boolean,
): NavSectionPreferences {
	return {
		...preferences,
		[section]: !navSectionOpen(preferences, section, hasItems),
	};
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function useNavSections(storageScope: string | null | undefined): {
	isOpen: (section: NavSection, hasItems?: boolean) => boolean;
	toggle: (section: NavSection, hasItems?: boolean) => void;
} {
	const [preferences, setPreferences] = useState<NavSectionPreferences>(() =>
		storageScope ? readNavSections(storageScope) : {},
	);
	useEffect(() => {
		setPreferences(storageScope ? readNavSections(storageScope) : {});
	}, [storageScope]);
	const toggle = useCallback(
		(section: NavSection, hasItems = true) => {
			setPreferences((prev) => {
				const next = toggleNavSection(prev, section, hasItems);
				if (storageScope) writeNavSections(storageScope, next);
				return next;
			});
		},
		[storageScope],
	);
	const isOpen = useCallback(
		(section: NavSection, hasItems = true) =>
			navSectionOpen(preferences, section, hasItems),
		[preferences],
	);
	return { isOpen, toggle };
}
