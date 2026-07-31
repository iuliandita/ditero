import {
	channelConfigSchema,
	redactChannelUrl,
	redactUrlsIn,
} from "../../../domain/notification-channel.ts";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import { m } from "../../../paraglide/messages.js";
import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import { retryAfterSeconds } from "./retry-after.ts";
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelPayload,
} from "./types.ts";
import { permanent } from "./types.ts";

const API_ORIGIN = "https://api.telegram.org";
const TEXT_MAX = 4_000;
const RESPONSE_MAX_BYTES = 64 * 1_024;

// Bot API hard limit on callback_data, in BYTES, not characters. `c:` + a
// 32-byte base64url ack token is 45, so it fits with room to spare and no
// short-id indirection table is needed. Pinned by a test so a future change to
// ACK_TOKEN_BYTES fails there rather than in a user's chat.
export const CALLBACK_DATA_MAX_BYTES = 64;
// Shared with the inbound listener (Task 5), which parses what this emits.
export const ACK_CALLBACK_PREFIX = "c:";

// No upper bound: CALLBACK_DATA_MAX_BYTES rejects anything past 62 characters
// anyway, and a second limit would only be a place for the two to disagree.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

// Every bot token is `<id>:<secret>`, and `:` is a legal RFC 3986 pchar, so
// encodeURIComponent's blanket %3A would put a percent-escape in the path of
// every single request. Encode the characters that actually change the request
// target -- `/`, `?`, `#`, `%` -- and leave the rest byte-identical.
export function pathSegment(value: string): string {
	return encodeURIComponent(value).replace(/%3A/g, ":");
}

// The adapter is handed the ack URL, not the raw capability, because that is
// what every other channel needs. Telegram's button carries the token itself,
// so it is read back out of the URL's last segment. Anything that does not look
// like a capability token yields no button rather than a broken one.
export function ackCallbackData(ackUrl: string | null): string | null {
	if (!ackUrl) return null;
	let segment: string;
	try {
		const path = new URL(ackUrl).pathname;
		segment = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
	} catch {
		return null;
	}
	if (!TOKEN_SEGMENT.test(segment)) return null;
	const data = `${ACK_CALLBACK_PREFIX}${segment}`;
	return Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES
		? data
		: null;
}

type BotResponse = {
	ok?: unknown;
	error_code?: unknown;
	description?: unknown;
	parameters?: unknown;
};

function parseBody(text: string): BotResponse | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object"
			? (parsed as BotResponse)
			: null;
	} catch {
		return null;
	}
}

function statusCode(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 100 &&
		value < 600
		? value
		: undefined;
}

