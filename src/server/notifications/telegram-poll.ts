// Telegram's poll transport: getUpdates long polling, outbound only, so a
// self-hosted deployment behind NAT needs no public URL and no certificate.
// That is why it is the default.
//
// Three things make it more than a loop:
//
// 1. Only ONE replica may poll. Telegram hands each update to whoever asks
//    first, so a second poller consumes half the acks into a process that then
//    confirms them away. Leadership is the M3a advisory lock (withLeaderLock,
//    scheduler.ts) under its own key -- reused, not reimplemented. A distinct
//    key because the section here is held for the process's whole life, and
//    sharing the scheduler's key would starve every scan tick.
// 2. getUpdates DOES NOT WORK while a webhook is set (design 2). So the
//    transport is reconciled at the provider before polling starts:
//    deleteWebhook in poll mode, setWebhook in webhook mode. A half-switched
//    deployment receives nothing, silently, which is why every reconcile is
//    logged.
// 3. The offset is NOT persisted. Telegram treats an update as confirmed once
//    getUpdates is called with a higher offset, so restart safety is the
//    provider's: a restarted poller asks with no offset and is handed only what
//    was never confirmed. A local cursor table would add a second source of
//    truth that can only ever disagree.
//
// Handling an update is telegram-update.ts, shared verbatim with the webhook
// listener.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
	type TelegramMode,
	telegramMode,
	telegramPollTiming,
} from "../../config/telegram.ts";
import type * as tables from "../../db/schema.ts";
import type { safeFetch as SafeFetch } from "../../security/safe-http.ts";
import { safeFetch } from "../../security/safe-http.ts";
import { ackBaseUrl } from "./capability.ts";
import { withLeaderLock } from "./scheduler.ts";
import {
	botApiUrl,
	botLabel,
	handleTelegramUpdate,
	telegramChannels,
} from "./telegram-update.ts";
import { TELEGRAM_WEBHOOK_PATH } from "./telegram-webhook.ts";

type Database = NodePgDatabase<typeof tables>;

export const TELEGRAM_POLL_LOCK_KEY = 918276;

// How long a non-leader waits before trying the lock again, and how long the
// leader idles when there is nothing to poll.
export const DEFAULT_IDLE_MS = 5_000;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;
// One getUpdates batch. Telegram's own cap is 100.
const UPDATE_LIMIT = 50;
const RESPONSE_MAX_BYTES = 1_048_576;
// Everything else (messages, joins, edits) is noise this app has no use for,
// and asking for it would spend the batch budget on updates we discard.
const ALLOWED_UPDATES = ["callback_query"];

export type TelegramPollOptions = {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof SafeFetch;
	mode?: TelegramMode;
	longPollSec?: number;
	maxBots?: number;
	idleMs?: number;
	backoffBaseMs?: number;
	backoffMaxMs?: number;
};

export type TelegramPoller = { stop(): Promise<void> };

// Deterministic (no jitter): one poller holds the lock, so there is no herd to
// spread out, and a predictable ladder is one a test can assert.
export function pollBackoffMs(
	failures: number,
	baseMs: number,
	maxMs: number,
): number {
	const exponent = Math.min(Math.max(failures, 1) - 1, 20);
	return Math.min(maxMs, baseMs * 2 ** exponent);
}

type Envelope = { ok: boolean; result?: unknown; description?: string };

