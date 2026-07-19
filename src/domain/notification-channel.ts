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

// M3b populates telegram/discord/slack/email; placeholders keep this map
// total over ChannelKind so callers never index into `undefined`.
const emptyConfigSchema = z.object({}).strict();

export const channelConfigSchema: Record<ChannelKind, z.ZodTypeAny> = {
	ntfy: ntfyConfigSchema,
	telegram: emptyConfigSchema,
	discord: emptyConfigSchema,
	slack: emptyConfigSchema,
	email: emptyConfigSchema,
};

// Allow-list, not deny-list: any field not explicitly known to be public data
// (including keys from a future/unvalidated config shape) is masked. Secrets
// must never leave the server in any form, including ciphertext.
const PUBLIC_FIELDS: Partial<Record<ChannelKind, readonly string[]>> = {
	ntfy: ["serverUrl", "topic"],
};

export function maskChannelConfig(
	kind: ChannelKind,
	config: Record<string, unknown>,
): Record<string, unknown> {
	const publicFields = new Set(PUBLIC_FIELDS[kind] ?? []);
	const masked: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		masked[key] = publicFields.has(key) ? value : MASKED;
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
	const restored: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value !== MASKED) {
			restored[key] = value;
			continue;
		}
		if (previous && previous.kind === kind && key in previous.config) {
			restored[key] = previous.config[key];
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
		isSecretLastSegmentHost(parsed.hostname) &&
		!parsed.pathname.endsWith("/")
	) {
		const segments = parsed.pathname.split("/");
		segments[segments.length - 1] = "[REDACTED]";
		parsed.pathname = segments.join("/");
	}

	return parsed.toString();
}
