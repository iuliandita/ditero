export type BrowserSessionIdentity = {
	userId: string;
	expiresAt: number;
};

// One active account per origin; Zero continues to scope its store by userID.
export const BROWSER_SESSION_KEY = "ditero.browser-session.v1";
export const BROWSER_SESSION_CHANGED = "ditero-browser-session-changed";

export function readBrowserSession(): BrowserSessionIdentity | null {
	try {
		const value = JSON.parse(
			localStorage.getItem(BROWSER_SESSION_KEY) ?? "null",
		);
		if (
			typeof value?.userId !== "string" ||
			!value.userId ||
			!Number.isSafeInteger(value.expiresAt)
		)
			return null;
		return { userId: value.userId, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}

export function rememberBrowserSession(
	identity: BrowserSessionIdentity | null,
): void {
	try {
		if (identity)
			localStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify(identity));
		else localStorage.removeItem(BROWSER_SESSION_KEY);
	} catch {
		// Storage denial disables offline startup; it never creates an identity.
	}
	if (typeof window !== "undefined")
		window.dispatchEvent(new Event(BROWSER_SESSION_CHANGED));
}

export function forgetBrowserSession(userId: string): void {
	if (readBrowserSession()?.userId === userId) rememberBrowserSession(null);
}

export function isSessionRefusal(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		(error.status === 401 || error.status === 403)
	);
}

export function canRestoreBrowserSession({
	error,
	identity,
	online,
	secure,
	now = Date.now(),
}: {
	error: unknown;
	identity: BrowserSessionIdentity | null;
	online: boolean;
	secure: boolean;
	now?: number;
}): boolean {
	// Fetch hides TLS failures behind TypeError too. Only an explicitly offline
	// browser may use cached evidence; HTTP responses never authorize fallback.
	return (
		error instanceof TypeError &&
		!online &&
		secure &&
		identity !== null &&
		identity.expiresAt > now
	);
}
