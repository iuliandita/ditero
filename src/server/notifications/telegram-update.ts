// Telegram's inbound half, shared by both transports: the `Done` button minted
// by adapters/telegram.ts comes back as a callback_query, whether the webhook
// listener received it or the poller fetched it with getUpdates. Both hand the
// raw update to handleTelegramUpdate, so there is exactly one implementation of
// "given an update, ack it" -- two would drift, and the drift would be a
// transport that silently stops acking.
//
// This is a transport, not a second ack model -- consume-before-validate,
// single-use and sibling termination all live in redeemAckCapability.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../db/schema.ts";
import { channelConfigSchema } from "../../domain/notification-channel.ts";
import {
	channelKeyRing,
	decryptChannelConfig,
} from "../../security/channel-config.ts";
import type { safeFetch as SafeFetch } from "../../security/safe-http.ts";
import { ACK_CALLBACK_PREFIX, pathSegment } from "./adapters/telegram.ts";
import { redeemAckCapability } from "./capability.ts";

type Database = NodePgDatabase<typeof tables>;

export const API_ORIGIN = "https://api.telegram.org";
const API_DEADLINE_MS = 5_000;
const RESPONSE_MAX_BYTES = 16 * 1_024;
// reminder_state.acked_via is a channelKindEnum value for channel acks.
const ACK_VIA = "telegram";
const ACK_OK_TEXT = "Done.";
const ACK_FAIL_TEXT = "This reminder is no longer active.";
// Distinct from ACK_FAIL_TEXT on purpose: the reminder IS still active and the
// button still works, so telling the user it is over would be a lie.
const ACK_RETRY_TEXT = "Couldn't reach the server. Try again.";
const DONE_SUFFIX = "\n\n✓ Done";
// notification_channel is unique on (userId, kind), but a whole family or club
// binding ONE group chat is the supported topology, so this is a DoS guard, not
// a plausible group size: an evicted member's tap would burn their capability
// and leave the reminder escalating. Ordered so the truncation is at least
// deterministic if it ever does bite.
export const CANDIDATE_LIMIT = 500;

export type TelegramChannel = {
	userId: string;
	botToken: string;
	chatId: string;
};

type ParsedCallback = {
	callbackId: string;
	token: string;
	chatKeys: string[];
	chatId: number | string;
	messageId: number | null;
	messageText: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// Null for anything that is not one of our ack buttons: a non-callback update,
// a callback with no data, or data another bot feature minted.
export function parseAckCallback(update: unknown): ParsedCallback | null {
	const query = asRecord(asRecord(update)?.callback_query);
	if (!query) return null;
	const callbackId = query.id;
	const data = query.data;
	if (typeof callbackId !== "string" || typeof data !== "string") return null;
	if (!data.startsWith(ACK_CALLBACK_PREFIX)) return null;
	const token = data.slice(ACK_CALLBACK_PREFIX.length);
	if (!token) return null;

	const message = asRecord(query.message);
	const chat = asRecord(message?.chat);
	const chatId = chat?.id;
	if (typeof chatId !== "number" && typeof chatId !== "string") return null;
	const username = chat?.username;
	const chatKeys = [String(chatId).toLowerCase()];
	// Telegram usernames are case-insensitive, and a channel config may name the
	// chat either way (`-100123` or `@family`).
	if (typeof username === "string" && username) {
		chatKeys.push(`@${username.toLowerCase()}`);
	}
	const messageId = message?.message_id;
	const messageText = message?.text;
	return {
		callbackId,
		token,
		chatKeys,
		chatId,
		messageId: typeof messageId === "number" ? messageId : null,
		messageText: typeof messageText === "string" ? messageText : null,
	};
}

// Configured telegram channels, decrypted. `chatKeys` restricts to the chat a
// callback arrived from; without it this is every channel, which is what the
// poller needs to know which bots to poll.
export async function telegramChannels(
	database: Database,
	env: NodeJS.ProcessEnv,
	options: { chatKeys?: string[]; limit?: number } = {},
): Promise<TelegramChannel[]> {
	const rows = await database
		.select({
			userId: tables.notificationChannel.userId,
			config: tables.notificationChannel.config,
		})
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.kind, "telegram"),
				// chatId is a PUBLIC_FIELDS entry, so it is stored in cleartext and
				// can be matched in SQL rather than by decrypting every row.
				options.chatKeys
					? inArray(
							sql`lower(${tables.notificationChannel.config}->>'chatId')`,
							options.chatKeys,
						)
					: undefined,
			),
		)
		.orderBy(tables.notificationChannel.userId)
		.limit(options.limit ?? CANDIDATE_LIMIT);

	const ring = channelKeyRing(env);
	const channels: TelegramChannel[] = [];
	for (const row of rows) {
		let config: Record<string, unknown>;
		try {
			config = decryptChannelConfig(
				"telegram",
				row.config as Record<string, unknown>,
				ring,
			);
		} catch {
			continue;
		}
		const parsed = channelConfigSchema.telegram.safeParse(config);
		if (!parsed.success) continue;
		const { botToken, chatId } = parsed.data as {
			botToken: string;
			chatId: string;
		};
		channels.push({ userId: row.userId, botToken, chatId });
	}
	return channels;
}

