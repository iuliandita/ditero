import { describe, expect, it } from "vitest";
import {
	channelConfigSchema,
	MASKED,
	maskChannelConfig,
	redactChannelUrl,
	restoreChannelConfig,
} from "./notification-channel.ts";

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
});