export const telegramAdapter: ChannelAdapter = {
	kind: "telegram",
	async send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult> {
		const parsed = channelConfigSchema.telegram.safeParse(config);
		// A stored config that cannot be parsed will never parse on a retry.
		if (!parsed.success) return permanent("telegram: unusable channel config");
		// channelConfigSchema is typed as ZodTypeAny (it is a total map over every
		// ChannelKind), so the narrowing the schema already guarantees is restated.
		const { botToken, chatId } = parsed.data as {
			botToken: string;
			chatId: string;
		};

		// The ntfy adapter builds its Authorization header outside the try because
		// a TypeError from Headers embeds the credential. Telegram's equivalent is
		// worse: the bot token is a PATH SEGMENT, so a token carrying `/`, `?` or
		// `#` would silently retarget the request, and encodeURIComponent throws a
		// URIError on a lone surrogate. Both happen before the try, and the
		// failure is reported with nothing interpolated.
		let url: string;
		let encodedToken: string;
		try {
			encodedToken = pathSegment(botToken);
			url = `${API_ORIGIN}/bot${encodedToken}/sendMessage`;
			new URL(url);
		} catch {
			return permanent("telegram: unusable channel config");
		}

		// Every string this adapter returns passes through here. redactChannelUrl's
		// TELEGRAM_BOT_PATH rule covers the URL, but the provider's `description`
		// is free text from a remote, so the credential is also matched literally.
		const scrub = (text: string): string =>
			redactUrlsIn(text)
				.split(botToken)
				.join("[REDACTED]")
				.split(encodedToken)
				.join("[REDACTED]");

		const callbackData = ackCallbackData(payload.ackUrl);
		// No parse_mode: the title is user-controlled, and any markup mode would
		// make an unbalanced `*` or `_` a permanent 400 on an ordinary task name.
		const body = JSON.stringify({
			chat_id: chatId,
			text: `${payload.title}\n\n${payload.body}`.slice(0, TEXT_MAX),
			// No urgency knob: the Bot API only offers disable_notification, and
			// mapping "not urgent" onto it would silence every ordinary reminder.
			...(callbackData
				? {
						reply_markup: {
							inline_keyboard: [
								[
									{
										text: m.notify_ack_label({}, { locale: payload.locale }),
										callback_data: callbackData,
									},
								],
							],
						},
					}
				: {}),
		});

		// Matches worker.ts's sendWithDeadline rather than introducing a second
		// idiom: AbortSignal.timeout holds its timer for the full deadline even
		// after a send that already completed.
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), ctx.deadlineMs);
		try {
			// Both bounds, not either: the worker's signal is what reaches the
			// socket when it stops waiting, and the deadline is what stops a
			// slow-drip response from holding the slot (C18).
			const response = await (ctx.fetch ?? safeFetch)(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
				signal: AbortSignal.any([ctx.signal, deadline.signal]),
				allowedPrivateCIDRs: ctx.allowedPrivateCIDRs,
				maxResponseBytes: RESPONSE_MAX_BYTES,
			});

			// The Bot API answers HTTP 200 with `{"ok": false, ...}` for most
			// application-level errors, so `response.ok` alone reports failures as
			// deliveries. The envelope decides; the HTTP status only fills in when
			// there is no parseable envelope.
			const envelope = parseBody(await response.text());
			if (response.ok && envelope?.ok === true) {
				return { ok: true, status: response.status };
			}

			const parameters = envelope?.parameters;
			const retryAfter = retryAfterSeconds(
				parameters &&
					typeof parameters === "object" &&
					"retry_after" in parameters
					? (parameters as { retry_after?: unknown }).retry_after
					: response.headers.get("retry-after"),
			);
			const observed =
				statusCode(envelope?.error_code) ??
				(response.ok ? undefined : response.status);
			// Legacy FLOOD_WAIT arrives as 420 (and a webhook/getUpdates conflict as
			// 409) carrying parameters.retry_after. classifyRetry calls every 4xx but
			// 429 permanent, so channelErrorCode would mark a merely throttled channel
			// broken forever. A 4xx that names its own wait is a throttle; report it
			// as one, while the error string below keeps the code actually received.
			const status =
				observed !== undefined &&
				observed >= 400 &&
				observed < 500 &&
				observed !== 429 &&
				retryAfter !== undefined
					? 429
					: observed;
			const description =
				typeof envelope?.description === "string"
					? `: ${scrub(envelope.description).slice(0, 200)}`
					: "";
			return {
				ok: false,
				...(status === undefined ? {} : { status }),
				...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }),
				// Never bare `response.status` as the fallback: a 200 carrying
				// `{"ok": false}` with no error_code would read `telegram 200`, and the
				// one line an operator triages from would claim the send worked.
				error: `telegram ${observed ?? `HTTP ${response.status}, no envelope code`} from ${redactChannelUrl(url)}${description}`,
			};
		} catch (error) {
			if (error instanceof OutboundPolicyError) {
				return permanent(`telegram: ${scrub(error.message)}`);
			}
			const message = error instanceof Error ? error.message : "unknown error";
			return {
				ok: false,
				error: `telegram: ${redactChannelUrl(url)} failed: ${scrub(message)}`,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};