// Null for a token that cannot form a request target at all: `pathSegment`
// throws on a lone surrogate, and an unencoded `/` would silently retarget the
// request.
export function botApiUrl(botToken: string, method: string): string | null {
	try {
		const url = `${API_ORIGIN}/bot${pathSegment(botToken)}/${method}`;
		new URL(url);
		return url;
	} catch {
		return null;
	}
}

// Bot id -- the part before the colon. Public by construction (it is the bot's
// @username's numeric twin) and the only part of a token safe to log.
export function botLabel(botToken: string): string {
	const separator = botToken.indexOf(":");
	return separator > 0 ? botToken.slice(0, separator) : "unknown";
}

export async function callBotApi(
	send: typeof SafeFetch,
	botToken: string,
	method: string,
	payload: Record<string, unknown>,
): Promise<void> {
	const url = botApiUrl(botToken, method);
	if (!url) return;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), API_DEADLINE_MS);
	try {
		await send(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: deadline.signal,
			maxResponseBytes: RESPONSE_MAX_BYTES,
		});
	} catch {
		// The method name only -- an error carrying the URL would carry the bot
		// token with it, and this line is the one an operator greps.
		console.warn(`telegram: ${method} failed`);
	} finally {
		clearTimeout(timer);
	}
}

// "ignored" is nothing to act on, "rejected" is a decided refusal, "failed" is
// a redeem that threw -- only the last one is worth a redelivery.
export type CallbackOutcome = "acked" | "rejected" | "ignored" | "failed";

async function handleCallback(
	database: Database,
	callback: ParsedCallback,
	send: typeof SafeFetch,
	env: NodeJS.ProcessEnv,
): Promise<CallbackOutcome> {
	const candidates = await telegramChannels(database, env, {
		chatKeys: callback.chatKeys,
	});
	// No configured chat matched, so there is no bot token to answer with and no
	// recipient this callback could legitimately be acting for.
	if (candidates.length === 0) return "ignored";
	// Defence in depth (design 5): the capability must belong to someone this
	// chat actually delivers to. Keyed on the CHAT, not callback_query.from.id:
	// the chat is the binding we minted against and stored, while a group's
	// chat id never equals a member's user id, so gating on `from` would break
	// group delivery outright. Residual and accepted: any member of a bound
	// group can ack, exactly as any holder of an ntfy topic can.
	const allowedRecipients = candidates.map((candidate) => candidate.userId);

	let redeemed: string | null;
	try {
		redeemed = await redeemAckCapability(
			database,
			callback.token,
			ACK_VIA,
			Date.now(),
			{ allowedRecipients },
		);
	} catch (error) {
		console.error("telegram: redeem failed:", error);
		// Best-effort answer so the button loses its spinner; the caller's
		// retry-worthy outcome is what actually recovers the tap.
		await callBotApi(send, candidates[0].botToken, "answerCallbackQuery", {
			callback_query_id: callback.callbackId,
			text: ACK_RETRY_TEXT,
		});
		return "failed";
	}

	// botToken is per-user config, so it is read from the row that actually
	// matched rather than from an arbitrary member of the chat -- a mismatched
	// token makes every bot call fail silently, leaving the ack recorded but the
	// button still live under a spinner. A refusal has no matched row to read,
	// and the first candidate is the only token available then.
	const botToken =
		candidates.find((candidate) => candidate.userId === redeemed)?.botToken ??
		candidates[0].botToken;

	await callBotApi(send, botToken, "answerCallbackQuery", {
		callback_query_id: callback.callbackId,
		text: redeemed === null ? ACK_FAIL_TEXT : ACK_OK_TEXT,
	});
	if (redeemed === null) return "rejected";

	// Drops the inline keyboard with it (no reply_markup on the edit), so a
	// second tap on an already-burnt capability is not offered at all.
	if (callback.messageId !== null && callback.messageText !== null) {
		await callBotApi(send, botToken, "editMessageText", {
			chat_id: callback.chatId,
			message_id: callback.messageId,
			text: `${callback.messageText}${DONE_SUFFIX}`,
		});
	} else if (callback.messageId !== null) {
		await callBotApi(send, botToken, "editMessageReplyMarkup", {
			chat_id: callback.chatId,
			message_id: callback.messageId,
			reply_markup: { inline_keyboard: [] },
		});
	}
	return "acked";
}

// The one entry point both transports use. A malformed or uninteresting update
// is "ignored": there is nothing to act on and nothing to retry.
export async function handleTelegramUpdate(
	database: Database,
	update: unknown,
	send: typeof SafeFetch,
	env: NodeJS.ProcessEnv,
): Promise<CallbackOutcome> {
	const callback = parseAckCallback(update);
	return callback
		? await handleCallback(database, callback, send, env)
		: "ignored";
}
