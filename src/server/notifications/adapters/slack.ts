import {
	channelConfigSchema,
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

// Block Kit caps, docs.slack.dev/reference/block-kit/block-elements/button-element
// (checked 2026-07-23): text 75, url 3000, action_id 255, value 2000.
// Shared with slack-interactions.ts, which appends a done marker to the text it
// replaces and must clamp against the same bound.
export const SECTION_TEXT_MAX = 3_000;
const ACK_URL_MAX = 3_000;
export const ACTION_ID_MAX = 255;
export const ACTION_VALUE_MAX = 2_000;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const ACK_LABEL = "Done";

// docs.slack.dev/reference/methods/chat.postMessage (checked 2026-07-23): POST,
// JSON accepted, token "passed as an HTTP Authorization header".
const API_URL = "https://slack.com/api/chat.postMessage";

// The dispatch key the interactions listener matches on. Constant, because the
// capability rides in `value`: Slack's action_id cap is 255 and the value cap is
// 2000, so the larger field carries the token and the smaller one names the
// feature.
export const ACK_ACTION_ID = "ditero_ack";
// Shared with slack-interactions.ts, which parses what this emits.
export const ACK_VALUE_PREFIX = "c:";

// No upper bound here: ACTION_VALUE_MAX rejects anything longer anyway, and a
// second limit would only be a place for the two to disagree.
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;

type PlainText = { type: "plain_text"; text: string };

// An incoming webhook (`hooks.slack.com/services/...`) is send-only: nothing
// receives an interaction payload from it. Slack renders a `url` button from a
// webhook without any app interactivity, and clicking it opens the link -- so
// the ack has to be a LINK button, and an interactive one would be a control
// the user can press with nothing on the other end.
//
// `action_id?: never` + `value?: never` is the load-bearing part. An
// interactive Block Kit button is exactly one carrying an app-chosen
// `action_id` (the dispatch key) or a `value` (the payload the ack capability
// would ride in, design §5). Neither is representable here, and `url` is
// required, so this module cannot express a button that expects a callback.
// Task 11's app mode gets its own element type; it must not widen these.
export type LinkButton = {
	type: "button";
	text: PlainText;
	url: string;
	action_id?: never;
	value?: never;
};

export type SlackBlock =
	| { type: "section"; text: PlainText }
	| { type: "actions"; elements: readonly LinkButton[] };

export type WebhookMessageBody = {
	text: string;
	blocks: readonly SlackBlock[];
};

// Slack's documented escape rule for user-supplied text. `<!channel>`,
// `<!here>` and `<!everyone>` are broadcast pings written in that same angle-
// bracket link syntax, and a task title reaching a shared channel is user text.
// Structurally the section is a `plain_text` object, which does not parse the
// syntax at all; the top-level `text` fallback IS mrkdwn-parsed, and this is
// what closes it there. Order matters: `&` first, or `&lt;` typed by a user
// decodes back into `<`.
function escapeSlackText(value: string): string {
	return value
		.split("&")
		.join("&amp;")
		.split("<")
		.join("&lt;")
		.split(">")
		.join("&gt;");
}

// Anything that would yield a 400 instead of a button yields no button: the
// notification still arrives and stays ackable in-app.
function ackButton(ackUrl: string | null): LinkButton | null {
	if (!ackUrl || ackUrl.length > ACK_URL_MAX) return null;
	try {
		const protocol = new URL(ackUrl).protocol;
		if (protocol !== "http:" && protocol !== "https:") return null;
	} catch {
		return null;
	}
	return {
		type: "button",
		text: { type: "plain_text", text: ACK_LABEL },
		url: ackUrl,
	};
}

// The RETURN-TYPE annotations here and on webhookBody are the guard's anchor:
// both builders hand back a typed value assembled in the return statement, and
// the send path stringifies it, so an interactive element cannot be written
// anywhere on the way to the wire. An annotation on a local that is then
// serialized is not enough -- dropping it changes neither tsc nor any test.
export function messageBlocks(payload: ChannelPayload): readonly SlackBlock[] {
	const text = escapeSlackText(`${payload.title}\n\n${payload.body}`).slice(
		0,
		SECTION_TEXT_MAX,
	);
	const button = ackButton(payload.ackUrl);
	return [
		{ type: "section", text: { type: "plain_text", text } },
		...(button ? [{ type: "actions" as const, elements: [button] }] : []),
	];
}

export function webhookBody(payload: ChannelPayload): WebhookMessageBody {
	return {
		// Notification/accessibility fallback. mrkdwn-parsed, hence escaped.
		// No urgency knob: an incoming webhook has none.
		text: escapeSlackText(payload.title).slice(0, SECTION_TEXT_MAX),
		blocks: messageBlocks(payload),
	};
}

// App mode's counterpart, deliberately a separate type. Widening LinkButton,
// SlackBlock or WebhookMessageBody to admit an action_id would silently delete
// the webhook-mode guard above, so the two shapes never meet.
//
// The mirror-image guard: `url?: never` plus a REQUIRED action_id and value. A
// Block Kit button carrying a `url` navigates the browser, and a webhook-mode
// link button is exactly the thing that arrives at the interactions listener as
// an unrecognised action -- so emitting one here would produce the dead button
// app mode exists to avoid. Anchored the same way, and with the same
// fresh-vs-assembled caveat, as the webhook types above.
export type AckButton = {
	type: "button";
	text: PlainText;
	action_id: string;
	value: string;
	url?: never;
};

export type AppBlock =
	| { type: "section"; text: PlainText }
	| { type: "actions"; elements: readonly AckButton[] };

export type PostMessageBody = {
	channel: string;
	text: string;
	blocks: readonly AppBlock[];
};

// The adapter is handed the ack URL, not the raw capability, because that is
// what every other channel needs; the interactive button carries the token
// itself, so it is read back out of the URL's last segment. Anything that does
// not look like a capability token yields no button rather than a broken one --
// a button whose value no interaction handler recognises is worse than none.
export function ackActionValue(ackUrl: string | null): string | null {
	if (!ackUrl) return null;
	let segment: string;
	try {
		const path = new URL(ackUrl).pathname;
		segment = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
	} catch {
		return null;
	}
	if (!TOKEN_SEGMENT.test(segment)) return null;
	const value = `${ACK_VALUE_PREFIX}${segment}`;
	return value.length <= ACTION_VALUE_MAX ? value : null;
}

// Same return-type anchoring as messageBlocks/webhookBody: the builders hand
// back typed values and the send path stringifies at the call site.
export function appBlocks(payload: ChannelPayload): readonly AppBlock[] {
	const text = escapeSlackText(`${payload.title}\n\n${payload.body}`).slice(
		0,
		SECTION_TEXT_MAX,
	);
	const value = ackActionValue(payload.ackUrl);
	return [
		{ type: "section", text: { type: "plain_text", text } },
		...(value
			? [
					{
						type: "actions" as const,
						elements: [
							{
								type: "button" as const,
								text: { type: "plain_text" as const, text: ACK_LABEL },
								action_id: ACK_ACTION_ID,
								value,
							},
						],
					},
				]
			: []),
	];
}

export function appBody(
	channelId: string,
	payload: ChannelPayload,
): PostMessageBody {
	return {
		channel: channelId,
		// Notification/accessibility fallback, and the text slack-interactions.ts
		// reads back to rebuild the message it replaces. mrkdwn-parsed, hence
		// escaped.
		text: escapeSlackText(payload.title).slice(0, SECTION_TEXT_MAX),
		blocks: appBlocks(payload),
	};
}

// Stricter than redactChannelUrl, which blanks only the last path segment and
// so leaves the `T…/B…` ids. Those are not the bearer credential, but nothing
// in an operator's error line needs them, and the whole `/services/…` tail is
// opaque config either way.
function redactedTarget(webhookUrl: string): string {
	try {
		return `${new URL(webhookUrl).origin}/services/[REDACTED]`;
	} catch {
		return "[REDACTED]";
	}
}

// Everything past `/services/` plus the bearer segment on its own: a provider
// body is free text from a remote, so the credential is matched literally as
// well as structurally -- the same belt-and-braces the Telegram adapter
// applies.
//
// BOTH the raw stored form and the URL-normalized one, for the same reason
// Telegram scrubs both: the config schema constrains the scheme, host and
// length but not the path charset, so a stored token holding a space, `%`, `^`
// or non-ASCII percent-encodes on `new URL()` and the two forms diverge -- and
// the provider echoes back the raw one. A schema refinement would only cover
// configs stored after it, which is exactly the case a credential scrubber must
// not depend on.
//
// Insertion order is load-bearing: each full `/services/` tail precedes its own
// last segment, so the `T…/B…` ids are scrubbed with the tail rather than left
// behind by an early last-segment match.
function webhookSecrets(webhookUrl: string): readonly string[] {
	const secrets = new Set<string>();
	// Under 8 characters it is not a credential, and scrubbing it would corrupt
	// unrelated words in the one error line an operator triages from.
	const add = (value: string | undefined): void => {
		if (value && value.length >= 8) secrets.add(value);
	};
	const collect = (path: string): void => {
		const marker = path.indexOf("/services/");
		if (marker !== -1) add(path.slice(marker + "/services/".length));
		add(path.split("/").pop());
	};
	try {
		collect(new URL(webhookUrl).pathname);
	} catch {
		// Unparseable: the raw form below is all there is.
	}
	collect(webhookUrl.split(/[?#]/)[0]);
	return [...secrets];
}

// The mode-agnostic shape the send block below consumes. `mode` survives here
// only because the two transports disagree about what a success looks like: an
// incoming webhook answers plain text, chat.postMessage answers a JSON envelope
// that reports failures under HTTP 200.
type Outbound = {
	mode: "webhook" | "app";
	url: string;
	headers: Headers;
	body: string;
	redactedUrl: string;
	secrets: readonly string[];
};

function webhookOutbound(
	webhookUrl: string,
	payload: ChannelPayload,
): Outbound {
	return {
		mode: "webhook",
		url: webhookUrl,
		headers: new Headers({ "Content-Type": "application/json" }),
		body: JSON.stringify(webhookBody(payload)),
		redactedUrl: redactedTarget(webhookUrl),
		secrets: webhookSecrets(webhookUrl),
	};
}

function appOutbound(
	botToken: string,
	channelId: string,
	payload: ChannelPayload,
): Outbound {
	return {
		mode: "app",
		url: API_URL,
		headers: new Headers({
			"Content-Type": "application/json; charset=utf-8",
			Authorization: `Bearer ${botToken}`,
		}),
		body: JSON.stringify(appBody(channelId, payload)),
		// No credential in the URL at all in this mode: the token is a header.
		redactedUrl: API_URL,
		secrets: [botToken],
	};
}

type Envelope = { ok?: unknown; error?: unknown };

function parseEnvelope(text: string): Envelope | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Envelope) : null;
	} catch {
		return null;
	}
}

// Slack's `ok: false` error codes carry no status of their own, and almost all
// of them are permanent config, scope or payload problems -- so the default is
// a permanent 400 and the transient ones are named. Getting this backwards
// either burns the ~33-minute ladder on a revoked token or abandons a reminder
// over a momentary Slack outage. A Map, not an object: the error string comes
// from a remote, and `constructor` would resolve on an object literal.
const APP_ERROR_STATUS = new Map<string, number>([
	["invalid_auth", 401],
	["not_authed", 401],
	["token_revoked", 401],
	["token_expired", 401],
	["account_inactive", 401],
	["no_permission", 403],
	["missing_scope", 403],
	["channel_not_found", 404],
	["not_in_channel", 404],
	["is_archived", 404],
	["ratelimited", 429],
	["service_unavailable", 503],
	["fatal_error", 503],
	["internal_error", 503],
	["request_timeout", 503],
]);

export const slackAdapter: ChannelAdapter = {
	kind: "slack",
	async send(
		config: unknown,
		payload: ChannelPayload,
		ctx: AdapterContext,
	): Promise<ProviderResult> {
		const parsed = channelConfigSchema.slack.safeParse(config);
		// A stored config that cannot be parsed will never parse on a retry.
		if (!parsed.success) return permanent("slack: unusable channel config");
		// channelConfigSchema is typed as ZodTypeAny (it is a total map over every
		// ChannelKind), so the narrowing the schema already guarantees is restated.
		const channel = parsed.data as
			| { mode: "webhook"; webhookUrl: string }
			| {
					mode: "app";
					botToken: string;
					signingSecret: string;
					channelId: string;
			  };

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
			return permanent("slack: unusable channel config");
		}
		// Literal first, then structural: redactChannelUrl blanks only the last
		// path segment, so running it first would leave the `T…/B…` ids of an
		// echoed full URL behind with nothing left for the literal pass to match.
		const scrub = (text: string): string =>
			redactUrlsIn(
				outbound.secrets.reduce(
					(acc, secret) => acc.split(secret).join("[REDACTED]"),
					text,
				),
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

			// An incoming webhook answers 200 with the PLAIN TEXT body `ok`, and
			// reports failures as real status codes carrying a plain-text error code
			// (`invalid_payload`, `channel_not_found`, …). There is no JSON envelope
			// to read, so the status alone decides.
			if (outbound.mode === "webhook" && response.ok) {
				return { ok: true, status: response.status };
			}

			// Slack returns Retry-After in SECONDS on a 429; incoming webhooks are
			// limited to roughly one message per second per channel.
			const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
			const text = await response.text();

			// chat.postMessage answers HTTP 200 with `{"ok": false, "error": "…"}`
			// for most application-level failures, so `response.ok` alone reports a
			// revoked token as a delivery. The envelope decides; the HTTP status only
			// fills in when there is no parseable envelope.
			if (outbound.mode === "app") {
				const envelope = parseEnvelope(text);
				if (response.ok && envelope?.ok === true) {
					return { ok: true, status: response.status };
				}
				const code =
					typeof envelope?.error === "string"
						? envelope.error.slice(0, 100)
						: "";
				const status = response.ok
					? (APP_ERROR_STATUS.get(code) ?? (code ? 400 : undefined))
					: response.status;
				return {
					ok: false,
					...(status === undefined ? {} : { status }),
					...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }),
					// Never bare `response.status` as the fallback: a 200 carrying
					// `{"ok": false}` with no error code would read `slack 200`, and the
					// one line an operator triages from would claim the send worked.
					error: `slack ${status ?? `HTTP ${response.status}, no envelope code`} from ${outbound.redactedUrl}${code ? `: ${scrub(code)}` : ""}`,
				};
			}

			const detail = scrub(text).replace(/\s+/g, " ").trim().slice(0, 200);
			return {
				ok: false,
				status: response.status,
				...(retryAfter === undefined ? {} : { retryAfterSec: retryAfter }),
				// Never the raw URL: its `/services/` tail is the bearer credential.
				error: `slack ${response.status} from ${outbound.redactedUrl}${detail ? `: ${detail}` : ""}`,
			};
		} catch (error) {
			if (error instanceof OutboundPolicyError) {
				return permanent(`slack: ${scrub(error.message)}`);
			}
			const message = error instanceof Error ? error.message : "unknown error";
			return {
				ok: false,
				error: `slack: ${outbound.redactedUrl} failed: ${scrub(message)}`,
			};
		} finally {
			clearTimeout(timer);
		}
	},
};
