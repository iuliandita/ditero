import { useCallback, useEffect, useState } from "react";

// Views and Dashboards fold away in the sidebar and the mobile Lists tab. The
// choice is a per-viewer convenience, so it lives in browser storage keyed by
// user; a blocked or empty store just means every section starts open.
export type NavSection = "views" | "dashboards";
const SECTIONS: readonly NavSection[] = ["views", "dashboards"];

export function navSectionsKey(userId: string): string {
	return `ditero.nav.collapsed.${userId}`;
}

export function parseCollapsed(raw: string | null): Set<NavSection> {
	if (!raw) return new Set();
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return new Set();
		return new Set(SECTIONS.filter((section) => value.includes(section)));
	} catch {
		return new Set();
	}
}

export function readCollapsed(
	userId: string,
	storage: Pick<Storage, "getItem"> | null = safeStorage(),
): Set<NavSection> {
	try {
		return parseCollapsed(storage?.getItem(navSectionsKey(userId)) ?? null);
	} catch {
		return new Set();
	}
}

export function writeCollapsed(
	userId: string,
	collapsed: Set<NavSection>,
	storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
	try {
		storage?.setItem(navSectionsKey(userId), JSON.stringify([...collapsed]));
	} catch {
		// Private mode or blocked storage: the toggle still works for this visit.
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function useNavSections(userId: string | null | undefined): {
	isOpen: (section: NavSection) => boolean;
	toggle: (section: NavSection) => void;
} {
	const [collapsed, setCollapsed] = useState<Set<NavSection>>(() =>
		userId ? readCollapsed(userId) : new Set(),
	);
	useEffect(() => {
		if (userId) setCollapsed(readCollapsed(userId));
	}, [userId]);
	const toggle = useCallback(
		(section: NavSection) => {
			setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(section)) next.delete(section);
				else next.add(section);
				if (userId) writeCollapsed(userId, next);
				return next;
			});
		},
		[userId],
	);
	const isOpen = useCallback(
		(section: NavSection) => !collapsed.has(section),
		[collapsed],
	);
	return { isOpen, toggle };
}
