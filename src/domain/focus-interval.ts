// The server accepts a finished interval only after it has itself observed the
// full duration plus reported pauses within its exclusive span. An early
// arrival is retryable, so the wait rides in the message like a mutator error
// code: a server rejection reaches the client as a plain string.

export const FOCUS_RETRY_CAP_MS = 24 * 60 * 60 * 1000;

// Credit never exceeds the server-observed exclusive span.
export function focusRequiredMs(durationSec: number, pausedMs = 0): number {
	return durationSec * 1000 + pausedMs;
}

export class FocusEarlyError extends Error {
	constructor(readonly waitMs: number) {
		super(`focus interval not complete on the server [focus-early:${waitMs}]`);
		this.name = "FocusEarlyError";
	}
}

const EARLY_RE = /\[focus-early:(\d{1,10})\]$/;

/** Milliseconds until the server would accept the interval, or null. */
export function focusEarlyWaitMs(e: unknown): number | null {
	const message =
		e instanceof Error ? e.message : typeof e === "string" ? e : "";
	const wait = message.match(EARLY_RE)?.[1];
	return wait === undefined ? null : Math.min(Number(wait), FOCUS_RETRY_CAP_MS);
}

// Two tabs can log the same finished interval at once; the loser fails on the
// primary key of the interval's single session row, which still means recorded.
const DUPLICATE_RE = /focus_session_pkey/;

export function isFocusDuplicate(e: unknown): boolean {
	if (typeof e === "object" && e !== null) {
		const detail = e as { code?: unknown; constraint?: unknown };
		if (detail.code !== undefined && detail.code !== "23505") return false;
		if (detail.constraint !== undefined)
			return detail.constraint === "focus_session_pkey";
	}
	// Zero transports application errors as strings, without PostgreSQL fields.
	const message =
		e instanceof Error ? e.message : typeof e === "string" ? e : "";
	return DUPLICATE_RE.test(message);
}
