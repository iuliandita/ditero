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

// Block Kit caps: section text 3000, button text 75, button url 3000.
const SECTION_TEXT_MAX = 3_000;
const ACK_URL_MAX = 3_000;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const ACK_LABEL = "Done";

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

// The mode-agnostic shape the send block below consumes. Task 11's app mode
// builds one of these against chat.postMessage with an Authorization header and
// its own interactive block builder; nothing under it changes.
type Outbound = {
	url: string;
	headers: Record<string, string>;
	body: string;
	redactedUrl: string;
	secrets: readonly string[];
};

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

		// Task 11 owns app mode. Until it lands an app-mode config is loudly
		// undeliverable rather than quietly downgraded to a link-button send.
		if (channel.mode !== "webhook") {
			return permanent("slack: app mode is not implemented");
		}

		const outbound: Outbound = {
			url: channel.webhookUrl,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(webhookBody(payload)),
			redactedUrl: redactedTarget(channel.webhookUrl),
			secrets: webhookSecrets(channel.webhookUrl),
		};
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
			if (response.ok) return { ok: true, status: response.status };

			// Slack returns Retry-After in SECONDS on a 429; incoming webhooks are
			// limited to roughly one message per second per channel.
			const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
			const detail = scrub(await response.text())
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 200);
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