function updateId(update: unknown): number | null {
	const id = (update as { update_id?: unknown } | null)?.update_id;
	return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

export function startTelegramPoller(
	database: Database,
	pool: Pool,
	options: TelegramPollOptions = {},
): TelegramPoller {
	const env = options.env ?? process.env;
	const mode = options.mode ?? telegramMode(env);
	const timing = telegramPollTiming(env);
	const longPollSec = options.longPollSec ?? timing.longPollSec;
	const maxBots = options.maxBots ?? timing.maxBots;
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
	const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
	const backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
	const send = options.fetch ?? safeFetch;

	const abort = new AbortController();
	const wakers = new Set<() => void>();
	let stopped = false;

	// Interruptible: stop() must not wait out a 60s backoff, and it must not
	// leave a timer holding the process open either.
	function sleep(ms: number): Promise<void> {
		if (stopped) return Promise.resolve();
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				wakers.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			wakers.add(wake);
		});
	}

	// Per bot token. Both are in-memory by design: see (3) in the header.
	const offsets = new Map<string, number>();
	const failures = new Map<string, number>();
	const nextAttemptAt = new Map<string, number>();
	const reconciled = new Set<string>();
	let cappedWarned = false;

	async function botRequest(
		botToken: string,
		method: string,
		payload: Record<string, unknown>,
		headersTimeoutMs?: number,
	): Promise<Envelope | null> {
		const url = botApiUrl(botToken, method);
		if (!url) return null;
		try {
			const response = await send(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: abort.signal,
				maxResponseBytes: RESPONSE_MAX_BYTES,
				...(headersTimeoutMs === undefined ? {} : { headersTimeoutMs }),
			});
			const parsed: unknown = JSON.parse(await response.text());
			return parsed && typeof parsed === "object" ? (parsed as Envelope) : null;
		} catch {
			// Never the URL and never the error: both carry the bot token.
			return null;
		}
	}

	// Poll and webhook are mutually exclusive at the provider, so whichever one
	// this deployment is not using has to be actively torn down.
	async function reconcile(botToken: string): Promise<void> {
		if (reconciled.has(botToken)) return;
		const label = botLabel(botToken);
		if (mode === "poll") {
			const envelope = await botRequest(botToken, "deleteWebhook", {});
			if (!envelope?.ok) {
				console.error(
					`telegram: bot ${label} could not clear its webhook; getUpdates does not work while one is set, so this bot receives no acks until it succeeds`,
				);
				return;
			}
			reconciled.add(botToken);
			console.log(`telegram: bot ${label} webhook cleared, polling for acks`);
			return;
		}

		const baseUrl = ackBaseUrl(env);
		const secret = env.DITERO_TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
		if (!baseUrl || !secret) {
			console.error(
				`telegram: bot ${label} cannot register a webhook without ${baseUrl ? "DITERO_TELEGRAM_WEBHOOK_SECRET" : "DITERO_PUBLIC_URL (or BETTER_AUTH_URL)"}; no acks will arrive`,
			);
			return;
		}
		const url = `${baseUrl.replace(/\/+$/, "")}${TELEGRAM_WEBHOOK_PATH}`;
		const envelope = await botRequest(botToken, "setWebhook", {
			url,
			secret_token: secret,
			allowed_updates: ALLOWED_UPDATES,
		});
		if (!envelope?.ok) {
			console.error(
				`telegram: bot ${label} setWebhook to ${url} failed; no acks will arrive`,
			);
			return;
		}
		reconciled.add(botToken);
		console.log(`telegram: bot ${label} webhook set to ${url}`);
	}

	function fail(botToken: string, reason: string): void {
		const count = (failures.get(botToken) ?? 0) + 1;
		failures.set(botToken, count);
		const waitMs = pollBackoffMs(count, backoffBaseMs, backoffMaxMs);
		nextAttemptAt.set(botToken, Date.now() + waitMs);
		console.warn(
			`telegram: bot ${botLabel(botToken)} getUpdates ${reason}; retrying in ${waitMs}ms`,
		);
	}

	async function pollBot(botToken: string): Promise<void> {
		const offset = offsets.get(botToken);
		const envelope = await botRequest(
			botToken,
			"getUpdates",
			{
				timeout: longPollSec,
				limit: UPDATE_LIMIT,
				allowed_updates: ALLOWED_UPDATES,
				...(offset === undefined ? {} : { offset }),
			},
			// The provider withholds headers for the whole poll window on purpose.
			(longPollSec + 5) * 1_000,
		);
		if (stopped) return;
		if (!envelope?.ok || !Array.isArray(envelope.result)) {
			fail(botToken, envelope ? "was refused" : "failed");
			return;
		}
		failures.delete(botToken);
		nextAttemptAt.delete(botToken);

		let highest: number | null = null;
		for (const update of envelope.result) {
			const id = updateId(update);
			if (id !== null && (highest === null || id > highest)) highest = id;
			try {
				await handleTelegramUpdate(database, update, send, env);
			} catch (error) {
				console.error("telegram: poll update failed:", error);
			}
		}
		// After handling, never before: the offset is what confirms the batch away
		// at the provider, so advancing it first would turn a crash mid-batch into
		// a lost ack instead of the duplicate the engine already tolerates.
		if (highest !== null) offsets.set(botToken, highest + 1);
	}

	function botTokens(channels: { botToken: string }[]): string[] {
		const tokens = [...new Set(channels.map((row) => row.botToken))];
		if (tokens.length > maxBots && !cappedWarned) {
			cappedWarned = true;
			console.warn(
				`telegram: ${tokens.length} distinct bots configured, polling the first ${maxBots} (DITERO_TELEGRAM_MAX_BOTS); the rest receive no acks`,
			);
		}
		return tokens.slice(0, maxBots);
	}

	async function pollCycle(tokens: string[]): Promise<void> {
		const now = Date.now();
		const eligible = tokens.filter(
			(token) => (nextAttemptAt.get(token) ?? 0) <= now,
		);
		// Every bot is backing off. Without this the loop would spin at full speed
		// against a provider that is already failing -- the long poll is the only
		// thing that paces a healthy cycle.
		if (eligible.length === 0) {
			const soonest = Math.min(
				...tokens.map((token) => nextAttemptAt.get(token) ?? now),
			);
			await sleep(Math.max(1, Math.min(soonest - now, backoffMaxMs)));
			return;
		}
		await Promise.all(eligible.map(pollBot));
	}

	async function leaderSession(): Promise<void> {
		while (!stopped) {
			const channels = await telegramChannels(database, env);
			const tokens = botTokens(channels);
			for (const token of tokens) {
				if (stopped) return;
				await reconcile(token);
			}
			// Webhook mode holds leadership only to keep the provider registration
			// reconciled as channels are added; nothing polls.
			if (tokens.length === 0 || mode === "webhook") {
				await sleep(idleMs);
				continue;
			}
			await pollCycle(tokens);
		}
	}

	const running = (async () => {
		console.log(
			mode === "poll"
				? "telegram: transport=poll (long polling, outbound only)"
				: "telegram: transport=webhook (inbound; the public listener must be reachable)",
		);
		while (!stopped) {
			try {
				const held = await withLeaderLock(
					pool,
					TELEGRAM_POLL_LOCK_KEY,
					leaderSession,
				);
				if (held === null && !stopped) await sleep(idleMs);
			} catch (error) {
				console.error("telegram: poll loop failed:", error);
				await sleep(idleMs);
			}
		}
	})();

	return {
		async stop() {
			stopped = true;
			abort.abort();
			for (const wake of [...wakers]) wake();
			await running;
		},
	};
}
