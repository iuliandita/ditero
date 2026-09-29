// Contextual hints the app retires once they have done their job. Kept per
// user in localStorage rather than user_pref: a hint reappearing on a second
// device costs a glance, and a synced column would cost a migration for state
// nobody else reads.

export type Hints = {
	/** Quick adds that carried at least one parsed token. */
	syntaxUses: number;
	syntaxDismissed: boolean;
	shortcutsSeen: boolean;
};

export const SYNTAX_HINT_USES = 3;

export const FRESH_HINTS: Hints = {
	syntaxUses: 0,
	syntaxDismissed: false,
	shortcutsSeen: false,
};

// Before the session resolves there is no user to key on: show nothing rather
// than flash a fresh hint from a shared bucket.
export const NO_USER_HINTS: Hints = {
	syntaxUses: SYNTAX_HINT_USES,
	syntaxDismissed: true,
	shortcutsSeen: true,
};

type KeyValue = Pick<Storage, "getItem" | "setItem">;

export const hintsKey = (userId: string): string => `ditero.hints.${userId}`;

// Tolerant by design: storage is client-writable, so anything unreadable
// resolves to a fresh state rather than a crash or a permanently hidden hint.
export function parseHints(raw: string | null): Hints {
	if (!raw) return FRESH_HINTS;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return FRESH_HINTS;
	}
	if (typeof value !== "object" || value === null) return FRESH_HINTS;
	const v = value as Record<string, unknown>;
	const uses = v.syntaxUses;
	return {
		syntaxUses:
			typeof uses === "number" && Number.isInteger(uses) && uses > 0
				? Math.min(uses, SYNTAX_HINT_USES)
				: 0,
		syntaxDismissed: v.syntaxDismissed === true,
		shortcutsSeen: v.shortcutsSeen === true,
	};
}

export function readHints(userId: string, storage: KeyValue | null): Hints {
	try {
		return parseHints(storage?.getItem(hintsKey(userId)) ?? null);
	} catch {
		return FRESH_HINTS;
	}
}

export function writeHints(
	userId: string,
	hints: Hints,
	storage: KeyValue | null,
): void {
	try {
		storage?.setItem(hintsKey(userId), JSON.stringify(hints));
	} catch {
		// Non-fatal: the change still applies for this page.
	}
}

export const syntaxHintVisible = (h: Hints): boolean =>
	!h.syntaxDismissed && h.syntaxUses < SYNTAX_HINT_USES;

// A touch-only device has no keyboard to press `?` on.
export const shortcutHintVisible = (h: Hints, finePointer: boolean): boolean =>
	finePointer && !h.shortcutsSeen;

export function recordSyntaxUse(h: Hints, tokenCount: number): Hints {
	if (tokenCount <= 0 || h.syntaxUses >= SYNTAX_HINT_USES) return h;
	return { ...h, syntaxUses: h.syntaxUses + 1 };
}

export const dismissSyntaxHint = (h: Hints): Hints =>
	h.syntaxDismissed ? h : { ...h, syntaxDismissed: true };

export const markShortcutsSeen = (h: Hints): Hints =>
	h.shortcutsSeen ? h : { ...h, shortcutsSeen: true };

export type SyntaxToken = {
	type: "date" | "priority" | "label" | "list";
	token: string;
};

// The tokens the hint advertises, in the order the legend shows them. The date
// example only appears where the locale has a date parser; `word` is the
// translated stand-in after a sigil.
export function syntaxTokens(
	dateWord: string | null,
	word: string,
): SyntaxToken[] {
	return [
		...(dateWord ? [{ type: "date" as const, token: dateWord }] : []),
		{ type: "priority", token: "p1" },
		{ type: "label", token: `#${word}` },
		{ type: "list", token: `~${word}` },
	];
}

// Store: one snapshot per user, shared by every mounted consumer so a use
// counted in the quick-add sheet retires the inline hint in the same render.
export function createHintStore(storage: () => KeyValue | null) {
	const cache = new Map<string, Hints>();
	const listeners = new Set<() => void>();
	return {
		get(userId: string): Hints {
			if (!userId) return NO_USER_HINTS;
			let h = cache.get(userId);
			if (!h) {
				h = readHints(userId, storage());
				cache.set(userId, h);
			}
			return h;
		},
		update(userId: string, fn: (h: Hints) => Hints): void {
			if (!userId) return;
			const prev = this.get(userId);
			const next = fn(prev);
			if (next === prev) return;
			cache.set(userId, next);
			writeHints(userId, next, storage());
			for (const l of listeners) l();
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
