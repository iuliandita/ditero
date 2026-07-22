import { z } from "zod";

export type ChannelKind = "ntfy" | "telegram" | "discord" | "slack" | "email";

export const MASKED = "***";

function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

const ntfyConfigSchema = z
	.object({
		serverUrl: z.string().refine(isHttpUrl, "serverUrl must be an http(s) URL"),
		topic: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/),
		// Printable ASCII only. The token is sent as an Authorization header, and
		// a CR/LF/NUL in it makes header construction throw a TypeError whose
		// message embeds the token itself -- which would then be persisted as a
		// delivery error. Rejected at write time so it can never be stored.
		token: z
			.string()
			.max(256)
			.regex(/^[\x21-\x7e]+$/, "token must be printable ASCII without spaces")
			.optional(),
	})
	.strict();

// Same reason as the ntfy token above: every one of these rides in an
// Authorization header, so a CR/LF in it throws a TypeError carrying the
// credential in its message, which then gets persisted as a delivery error.
const headerCredential = z
	.string()
	.max(256)
	.regex(/^[\x21-\x7e]+$/, "credential must be printable ASCII without spaces");

// The last path segment of a provider webhook URL IS the bearer credential, and
// redactChannelUrl only strips it for the known provider hosts. Pinning the host
// per provider keeps "a config we accept whose secret survives into a persisted
// delivery error" unrepresentable. Suffix match, never substring.
function webhookUrlFor(provider: string, domains: readonly string[]) {
	return z
		.string()
		.max(2_048)
		.refine((value) => {
			if (!isHttpUrl(value)) return false;
			const host = new URL(value).hostname.toLowerCase();
			return domains.some(
				(domain) => host === domain || host.endsWith(`.${domain}`),
			);
		}, `webhookUrl must be a ${provider} webhook URL`);
}

// Mirrors SECRET_LAST_SEGMENT_DOMAINS below, so every accepted Discord webhook
// URL is one redactChannelUrl covers -- including the canary/ptb style subdomains
// this does not need to enumerate.
const discordWebhookUrl = webhookUrlFor("Discord", [
	"discord.com",
	"discordapp.com",
]);
const slackWebhookUrl = webhookUrlFor("Slack", ["hooks.slack.com"]);

const telegramConfigSchema = z
	.object({
		botToken: headerCredential,
		chatId: z
			.string()
			.max(64)
			.regex(/^(-?\d+|@[A-Za-z0-9_]+)$/, "chatId must be an id or @username"),
	})
	.strict();

// Discriminated on `mode` so an adapter can never reach for a credential the
// config does not hold: webhook mode is structurally incapable of carrying a
// bot token, which is what makes Discord's silent component-drop unreachable.
const discordConfigSchema = z.discriminatedUnion("mode", [
	z
		.object({ mode: z.literal("webhook"), webhookUrl: discordWebhookUrl })
		.strict(),
	z
		.object({
			mode: z.literal("app"),
			botToken: headerCredential,
			publicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "publicKey must be hex"),
			channelId: z.string().max(64).regex(/^\d+$/),
		})
		.strict(),
]);

const slackConfigSchema = z.discriminatedUnion("mode", [
	z
		.object({ mode: z.literal("webhook"), webhookUrl: slackWebhookUrl })
		.strict(),
	z
		.object({
			mode: z.literal("app"),
			botToken: headerCredential,
			signingSecret: headerCredential,
			channelId: z
				.string()
				.max(64)
				.regex(/^[A-Za-z0-9_-]+$/),
		})
		.strict(),
]);

const emailConfigSchema = z.object({ address: z.email().max(254) }).strict();

export const channelConfigSchema: Record<ChannelKind, z.ZodTypeAny> = {
	ntfy: ntfyConfigSchema,
	telegram: telegramConfigSchema,
	discord: discordConfigSchema,
	slack: slackConfigSchema,
	email: emailConfigSchema,
};

