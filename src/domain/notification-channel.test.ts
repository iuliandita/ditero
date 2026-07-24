import { describe, expect, it } from "vitest";
import {
	type ChannelKind,
	channelConfigSchema,
	MASKED,
	maskChannelConfig,
	redactChannelUrl,
	redactUrlsIn,
	restoreChannelConfig,
} from "./notification-channel.ts";

const DISCORD_WEBHOOK = {
	mode: "webhook",
	webhookUrl: "https://discord.com/api/webhooks/123/wh-secret",
};

const SLACK_WEBHOOK = {
	mode: "webhook",
	webhookUrl: "https://hooks.slack.com/services/T1/B1/wh-secret",
};

const VALID_CONFIGS = {
	ntfy: { serverUrl: "https://ntfy.sh", topic: "t", token: "tk_secret" },
	telegram: { botToken: "123456:AA-bot-token", chatId: "-1001234567890" },
	discord: {
		mode: "app",
		botToken: "MTIz.abc.bot-token",
		publicKey: "a".repeat(64),
		channelId: "1234567890",
	},
	slack: {
		mode: "app",
		botToken: "xoxb-1-2-bot-token",
		signingSecret: "8f742231b10e8888abcd99yyyzzz85a5",
		channelId: "C0123ABCD",
	},
	email: { address: "user@example.test" },
} as const;

// Every value here must never survive maskChannelConfig, for any kind.
const CREDENTIALS = [
	"tk_secret",
	"123456:AA-bot-token",
	"MTIz.abc.bot-token",
	"xoxb-1-2-bot-token",
	"8f742231b10e8888abcd99yyyzzz85a5",
	"wh-secret",
	"a".repeat(64),
];

