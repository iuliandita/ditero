import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	constantTimeEquals,
	DISCORD_MAX_SKEW_MS,
	SLACK_MAX_SKEW_MS,
	verifyDiscordSignature,
	verifySlackSignature,
	verifyTelegramSecret,
} from "./channel-signature.ts";

function ed25519Pair() {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const spki = publicKey.export({ format: "der", type: "spki" });
	return { publicKeyHex: spki.subarray(-32).toString("hex"), privateKey };
}

const BODY = new TextEncoder().encode('{"type":1,"id":"abc"}');

function discordSign(
	privateKey: ReturnType<typeof ed25519Pair>["privateKey"],
	timestamp: string,
	body: Uint8Array,
): string {
	const message = Buffer.concat([Buffer.from(timestamp, "utf8"), body]);
	return sign(null, message, privateKey).toString("hex");
}

describe("verifyDiscordSignature", () => {
	const { publicKeyHex, privateKey } = ed25519Pair();
	const timestamp = "1784500000";
	const now = Number(timestamp) * 1000;
	const signature = discordSign(privateKey, timestamp, BODY);

	it("accepts a valid signature", () => {
		expect(
			verifyDiscordSignature(publicKeyHex, signature, timestamp, BODY, now),
		).toBe(true);
	});

	it("rejects a body that differs by one byte", () => {
		const forged = new TextEncoder().encode('{"type":2,"id":"abc"}');
		expect(
			verifyDiscordSignature(publicKeyHex, signature, timestamp, forged, now),
		).toBe(false);
	});

	it("rejects a signature over a different timestamp", () => {
		expect(
			verifyDiscordSignature(publicKeyHex, signature, "1784500001", BODY, now),
		).toBe(false);
	});

	it("rejects a truncated signature", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				signature.slice(0, -2),
				timestamp,
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects a signature made with another key", () => {
		const other = ed25519Pair();
		const otherSignature = discordSign(other.privateKey, timestamp, BODY);
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				otherSignature,
				timestamp,
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects a malformed public key without throwing", () => {
		expect(
			verifyDiscordSignature("zzzz", signature, timestamp, BODY, now),
		).toBe(false);
		expect(verifyDiscordSignature("ab", signature, timestamp, BODY, now)).toBe(
			false,
		);
	});

	it("rejects malformed hex in the signature without throwing", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				"z".repeat(128),
				timestamp,
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects empty inputs", () => {
		expect(verifyDiscordSignature("", signature, timestamp, BODY, now)).toBe(
			false,
		);
		expect(verifyDiscordSignature(publicKeyHex, "", timestamp, BODY, now)).toBe(
			false,
		);
		expect(verifyDiscordSignature(publicKeyHex, signature, "", BODY, now)).toBe(
			false,
		);
	});

	it("rejects an expired timestamp", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				signature,
				timestamp,
				BODY,
				now + DISCORD_MAX_SKEW_MS + 1_000,
			),
		).toBe(false);
	});

	it("rejects a future timestamp", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				signature,
				timestamp,
				BODY,
				now - DISCORD_MAX_SKEW_MS - 1_000,
			),
		).toBe(false);
	});

	it("accepts exactly at the window boundary in both directions", () => {
		for (const at of [now + DISCORD_MAX_SKEW_MS, now - DISCORD_MAX_SKEW_MS]) {
			expect(
				verifyDiscordSignature(publicKeyHex, signature, timestamp, BODY, at),
			).toBe(true);
		}
	});

	it("rejects one millisecond past the window boundary", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				signature,
				timestamp,
				BODY,
				now + DISCORD_MAX_SKEW_MS + 1,
			),
		).toBe(false);
	});

	// A non-numeric timestamp makes the skew comparison NaN, which is never
	// greater than the window -- so a bad format has to be rejected outright, or
	// it is a replay-window bypass with an otherwise valid signature.
	it("rejects a malformed timestamp even when the signature matches it", () => {
		expect(
			verifyDiscordSignature(
				publicKeyHex,
				discordSign(privateKey, "not-a-number", BODY),
				"not-a-number",
				BODY,
				now,
			),
		).toBe(false);
	});
});