// Allow-list, not deny-list: any field not explicitly known to be public data
// (including keys from a future/unvalidated config shape) is masked. Secrets
// must never leave the server in any form, including ciphertext.
// A webhook URL is a credential, not an address: its last path segment is the
// whole bearer secret (see redactChannelUrl).
// `email.address` is public for the same reason `chatId` and `channelId` are: it
// is a destination identifier, the only reader of a masked config is the row's
// own owner, and a config that is nothing but the address would be unverifiable
// in the settings form if masked. The account's own address is already stored in
// plaintext by the auth tables, so encrypting this one buys nothing.
const PUBLIC_FIELDS: Partial<Record<ChannelKind, readonly string[]>> = {
	ntfy: ["serverUrl", "topic"],
	telegram: ["chatId"],
	discord: ["mode", "channelId"],
	slack: ["mode", "channelId"],
	email: ["address"],
};

// Same allow-list the mask uses, exposed so the at-rest encryption covers
// exactly the fields the mask refuses to hand back -- one definition of
// "secret", not two that can drift.
export function isPublicChannelField(kind: ChannelKind, key: string): boolean {
	return (PUBLIC_FIELDS[kind] ?? []).includes(key);
}

export function maskChannelConfig(
	kind: ChannelKind,
	config: Record<string, unknown>,
): Record<string, unknown> {
	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		masked[key] = isPublicChannelField(kind, key) ? value : MASKED;
	}
	return masked;
}

// Must run BEFORE schema validation: the schema rejects the literal MASKED
// placeholder (e.g. it is not a valid URL), so validating first would break
// "save without retyping the secret". Restoring first is also safe against a
// forged MASKED value, since the swap only ever pulls from the caller's own
// previously stored config for this channel, never from the request.
export function restoreChannelConfig(
	kind: ChannelKind,
	incoming: Record<string, unknown>,
	previous: { kind: ChannelKind; config: Record<string, unknown> } | null,
): Record<string, unknown> {
	// The kind guard alone does not cover mode: the save path always loads
	// `previous` by kind, so kind can never differ there and mode can.
	const carried =
		previous && previous.kind === kind && incoming.mode === previous.config.mode
			? previous.config
			: null;
	// Null-prototype accumulator + hasOwn: a body with an own `__proto__` key
	// would otherwise reparent the object instead of setting a property.
	const restored: Record<string, unknown> = Object.create(null);
	for (const [key, value] of Object.entries(incoming)) {
		if (value !== MASKED) {
			restored[key] = value;
			continue;
		}
		if (carried && Object.hasOwn(carried, key)) {
			restored[key] = carried[key];
		}
	}
	return restored;
}

const TELEGRAM_BOT_PATH = /\/bot[^/]+/;
const SECRET_LAST_SEGMENT_DOMAINS = [
	"discord.com",
	"discordapp.com",
	"slack.com",
];

// Mirrors ACK_PATH in server/notifications/capability.ts, which this domain
// module must not import (it pulls the database layer in). The ack token is the
// whole credential and rides in the last path segment, on the deployment's own
// origin, so no host rule can catch it.
const ACK_URL_PREFIX = "/api/notifications/ack/";

function isSecretLastSegmentHost(host: string): boolean {
	return SECRET_LAST_SEGMENT_DOMAINS.some(
		(domain) => host === domain || host.endsWith(`.${domain}`),
	);
}

export function redactChannelUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return url.replace(TELEGRAM_BOT_PATH, "/bot[REDACTED]");
	}

	parsed.username = "";
	parsed.password = "";
	parsed.search = "";

	if (TELEGRAM_BOT_PATH.test(parsed.pathname)) {
		parsed.pathname = parsed.pathname.replace(
			TELEGRAM_BOT_PATH,
			"/bot[REDACTED]",
		);
	} else if (
		(isSecretLastSegmentHost(parsed.hostname) ||
			parsed.pathname.startsWith(ACK_URL_PREFIX)) &&
		!parsed.pathname.endsWith("/")
	) {
		const segments = parsed.pathname.split("/");
		segments[segments.length - 1] = "[REDACTED]";
		parsed.pathname = segments.join("/");
	}

	return parsed.toString();
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

// Redacts every URL embedded in free text (adapter and provider error messages,
// mostly). Shared so the adapter layer and the worker's persist layer cannot
// drift apart on what counts as a URL.
export function redactUrlsIn(text: string): string {
	return text.replace(URL_IN_TEXT, redactChannelUrl);
}