describe("channelConfigSchema", () => {
	it("accepts a valid ntfy config", () => {
		const parsed = channelConfigSchema.ntfy.safeParse({
			serverUrl: "https://ntfy.sh",
			topic: "my-topic",
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects unknown keys", () => {
		const parsed = channelConfigSchema.ntfy.safeParse({
			serverUrl: "https://ntfy.sh",
			topic: "my-topic",
			extra: "nope",
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a non-HTTP scheme", () => {
		expect(
			channelConfigSchema.ntfy.safeParse({
				serverUrl: "file:///etc/passwd",
				topic: "t",
			}).success,
		).toBe(false);
	});

	it("caps the topic length", () => {
		expect(
			channelConfigSchema.ntfy.safeParse({
				serverUrl: "https://ntfy.sh",
				topic: "x".repeat(1_000),
			}).success,
		).toBe(false);
	});

	// The token is sent as an Authorization header. A CR/LF/NUL in it makes
	// header construction throw a TypeError that embeds the token itself, which
	// would then be persisted as a delivery error. Rejected at write time so it
	// can never reach storage.
	it.each([
		["CRLF", "bad\r\nX-Injected: yes"],
		["bare LF", "bad\nvalue"],
		["NUL", "bad\0value"],
		["a space", "bad value"],
		["non-ASCII", "tökén"],
		["empty", ""],
	])("rejects a token containing %s", (_case, token) => {
		expect(
			channelConfigSchema.ntfy.safeParse({
				serverUrl: "https://ntfy.sh",
				topic: "t",
				token,
			}).success,
		).toBe(false);
	});

	it("accepts a printable-ASCII token and an absent one", () => {
		for (const config of [
			{ serverUrl: "https://ntfy.sh", topic: "t", token: "tk_A1-b2.c3~" },
			{ serverUrl: "https://ntfy.sh", topic: "t" },
		]) {
			expect(channelConfigSchema.ntfy.safeParse(config).success).toBe(true);
		}
	});

	it.each(
		Object.entries(VALID_CONFIGS),
	)("accepts a valid %s config", (kind) => {
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse(
				VALID_CONFIGS[kind as keyof typeof VALID_CONFIGS],
			).success,
		).toBe(true);
	});

	it.each(Object.keys(VALID_CONFIGS))("rejects unknown keys on %s", (kind) => {
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse({
				...VALID_CONFIGS[kind as keyof typeof VALID_CONFIGS],
				extra: "nope",
			}).success,
		).toBe(false);
	});

	// Same header-injection hazard as the ntfy token: these all ride in an
	// Authorization header.
	it.each([
		["telegram", "botToken"],
		["discord", "botToken"],
		["slack", "botToken"],
		["slack", "signingSecret"],
	])("rejects a %s %s containing CRLF", (kind, field) => {
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse({
				...VALID_CONFIGS[kind as "telegram" | "discord" | "slack"],
				[field]: "bad\r\nX-Injected: yes",
			}).success,
		).toBe(false);
	});

	it.each([
		["telegram botToken", "telegram", { botToken: "t".repeat(4_000) }],
		["telegram chatId", "telegram", { chatId: "1".repeat(4_000) }],
		["discord botToken", "discord", { botToken: "t".repeat(4_000) }],
		["discord channelId", "discord", { channelId: "1".repeat(4_000) }],
		["slack signingSecret", "slack", { signingSecret: "s".repeat(4_000) }],
		["slack channelId", "slack", { channelId: "C".repeat(4_000) }],
		[
			"discord webhookUrl",
			"discord",
			{
				mode: "webhook",
				webhookUrl: `https://discord.com/api/webhooks/1/${"x".repeat(4_000)}`,
			},
		],
		["email address", "email", { address: `${"a".repeat(250)}@example.test` }],
	])("caps the length of %s", (_case, kind, patch) => {
		const base =
			"mode" in patch ? {} : VALID_CONFIGS[kind as keyof typeof VALID_CONFIGS];
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse({ ...base, ...patch })
				.success,
		).toBe(false);
	});

	it("rejects a non-HTTP webhook URL", () => {
		expect(
			channelConfigSchema.discord.safeParse({
				mode: "webhook",
				webhookUrl: "file:///etc/passwd",
			}).success,
		).toBe(false);
	});

	// The last path segment of these URLs is the bearer credential, and
	// redactChannelUrl only strips it for the provider's own hosts. A foreign host
	// would therefore keep its secret in any persisted delivery error.
	it.each([
		["discord", "https://anything.example/w/SECRET"],
		["discord", "https://notdiscord.com.evil.test/api/webhooks/1/SECRET"],
		["discord", "https://hooks.slack.com/services/T1/B1/SECRET"],
		["slack", "https://anything.example/w/SECRET"],
		["slack", "https://hooks.slack.com.evil.test/services/T1/B1/SECRET"],
		["slack", "https://discord.com/api/webhooks/1/SECRET"],
	])("rejects a foreign-host %s webhook URL", (kind, webhookUrl) => {
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse({
				mode: "webhook",
				webhookUrl,
			}).success,
		).toBe(false);
	});

	it.each([
		["discord", "https://discord.com/api/webhooks/123/wh-secret"],
		["discord", "https://discordapp.com/api/webhooks/123/wh-secret"],
		["discord", "https://canary.discord.com/api/webhooks/123/wh-secret"],
		["slack", "https://hooks.slack.com/services/T1/B1/wh-secret"],
	])("accepts a legitimate %s webhook host", (kind, webhookUrl) => {
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse({
				mode: "webhook",
				webhookUrl,
			}).success,
		).toBe(true);
	});

	// Mixing branches is how a webhook-mode config would smuggle in the bot
	// token that makes interactive components representable.
	it("rejects an app-mode credential inside webhook mode", () => {
		expect(
			channelConfigSchema.discord.safeParse({
				...DISCORD_WEBHOOK,
				botToken: "Bot.abc",
			}).success,
		).toBe(false);
	});

	it("rejects a webhookUrl inside app mode", () => {
		expect(
			channelConfigSchema.slack.safeParse({
				...VALID_CONFIGS.slack,
				webhookUrl: "https://hooks.slack.com/services/T/B/secret",
			}).success,
		).toBe(false);
	});

	it.each([
		["not-hex".padEnd(64, "z")],
		["ab"],
		["a".repeat(63)],
	])("rejects a discord publicKey that is not 64 hex chars", (publicKey) => {
		expect(
			channelConfigSchema.discord.safeParse({
				...VALID_CONFIGS.discord,
				publicKey,
			}).success,
		).toBe(false);
	});

	it("rejects a malformed email address", () => {
		expect(
			channelConfigSchema.email.safeParse({ address: "not-an-address" })
				.success,
		).toBe(false);
	});
});

