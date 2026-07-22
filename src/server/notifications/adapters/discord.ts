import {
	channelConfigSchema,
	redactChannelUrl,
	redactUrlsIn,
} from "../../../domain/notification-channel.ts";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import { retryAfterSeconds } from "./retry-after.ts";
import type {
	AdapterContext,
	ChannelAdapter,
	ChannelPayload,
} from "./types.ts";
import { permanent } from "./types.ts";

const CONTENT_MAX = 2_000;
// Discord's documented cap on a button's `url`. A longer one is a 400, which
// loses the whole notification rather than just the button.
const ACK_URL_MAX = 512;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const ACK_LABEL = "Done";

// App mode posts as the bot, not through the pasted webhook URL.
// POST /channels/{channel.id}/messages, `Authorization: Bot <token>`.
const API_ORIGIN = "https://discord.com/api";
const API_VERSION = "v10";

// Documented as "1-100 characters" on a button's custom_id. `c:` + a 43-char
// base64url ack token is 45, so the capability rides in the button with room to
// spare. Pinned by a test so a future ACK_TOKEN_BYTES change fails there rather
// than in a user's Discord.
export const CUSTOM_ID_MAX = 100;
// Shared with the interactions listener (Task 9), which parses what this emits.
export const ACK_CUSTOM_ID_PREFIX = "c:";

// No upper bound here: CUSTOM_ID_MAX rejects anything longer anyway, and a
// second limit would only be a place for the two to disagree.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

// A button with `style: 5` and a `url` is the only component a
// non-application-owned webhook may send: it dispatches no interaction, so
// Discord classifies it non-interactive and `with_components` admits it.
//
// `custom_id?: never` is the load-bearing part. An interactive button is
// exactly a button carrying a `custom_id`, and Discord ACCEPTS one on a plain
// webhook, answers 204, and silently drops it -- the app would record a
// delivery for a notification that reached the user with no button and no error
// anywhere. Nothing detects that after the fact, so the defence is that this
// module cannot express it. App mode has its own body type below; it must not
// widen these.
//
// `?: never` earns its keep only against a value assembled elsewhere and then
// assigned: a fresh object literal carrying a custom_id is already rejected by
// excess-property checking, guard or no guard. The tests assert both shapes,
// because only the assembled one fails when this line is deleted.
export type LinkButton = {
	type: 2;
	style: 5;
	label: string;
	url: string;
	custom_id?: never;
};

export type WebhookActionRow = { type: 1; components: readonly LinkButton[] };

// Two RETURN-TYPE annotations anchor this, verified by removing each: an
// interactive button written into ackLinkRow's literal is caught there, and if
// that annotation goes, webhookRequest's `body: WebhookExecuteBody` catches the
// same defect one level up. Only removing both lets it reach the wire. An
// annotation on a local that is then stringified anchors nothing -- dropping one
// changes neither tsc nor any test -- so the builders return typed values and
// the send path stringifies at the call site.
export type WebhookExecuteBody = {
	content: string;
	allowed_mentions: { parse: readonly never[] };
	components?: readonly WebhookActionRow[];
};

// App mode's counterpart, deliberately a separate type. Widening LinkButton or
// WebhookExecuteBody to admit a custom_id would silently delete the webhook-mode
// guard above, so the two shapes never meet.
//
// The mirror-image guard: `url?: never` plus a pinned interactive style. Discord
// requires a non-link button to carry a custom_id and forbids it a url, and a
// link button dispatches no interaction -- so emitting one here would produce
// exactly the dead button app mode exists to avoid. Anchored the same way, and
// with the same fresh-vs-assembled caveat, as the webhook types above.
export type AckButton = {
	type: 2;
	style: 3;
	label: string;
	custom_id: string;
	url?: never;
};

export type AppActionRow = { type: 1; components: readonly AckButton[] };

export type CreateMessageBody = {
	content: string;
	allowed_mentions: { parse: readonly never[] };
	components?: readonly AppActionRow[];
};

// Anything that would yield a 400 instead of a button yields no button: the
// notification still arrives and stays ackable in-app.
export function ackLinkRow(
	ackUrl: string | null,
): readonly WebhookActionRow[] | null {
	if (!ackUrl || ackUrl.length > ACK_URL_MAX) return null;
	try {
		const protocol = new URL(ackUrl).protocol;
		if (protocol !== "http:" && protocol !== "https:") return null;
	} catch {
		return null;
	}
	return [
		{
			type: 1,
			components: [{ type: 2, style: 5, label: ACK_LABEL, url: ackUrl }],
		},
	];
}

