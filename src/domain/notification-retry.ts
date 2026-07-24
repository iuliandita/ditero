export type ProviderResult =
	| { ok: true; status: number }
	| {
			ok: false;
			status?: number;
			retryAfterSec?: number;
			// Set by the safeFetch adapter (Task 12) when a request was refused
			// by policy before it ever reached the network -- blocked address,
			// disallowed protocol, oversized response. Never worth retrying.
			policyRejected?: boolean;
			error: string;
	  };

export type RetryClass =
	| "ok"
	| "client"
	| "server"
	| "transport"
	| "throttled"
	| "exhausted"
	| "unexpected-status"
	| "policy";

// User-safe channel-health categories. Closed by construction (a Postgres enum
// backs the column) so a provider error body -- which can carry the bot token or
// webhook secret out of the URL that produced it -- is structurally unable to
// reach a synced column. The raw text stays in delivery_attempt.error, redacted
// and server-only.
export const CHANNEL_ERROR_CODES = [
	"auth",
	"not_found",
	"rate_limited",
	"policy",
	"transport",
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

export type RetryDecision =
	| { kind: "done"; retryClass: RetryClass }
	| { kind: "retry"; delayMs: number; retryClass: RetryClass }
	| { kind: "permanent"; retryClass: RetryClass };

// Delay ladder: BASE_DELAY_MS doubling each attempt, capped at MAX_DELAY_MS,
// for attempts 1..MAX_ATTEMPTS-1 (attempt MAX_ATTEMPTS itself triggers
// "exhausted" with no further wait). With BASE_DELAY_MS=1s, MAX_DELAY_MS=5min:
//   attempts 1-9  (uncapped, doubling): 1+2+4+8+16+32+64+128+256 = 511s
//   attempts 10-14 (capped at 300s x5):                            1500s
//   total wall-clock budget before abandonment:                   2011s (~33.5 min)
// The cap first engages at attempt 10 (raw 512s >= 300s) and holds flat
// through attempt 14, so the tail is a steady 5-minute poll rather than
// continued growth. This comfortably outlives an ordinary restart or brief
// LAN blip (self-hosted ntfy on the same box/LAN; a container update or a
// Postgres restart is usually well under a couple of minutes) without
// holding a reminder past its usefulness window (a meds reminder six hours
// late is worse than one not delivered at all -- see the M3 disclaimer).
// If you change any of the three constants below, recompute this sum and
// update the comment -- it's exactly what the cumulative-span test below
// pins.
//
// Outbox worker note: this ladder only changes the wait *between* attempts,
// not the per-attempt cost. Each attempt still holds its outbox row in
// "sending" for at most the adapter's own fetch deadline (Task 12), and the
// worker's lease timeout only needs to exceed that single-attempt deadline,
// same as before this change. A longer ladder means more attempts over a
// longer total span, not longer-held leases.
export const MAX_ATTEMPTS = 15;
// See MAX_ATTEMPTS comment for the resulting cumulative span.
const BASE_DELAY_MS = 1_000;
// See MAX_ATTEMPTS comment for the resulting cumulative span. Also the
// clamp ceiling for attacker-influenced Retry-After values below.
const MAX_DELAY_MS = 300_000;

function backoff(attempt: number, jitter: number): number {
	const raw = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
	return Math.round(raw + raw * 0.25 * jitter);
}

// Retry-After comes from a remote, possibly hostile or broken, server --
// the channel URL is user-supplied, so this value is untrusted. A garbage
// value (negative, NaN, or absurdly large) must not be able to park a
// notification indefinitely or produce an invalid next_attempt_at. Treat
// anything outside [0, MAX_DELAY_MS/1000] as unusable and fall back to the
// same backoff a plain 429 without Retry-After would get, rather than
// trusting the remote unconditionally.
function retryAfterMs(
	retryAfterSec: number,
	attempt: number,
	jitter: number,
): number {
	if (!Number.isFinite(retryAfterSec) || retryAfterSec < 0) {
		return backoff(attempt, jitter);
	}
	return Math.min(Math.round(retryAfterSec * 1_000), MAX_DELAY_MS);
}

// `jitter` is a caller-supplied 0..1 value so the decision stays pure and testable;
// the worker passes Math.random(). Jitter only ever adds up to 25% on top of the
// base delay (never subtracts), so it spreads retries later but not earlier --
// a deliberate simplification kept for this module; a true thundering-herd
// mitigation (AWS "full jitter": random in [0, cap]) would need the caller
// contract to change, which none of the callers require yet.
export function classifyRetry(
	result: ProviderResult,
	attempt: number,
	jitter: number,
): RetryDecision {
	if (!Number.isInteger(attempt) || attempt < 1) {
		throw new Error(
			`notification-retry: invalid attempt ${attempt}, expected a positive integer`,
		);
	}
	if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
		throw new Error(
			`notification-retry: invalid jitter ${jitter}, expected a number in [0, 1]`,
		);
	}

	if (result.ok) return { kind: "done", retryClass: "ok" };
	if (result.policyRejected) return { kind: "permanent", retryClass: "policy" };

	const status = result.status;
	if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
		return { kind: "permanent", retryClass: "client" };
	}
	if (attempt >= MAX_ATTEMPTS) {
		return { kind: "permanent", retryClass: "exhausted" };
	}
	if (status === 429) {
		const delayMs =
			result.retryAfterSec !== undefined
				? retryAfterMs(result.retryAfterSec, attempt, jitter)
				: backoff(attempt, jitter);
		return { kind: "retry", delayMs, retryClass: "throttled" };
	}

	// Everything else that reaches here is a 5xx, a transport-level failure
	// (no status at all), or a status this module doesn't model (1xx, 3xx,
	// >=600, or a literal 0). safeFetch doesn't follow redirects, so a 3xx is
	// reachable in practice (a misconfigured channel URL behind a redirect).
	// None of these are ours to declare permanent -- only a genuine 4xx (or
	// exhaustion) earns that -- so they all retry; only the label narrows.
	let retryClass: RetryClass;
	if (status === undefined) retryClass = "transport";
	else if (status >= 500 && status < 600) retryClass = "server";
	else retryClass = "unexpected-status";

	return { kind: "retry", delayMs: backoff(attempt, jitter), retryClass };
}

// Channel health, not attempt bookkeeping: only a decision the worker will never
// retry says anything about the channel itself. A retryable failure returns null
// so a transient 503 does not flip a working channel to "broken" for the ~33
// minutes the ladder still has to run.
//
// `status` narrows within a permanent class; the fallback differs by class
// because the two mean different things when the status is uninformative:
// a 4xx we cannot place is still the provider refusing the request ("policy"),
// while exhaustion is by construction 5xx/network/no-status ("transport").
export function channelErrorCode(
	decision: RetryDecision,
	status: number | undefined,
): ChannelErrorCode | null {
	if (decision.kind !== "permanent") return null;
	if (decision.retryClass === "policy") return "policy";

	if (status === 401 || status === 403 || status === 407) return "auth";
	if (status === 404 || status === 410) return "not_found";
	if (status === 429) return "rate_limited";
	return decision.retryClass === "exhausted" ? "transport" : "policy";
}
