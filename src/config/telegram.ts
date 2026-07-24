import { positiveInt } from "./env.ts";

export type TelegramMode = "poll" | "webhook";

// Long polling is the default because the product is self-hosted: it is
// outbound-only, so it needs no public URL, no certificate and no port forward.
export const DEFAULT_TELEGRAM_MODE: TelegramMode = "poll";
export const DEFAULT_LONG_POLL_SEC = 25;
// A getUpdates connection is held open per bot for the whole long poll, so this
// bounds concurrent sockets, not a plausible bot count. See telegram-poll.ts for
// why the poller polls every configured bot rather than one.
export const DEFAULT_MAX_BOTS = 10;
// Above this the connection is more likely to be reaped by an intermediary than
// to return an update, and every reap is a wasted round trip.
const MAX_LONG_POLL_SEC = 60;

export function telegramMode(
	env: Record<string, string | undefined>,
): TelegramMode {
	const raw = env.DITERO_TELEGRAM_MODE?.trim();
	if (!raw) return DEFAULT_TELEGRAM_MODE;
	if (raw === "poll" || raw === "webhook") return raw;
	throw new Error(
		`DITERO_TELEGRAM_MODE: expected "poll" or "webhook", got "${raw}"`,
	);
}

export type TelegramPollTiming = {
	longPollSec: number;
	maxBots: number;
};

export function telegramPollTiming(
	env: Record<string, string | undefined>,
): TelegramPollTiming {
	const longPollSec = positiveInt(
		"DITERO_TELEGRAM_POLL_TIMEOUT_SEC",
		env.DITERO_TELEGRAM_POLL_TIMEOUT_SEC,
		DEFAULT_LONG_POLL_SEC,
	);
	if (longPollSec > MAX_LONG_POLL_SEC) {
		throw new Error(
			`DITERO_TELEGRAM_POLL_TIMEOUT_SEC (${longPollSec}) must be at most ${MAX_LONG_POLL_SEC}`,
		);
	}
	return {
		longPollSec,
		maxBots: positiveInt(
			"DITERO_TELEGRAM_MAX_BOTS",
			env.DITERO_TELEGRAM_MAX_BOTS,
			DEFAULT_MAX_BOTS,
		),
	};
}