// No urgency knob: Discord has none, and `@everyone` is the only thing
// resembling one -- see allowed_mentions.
function messageContent(payload: ChannelPayload): string {
	return `${payload.title}\n\n${payload.body}`.slice(0, CONTENT_MAX);
}

// URL and body are built together and returned together. `components` without
// `with_components=true` is dropped by Discord with a success status, so the
// two must not be settable independently by any caller.
export function webhookRequest(
	webhookUrl: string,
	payload: ChannelPayload,
): { url: string; body: WebhookExecuteBody } {
	const components = ackLinkRow(payload.ackUrl);
	const url = new URL(webhookUrl);
	if (components) url.searchParams.set("with_components", "true");
	else url.searchParams.delete("with_components");

	return {
		url: url.toString(),
		body: {
			content: messageContent(payload),
			// The title is a user-written task name. Without this an "@everyone" in
			// one pings every member of the server the webhook posts to.
			allowed_mentions: { parse: [] },
			...(components ? { components } : {}),
		},
	};
}

// The adapter is handed the ack URL, not the raw capability, because that is
// what every other channel needs; the interactive button carries the token
// itself, so it is read back out of the URL's last segment. Anything that does
// not look like a capability token yields no button rather than a broken one --
// a button whose custom_id no interaction handler recognises is worse than none.
export function ackCustomId(ackUrl: string | null): string | null {
	if (!ackUrl) return null;
	let segment: string;
	try {
		const path = new URL(ackUrl).pathname;
		segment = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
	} catch {
		return null;
	}
	if (!TOKEN_SEGMENT.test(segment)) return null;
	const customId = `${ACK_CUSTOM_ID_PREFIX}${segment}`;
	return customId.length <= CUSTOM_ID_MAX ? customId : null;
}

export function ackButtonRow(
	ackUrl: string | null,
): readonly AppActionRow[] | null {
	const customId = ackCustomId(ackUrl);
	if (!customId) return null;
	return [
		{
			type: 1,
			components: [
				{ type: 2, style: 3, label: ACK_LABEL, custom_id: customId },
			],
		},
	];
}

export function appRequest(
	channelId: string,
	payload: ChannelPayload,
): { url: string; body: CreateMessageBody } {
	const components = ackButtonRow(payload.ackUrl);
	return {
		// channelId is digits-only per the config schema; encoded anyway so a
		// looser value stored before that schema existed cannot retarget the path.
		url: `${API_ORIGIN}/${API_VERSION}/channels/${encodeURIComponent(channelId)}/messages`,
		body: {
			content: messageContent(payload),
			allowed_mentions: { parse: [] },
			...(components ? { components } : {}),
		},
	};
}

type ErrorEnvelope = { message?: unknown; retry_after?: unknown };

function parseBody(text: string): ErrorEnvelope | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object"
			? (parsed as ErrorEnvelope)
			: null;
	} catch {
		return null;
	}
}

