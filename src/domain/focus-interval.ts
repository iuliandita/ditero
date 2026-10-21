// The server accepts a finished interval only after it has itself observed the
// full duration (plus reported pauses) since the start it recorded. An early
// arrival is retryable, so the wait rides in the message like a mutator error
// code: a server rejection reaches the client as a plain string.

export const FOCUS_RETRY_CAP_MS = 24 * 60 * 60 * 1000;

// Network latency can make the server see the start later than the client's
// countdown began; the allowance stays far below a forward clock jump.
const SLACK_MAX_MS = 5000;

/** Server-observed time that must pass between start and completion. */
export function focusRequiredMs(durationSec: number, pausedMs = 0): number {
	const duration = durationSec * 1000;
	return duration - Math.min(SLACK_MAX_MS, duration * 0.2) + pausedMs;
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
	const message =
		e instanceof Error ? e.message : typeof e === "string" ? e : "";
	return DUPLICATE_RE.test(message);
}