describe("verifySlackSignature", () => {
	const secret = "8f742231b10e8888abcd99yyyzzz85a5";
	const timestamp = "1784500000";
	const now = Number(timestamp) * 1000;

	function slackSign(key: string, ts: string, body: Uint8Array): string {
		const base = Buffer.concat([
			Buffer.from(`v0:${ts}:`, "utf8"),
			Buffer.from(body),
		]);
		return `v0=${createHmac("sha256", key).update(base).digest("hex")}`;
	}

	const signature = slackSign(secret, timestamp, BODY);

	it("accepts a valid signature", () => {
		expect(verifySlackSignature(secret, signature, timestamp, BODY, now)).toBe(
			true,
		);
	});

	it("rejects a forged body", () => {
		const forged = new TextEncoder().encode('{"type":1,"id":"abd"}');
		expect(
			verifySlackSignature(secret, signature, timestamp, forged, now),
		).toBe(false);
	});

	it("rejects a truncated signature", () => {
		expect(
			verifySlackSignature(
				secret,
				signature.slice(0, -4),
				timestamp,
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects a signature made with the wrong secret", () => {
		const wrong = slackSign("other-secret", timestamp, BODY);
		expect(verifySlackSignature(secret, wrong, timestamp, BODY, now)).toBe(
			false,
		);
	});

	it("rejects a signature missing the v0= prefix", () => {
		expect(
			verifySlackSignature(
				secret,
				signature.slice("v0=".length),
				timestamp,
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects an expired timestamp", () => {
		const stale = now + SLACK_MAX_SKEW_MS + 1_000;
		expect(
			verifySlackSignature(secret, signature, timestamp, BODY, stale),
		).toBe(false);
	});

	it("rejects a future timestamp", () => {
		const behind = now - SLACK_MAX_SKEW_MS - 1_000;
		expect(
			verifySlackSignature(secret, signature, timestamp, BODY, behind),
		).toBe(false);
	});

	it("accepts exactly at the window boundary in both directions", () => {
		expect(
			verifySlackSignature(
				secret,
				signature,
				timestamp,
				BODY,
				now + SLACK_MAX_SKEW_MS,
			),
		).toBe(true);
		expect(
			verifySlackSignature(
				secret,
				signature,
				timestamp,
				BODY,
				now - SLACK_MAX_SKEW_MS,
			),
		).toBe(true);
	});

	it("rejects one millisecond past the window boundary", () => {
		expect(
			verifySlackSignature(
				secret,
				signature,
				timestamp,
				BODY,
				now + SLACK_MAX_SKEW_MS + 1,
			),
		).toBe(false);
	});

	// A non-numeric timestamp makes the skew comparison NaN, which is never
	// greater than the window -- so a bad format must be rejected outright, or it
	// is a replay-window bypass with an otherwise valid signature.
	it("rejects a malformed timestamp even when the signature matches it", () => {
		expect(
			verifySlackSignature(
				secret,
				slackSign(secret, "not-a-number", BODY),
				"not-a-number",
				BODY,
				now,
			),
		).toBe(false);
		expect(
			verifySlackSignature(
				secret,
				slackSign(secret, "17845e5", BODY),
				"17845e5",
				BODY,
				now,
			),
		).toBe(false);
	});

	it("rejects an unconfigured (empty) secret even when the signature matches it", () => {
		const forged = slackSign("", timestamp, BODY);
		expect(verifySlackSignature("", forged, timestamp, BODY, now)).toBe(false);
	});

	it("rejects empty signature or timestamp", () => {
		expect(verifySlackSignature(secret, "", timestamp, BODY, now)).toBe(false);
		expect(verifySlackSignature(secret, signature, "", BODY, now)).toBe(false);
	});
});

// The helpers above re-implement the base-string framing the module builds, so a
// matching mistake in both would pass while rejecting every real callback. These
// vectors are frozen literals: they pin the framing to the provider, not to us.
describe("golden vectors", () => {
	// Verbatim from Slack's own request-verification documentation
	// (docs.slack.dev/authentication/verifying-requests-from-slack), retrieved
	// 2026-07-22.
	const SLACK_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
	const SLACK_TIMESTAMP = "1531420618";
	const SLACK_BODY =
		"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
	const SLACK_SIGNATURE =
		"v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

	// Discord publishes no vector, so this one is locally generated and frozen:
	// a fixed Ed25519 keypair signing `timestamp + body` once, hex-encoded.
	const DISCORD_PUBLIC_KEY =
		"dd74e21b0698ca4a6a983a7134a422d4b353611e0029dee93197d0cb57efee99";
	const DISCORD_TIMESTAMP = "1784500000";
	const DISCORD_BODY = '{"type":1}';
	const DISCORD_SIGNATURE =
		"19b5f25cadc7328f685e47836d3465336e3d8735a89cbecc09cdd2d362aade414cffdee34f2968784057dc4175b8b1019f642823146ab17967e85b6a0d397109";

	it("verifies Slack's published example signature", () => {
		expect(
			verifySlackSignature(
				SLACK_SECRET,
				SLACK_SIGNATURE,
				SLACK_TIMESTAMP,
				new TextEncoder().encode(SLACK_BODY),
				Number(SLACK_TIMESTAMP) * 1000,
			),
		).toBe(true);
	});

	it("verifies the frozen Discord vector", () => {
		expect(
			verifyDiscordSignature(
				DISCORD_PUBLIC_KEY,
				DISCORD_SIGNATURE,
				DISCORD_TIMESTAMP,
				new TextEncoder().encode(DISCORD_BODY),
				Number(DISCORD_TIMESTAMP) * 1000,
			),
		).toBe(true);
	});
});

describe("verifyTelegramSecret", () => {
	const secret = "a".repeat(32);

	it("accepts the matching header", () => {
		expect(verifyTelegramSecret(secret, secret)).toBe(true);
	});

	it("rejects a wrong header", () => {
		expect(verifyTelegramSecret(secret, `${"a".repeat(31)}b`)).toBe(false);
	});

	it("rejects a truncated header", () => {
		expect(verifyTelegramSecret(secret, secret.slice(0, -1))).toBe(false);
	});

	it("rejects a header that is a prefix-extension of the secret", () => {
		expect(verifyTelegramSecret(secret, `${secret}b`)).toBe(false);
	});

	it("rejects an empty or missing header", () => {
		expect(verifyTelegramSecret(secret, "")).toBe(false);
		expect(verifyTelegramSecret("", "")).toBe(false);
		expect(verifyTelegramSecret("", secret)).toBe(false);
	});
});

// `===` is functionally indistinguishable from a constant-time compare, so no
// behavioural assertion can catch a regression to it. This pins the source.
describe("secret comparison stays constant-time", () => {
	// These regexes read the whole file, comments included: a future comment
	// containing `=== signature` will trip them.
	const source = readFileSync(
		new URL("./channel-signature.ts", import.meta.url),
		"utf8",
	);

	it("returns false rather than throwing on length-mismatched inputs", () => {
		expect(constantTimeEquals("short", "much longer value")).toBe(false);
		expect(constantTimeEquals("same", "same")).toBe(true);
	});

	it("compares through timingSafeEqual", () => {
		expect(source).toMatch(/timingSafeEqual\(/);
	});

	it("never compares a secret or signature with an equality operator", () => {
		expect(source).not.toMatch(/[!=]==\s*(signature|header|expected|secret)\b/);
		expect(source).not.toMatch(/\b(signature|header|expected|secret)\s*[!=]==/);
	});

	it("routes both secret comparisons through the helper", () => {
		expect(source).toMatch(/constantTimeEquals\(\s*expected,\s*signature\s*\)/);
		expect(source).toMatch(/constantTimeEquals\(\s*expected,\s*header\s*\)/);
	});
});