// The last path segment of a webhook URL IS the bearer credential.
// redactChannelUrl blanks it for every host the config schema accepts, but a
// provider `message` is free text from a remote, so it is also matched
// literally -- the same belt-and-braces the Telegram adapter applies.
//
// BOTH the raw and the URL-normalized form, for the same reason Telegram scrubs
// both: the config schema constrains the scheme, host and length but not the
// path charset, so a stored token holding a space, `%`, `^`, `{` or non-ASCII
// percent-encodes on `new URL()` and the two forms diverge. A schema refinement
// would only cover configs stored after it, which is exactly the case a
// credential scrubber must not depend on.
function webhookSecrets(webhookUrl: string): readonly string[] {
	const secrets = new Set<string>();
	const add = (value: string | undefined): void => {
		if (value && value.length >= 8) secrets.add(value);
	};
	try {
		add(new URL(webhookUrl).pathname.split("/").pop());
	} catch {
		// Unparseable: the raw form below is all there is.
	}
	add(webhookUrl.split(/[?#]/)[0].split("/").pop());
	return [...secrets];
}

// Everything downstream of here is mode-agnostic: one fetch, one classifier,
// one scrubber. `secrets` are the literal credential strings a provider message
// could echo back.
type Outbound = {
	url: string;
	headers: Headers;
	body: string;
	secrets: readonly string[];
};

function webhookOutbound(
	webhookUrl: string,
	payload: ChannelPayload,
): Outbound {
	const { url, body } = webhookRequest(webhookUrl, payload);
	return {
		url,
		headers: new Headers({ "Content-Type": "application/json" }),
		body: JSON.stringify(body),
		secrets: webhookSecrets(webhookUrl),
	};
}

function appOutbound(
	botToken: string,
	channelId: string,
	payload: ChannelPayload,
): Outbound {
	const { url, body } = appRequest(channelId, payload);
	return {
		url,
		headers: new Headers({
			"Content-Type": "application/json",
			Authorization: `Bot ${botToken}`,
		}),
		body: JSON.stringify(body),
		secrets: [botToken],
	};
}

export const discordAdapter: ChannelAdapter = {
	kind: "discord",
	async send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult> {
		const parsed = channelConfigSchema.discord.safeParse(config);
		// A stored config that cannot be parsed will never parse on a retry.
		if (!parsed.success) return permanent("discord: unusable channel config");
		// channelConfigSchema is typed as ZodTypeAny (it is a total map over every
		// ChannelKind), so the narrowing the schema already guarantees is restated.
		const channel = parsed.data as
			| { mode: "webhook"; webhookUrl: string }
			| { mode: "app"; botToken: string; publicKey: string; channelId: string };

		// Built outside the send's try/catch, and reported with no interpolated
		// message: a TypeError from Headers embeds the offending value, and in app
		// mode that value is the bot token. The charset regex on the config schema
		// should make this unreachable; this is the second half of that guarantee,
		// covering configs stored before the regex existed.
		let outbound: Outbound;
		try {
			outbound =
				channel.mode === "webhook"
					? webhookOutbound(channel.webhookUrl, payload)
					: appOutbound(channel.botToken, channel.channelId, payload);
		} catch {
			return permanent("discord: unusable channel config");
		}

		const scrub = (text: string): string =>
			outbound.secrets.reduce(
				(redacted, secret) => redacted.split(secret).join("[REDACTED]"),
				redactUrlsIn(text),
			);

		// Matches worker.ts's sendWithDeadline rather than introducing a second
		// idiom: AbortSignal.timeout holds its timer for the full deadline even
		// after a send that already completed.
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), ctx.deadlineMs);
		try {
			// Both bounds, not either: the worker's signal is what reaches the
			// socket when it stops waiting, and the deadline is what stops a
			// slow-drip response from holding the slot (C18).
			const response = await (ctx.fetch ?? safeFetch)(outbound.url, {
				method: "POST",
				headers: outbound.headers,
				body: outbound.body,
				signal: AbortSignal.any([ctx.signal, deadline.signal]),
				allowedPrivateCIDRs: ctx.allowedPrivateCIDRs,
				maxResponseBytes: RESPONSE_MAX_BYTES,
			});

			// Execute Webhook answers 204 No Content unless `?wait=true`; Create
			// Message answers 200 with the message object. Both are plain successes:
			// an empty body is not a missing envelope here -- the opposite of
			// Telegram, whose 200 can carry `{"ok": false}`.
			if (response.ok) return { ok: true, status: response.status };

			const envelope = parseBody(await response.text());
			// Discord reports the wait in the 429 body as FRACTIONAL SECONDS
			// ("retry_after": 64.57), the same unit as the Retry-After header.
			// Reading it as milliseconds would retry a thousand times too eagerly.
			// A Cloudflare-level ban answers 429 with HTML and no envelope, so the
			// header is the fallback.
			const retryAfter = retryAfterSeconds(
				envelope?.retry_after ?? response.headers.get("retry-after"),
			);
			const message =
				typeof envelope?.message === "string"
					? `: ${scrub(envelope.message).slice(0, 200)}`
					: "";
			return {
				ok: false,
				status: response.status,
				...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }),
				// Never the raw URL: its last path segment is the credential.
				error: `discord ${response.status} from ${redactChannelUrl(outbound.url)}${message}`,
			};
		} catch (error) {
			if (error instanceof OutboundPolicyError) {
				return permanent(`discord: ${scrub(error.message)}`);
			}
			const detail = error instanceof Error ? error.message : "unknown error";
			return {
				ok: false,
				error: `discord: ${redactChannelUrl(outbound.url)} failed: ${scrub(detail)}`,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};
