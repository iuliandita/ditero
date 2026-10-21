import { randomId } from "../../domain/random-id.ts";

export class SessionExpiredError extends Error {}

let generation = 0;
export function browserSessionStorageGeneration(): string | null {
	try {
		return localStorage.getItem(BROWSER_SESSION_GENERATION_KEY) ?? null;
	} catch {
		return "unavailable";
	}
}
export function browserSessionGeneration(): string {
	return `${generation}:${browserSessionStorageGeneration() ?? ""}`;
}
export function invalidateBrowserSessionRequests(): void {
	generation++;
}

export type BrowserSessionIdentity = {
	userId: string;
	expiresAt: number;
};

// One active account per origin; Zero continues to scope its store by userID.
export const BROWSER_SESSION_KEY = "ditero.browser-session.v1";
export const BROWSER_SESSION_GENERATION_KEY =
	"ditero.browser-session-generation.v1";
export const BROWSER_SESSION_CHANGED = "ditero-browser-session-changed";

export function readBrowserSession(): BrowserSessionIdentity | null {
	try {
		const value = JSON.parse(
			localStorage.getItem(BROWSER_SESSION_KEY) ?? "null",
		);
		if (
			typeof value?.userId !== "string" ||
			!value.userId ||
			!Number.isSafeInteger(value.expiresAt) ||
			(value.generation ?? null) !==
				(localStorage.getItem(BROWSER_SESSION_GENERATION_KEY) ?? null)
		)
			return null;
		return { userId: value.userId, expiresAt: value.expiresAt };
	} catch {
		return null;
	}
}

export function rememberBrowserSession(
	identity: BrowserSessionIdentity | null,
	epoch = browserSessionGeneration(),
): void {
	const persistedGeneration = browserSessionStorageGeneration();
	if (epoch !== browserSessionGeneration()) return;
	try {
		if (identity)
			localStorage.setItem(
				BROWSER_SESSION_KEY,
				JSON.stringify({
					...identity,
					generation: persistedGeneration,
				}),
			);
		else localStorage.removeItem(BROWSER_SESSION_KEY);
	} catch {
		// Storage denial disables offline startup; it never creates an identity.
	}
	if (typeof window !== "undefined")
		window.dispatchEvent(new Event(BROWSER_SESSION_CHANGED));
}

export function forgetBrowserSession(userId?: string): void {
	const identity = readBrowserSession();
	if (userId && identity && identity.userId !== userId) return;
	invalidateBrowserSessionRequests();
	try {
		// Publish every invalidation, even when the identity was already removed.
		localStorage.setItem(BROWSER_SESSION_GENERATION_KEY, randomId());
	} catch {
		// Removing evidence still fails closed if storage cannot accept a fence.
	}
	rememberBrowserSession(null);
}

export function rejectBrowserSession(error: unknown, userId?: string): void {
	if (isSessionRefusal(error)) forgetBrowserSession(userId);
}

export function isSessionRefusal(error: unknown): boolean {
	return (
		error instanceof SessionExpiredError ||
		(typeof error === "object" &&
			error !== null &&
			"status" in error &&
			(error.status === 401 || error.status === 403)) ||
		(typeof error === "object" &&
			error !== null &&
			(("code" in error &&
				(error.code === "session-expired" || error.code === "auth-rejected")) ||
				("kind" in error &&
					(error.kind === "Unauthorized" ||
						error.kind === "AuthInvalidated")) ||
				("errorBody" in error &&
					error.errorBody !== error &&
					isSessionRefusal(error.errorBody))))
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