describe("maskChannelConfig", () => {
	it("masks secret fields and keeps the rest", () => {
		expect(
			maskChannelConfig("ntfy", {
				serverUrl: "https://ntfy.sh",
				topic: "t",
				token: "secret",
			}),
		).toEqual({ serverUrl: "https://ntfy.sh", topic: "t", token: MASKED });
	});

	// Default-deny: a key that is not an explicitly known-public field must be
	// masked, even if it is not in any known secret-field list (e.g. leftover
	// from an older, unvalidated config shape).
	it("masks an unrecognized field by default instead of leaking it", () => {
		expect(
			maskChannelConfig("ntfy", {
				serverUrl: "https://ntfy.sh",
				topic: "t",
				legacySecret: "leaked-if-allow-listed-wrong",
			}),
		).toEqual({
			serverUrl: "https://ntfy.sh",
			topic: "t",
			legacySecret: MASKED,
		});
	});

	it.each([
		...Object.entries(VALID_CONFIGS),
		["discord", DISCORD_WEBHOOK],
		["slack", SLACK_WEBHOOK],
	])("leaks no credential from a %s config", (kind, config) => {
		const serialized = JSON.stringify(
			maskChannelConfig(kind as ChannelKind, config),
		);
		for (const credential of CREDENTIALS) {
			expect(serialized).not.toContain(credential);
		}
	});

	it.each([
		["telegram", "chatId", "-1001234567890"],
		["discord", "mode", "app"],
		["discord", "channelId", "1234567890"],
		["slack", "mode", "app"],
		["slack", "channelId", "C0123ABCD"],
		// A destination identifier, like chatId/channelId. Masking it would hide
		// the user's own address from the only reader of a masked config, and make
		// a config that is nothing but the address unverifiable in the form.
		["email", "address", "user@example.test"],
	])("keeps %s.%s public", (kind, field, value) => {
		expect(
			maskChannelConfig(
				kind as ChannelKind,
				VALID_CONFIGS[kind as "telegram" | "discord" | "slack" | "email"],
			)[field],
		).toBe(value);
	});
});

describe("restoreChannelConfig", () => {
	it("restores a masked field from the previous config", () => {
		const restored = restoreChannelConfig(
			"ntfy",
			{ serverUrl: "https://ntfy.sh", topic: "t", token: MASKED },
			{
				kind: "ntfy",
				config: { serverUrl: "https://old", topic: "t", token: "real" },
			},
		);
		expect(restored.token).toBe("real");
	});

	it("keeps a newly supplied value", () => {
		const restored = restoreChannelConfig(
			"ntfy",
			{ serverUrl: "https://ntfy.sh", topic: "t", token: "fresh" },
			{
				kind: "ntfy",
				config: { serverUrl: "https://old", topic: "t", token: "real" },
			},
		);
		expect(restored.token).toBe("fresh");
	});

	it("drops a masked field when there is no previous config", () => {
		const restored = restoreChannelConfig(
			"ntfy",
			{ serverUrl: "https://ntfy.sh", topic: "t", token: MASKED },
			null,
		);
		expect("token" in restored).toBe(false);
	});

	// A channel id reused across a kind change must not inherit the old secret.
	it("drops a masked field when the previous kind differs", () => {
		const restored = restoreChannelConfig(
			"ntfy",
			{ serverUrl: "https://ntfy.sh", topic: "t", token: MASKED },
			{ kind: "telegram", config: { botToken: "real", chatId: "1" } },
		);
		expect("token" in restored).toBe(false);
	});

	// An own `__proto__` key in the request body must be an ordinary property on
	// the result, not a reparenting of the accumulator.
	it("does not let a __proto__ key in the body reparent the result", () => {
		const incoming = JSON.parse(
			'{"serverUrl":"https://ntfy.sh","topic":"t","__proto__":{"polluted":true}}',
		);
		const restored = restoreChannelConfig("ntfy", incoming, null);
		expect(Object.hasOwn(restored, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(restored)).toBe(null);
		// Zod skips `__proto__` rather than rejecting it as an unknown key, so
		// `.strict()` is not what keeps this contained.
		expect(
			Object.keys(channelConfigSchema.ntfy.parse(restored) as object),
		).toEqual(["serverUrl", "topic"]);
	});

	// Same key, but masked: it must be looked up with hasOwn on the previous
	// config, and inherited members of that object must never be carried forward.
	it("does not carry an inherited key forward for a masked field", () => {
		const restored = restoreChannelConfig(
			"ntfy",
			{ serverUrl: "https://ntfy.sh", topic: "t", toString: MASKED },
			{ kind: "ntfy", config: { serverUrl: "https://old", topic: "t" } },
		);
		expect("toString" in restored).toBe(false);
	});

	it.each(
		Object.keys(VALID_CONFIGS),
	)("round-trips a masked %s config back to the stored one", (kind) => {
		const config = VALID_CONFIGS[kind as keyof typeof VALID_CONFIGS];
		const restored = restoreChannelConfig(
			kind as ChannelKind,
			maskChannelConfig(kind as ChannelKind, config),
			{ kind: kind as ChannelKind, config },
		);
		expect(restored).toEqual(config);
		expect(
			channelConfigSchema[kind as ChannelKind].safeParse(restored).success,
		).toBe(true);
	});

	// A mode change describes a different credential set. The save path always
	// loads `previous` by kind, so the kind guard never fires there -- mode is
	// the live one.
	it.each([
		["discord", DISCORD_WEBHOOK],
		["slack", SLACK_WEBHOOK],
	])("drops masked credentials when %s switches webhook -> app", (kind, webhookConfig) => {
		const restored = restoreChannelConfig(
			kind as ChannelKind,
			{
				...maskChannelConfig(
					kind as ChannelKind,
					VALID_CONFIGS[kind as "discord" | "slack"],
				),
				webhookUrl: MASKED,
			},
			{ kind: kind as ChannelKind, config: webhookConfig },
		);
		expect(restored.webhookUrl).toBeUndefined();
		expect(restored.botToken).toBeUndefined();
		expect(JSON.stringify(restored)).not.toContain("wh-secret");
	});

	it.each([
		["discord", DISCORD_WEBHOOK],
		["slack", SLACK_WEBHOOK],
	])("drops masked credentials when %s switches app -> webhook", (kind, webhookConfig) => {
		// The settings form echoes back every field it rendered, so the incoming
		// payload carries the other mode's masked keys too.
		const restored = restoreChannelConfig(
			kind as ChannelKind,
			{
				...maskChannelConfig(kind as ChannelKind, webhookConfig),
				botToken: MASKED,
				signingSecret: MASKED,
				publicKey: MASKED,
			},
			{
				kind: kind as ChannelKind,
				config: VALID_CONFIGS[kind as "discord" | "slack"],
			},
		);
		expect(restored.webhookUrl).toBeUndefined();
		expect(restored.botToken).toBeUndefined();
		expect(restored.signingSecret).toBeUndefined();
		expect(restored.publicKey).toBeUndefined();
	});
});

describe("redactChannelUrl", () => {
	it("redacts a telegram bot token in the path", () => {
		expect(
			redactChannelUrl("https://api.telegram.org/bot12345:AAA/sendMessage"),
		).toBe("https://api.telegram.org/bot[REDACTED]/sendMessage");
	});

	it("redacts a discord webhook secret segment", () => {
		expect(
			redactChannelUrl("https://discord.com/api/webhooks/123/abcdefsecret"),
		).toBe("https://discord.com/api/webhooks/123/[REDACTED]");
	});

	it("does not match a lookalike host by substring", () => {
		expect(redactChannelUrl("https://notdiscord.com.evil.test/a/b")).toBe(
			"https://notdiscord.com.evil.test/a/b",
		);
	});

	it("leaves an ordinary URL alone", () => {
		expect(redactChannelUrl("https://ntfy.sh/my-topic")).toBe(
			"https://ntfy.sh/my-topic",
		);
	});

	it("does not throw on an unparseable URL", () => {
		expect(() => redactChannelUrl("not a url")).not.toThrow();
	});

	it("strips userinfo credentials from an ordinary URL", () => {
		expect(redactChannelUrl("https://user:pass@ntfy.sh/my-topic")).toBe(
			"https://ntfy.sh/my-topic",
		);
	});

	it("does not mistake a webhook id for the secret on a trailing slash", () => {
		expect(redactChannelUrl("https://discord.com/api/webhooks/123/")).toBe(
			"https://discord.com/api/webhooks/123/",
		);
	});

	// The ack token is a bearer capability on the deployment's own origin, so no
	// host rule catches it. Shape mirrors dispatch.ts's mintAckUrl.
	it("redacts the ack capability token on the app's own origin", () => {
		const token = "xS3-t0k3n_abcDEF";
		const redacted = redactChannelUrl(
			`https://app.example.test/api/notifications/ack/${token}`,
		);
		expect(redacted).not.toContain(token);
		expect(redacted).toBe(
			"https://app.example.test/api/notifications/ack/[REDACTED]",
		);
	});

	it("redacts an ack token embedded in an error message", () => {
		const token = "xS3-t0k3n_abcDEF";
		const sanitized = redactUrlsIn(
			`ntfy rejected https://app.example.test/api/notifications/ack/${token} with 502`,
		);
		expect(sanitized).not.toContain(token);
	});
});
