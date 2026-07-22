import { describe, expect, test } from "vitest";
import {
	channelKeyRing,
	decryptChannelConfig,
	encryptChannelConfig,
	reencryptChannelConfig,
} from "./channel-config.ts";
import { createFieldKeyRing } from "./field-encryption.ts";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER = Buffer.alloc(32, 4).toString("base64");
const NEXT = Buffer.alloc(32, 5).toString("base64");
const ring = createFieldKeyRing({ current: KEY });

const CONFIG = {
	serverUrl: "https://ntfy.example",
	topic: "alerts",
	token: "tk_supersecret",
};

describe("channel config encryption", () => {
	test("public fields stay plaintext, secrets become envelopes", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(stored.serverUrl).toBe(CONFIG.serverUrl);
		expect(stored.topic).toBe(CONFIG.topic);
		expect(stored.token).not.toBe(CONFIG.token);
		expect(stored.token).toMatch(/^ditero:v1:/);
		expect(JSON.stringify(stored)).not.toContain(CONFIG.token);
	});

	test("round-trips through decrypt", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(decryptChannelConfig("ntfy", stored, ring)).toEqual(CONFIG);
	});

	test("re-encrypting an already-enveloped value is a no-op", () => {
		const once = encryptChannelConfig("ntfy", CONFIG, ring);
		const twice = encryptChannelConfig("ntfy", once, ring);
		expect(twice.token).toBe(once.token);
	});

	test("legacy plaintext secrets still read", () => {
		expect(decryptChannelConfig("ntfy", CONFIG, ring)).toEqual(CONFIG);
	});

	test("a wrong key fails loud rather than leaking a ciphertext as a token", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(() =>
			decryptChannelConfig(
				"ntfy",
				stored,
				createFieldKeyRing({ current: OTHER }),
			),
		).toThrow(/authentication failed/);
	});

	test("an encrypted config with no key configured throws", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(() => decryptChannelConfig("ntfy", stored, null)).toThrow(
			/no encryption key/,
		);
	});

	test("the envelope is bound to its kind and field", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(() =>
			decryptChannelConfig("telegram", { token: stored.token }, ring),
		).toThrow(/authentication failed/);
	});

	// The backfill's whole reason to exist during a rotation. encryptChannelConfig
	// cannot do this -- it skips anything already enveloped -- so a missing
	// rotation path leaves every secret under the retired key.
	test("re-envelopes an existing secret onto the next key", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		const rotating = createFieldKeyRing({ current: KEY, next: NEXT });

		const rotated = reencryptChannelConfig("ntfy", stored, rotating);
		expect(rotated.token).not.toBe(stored.token);

		// The point: the old key alone can no longer read it, the new key alone can.
		const nextOnly = createFieldKeyRing({ current: NEXT });
		expect(decryptChannelConfig("ntfy", rotated, nextOnly)).toEqual(CONFIG);
		expect(() =>
			decryptChannelConfig(
				"ntfy",
				rotated,
				createFieldKeyRing({ current: KEY }),
			),
		).toThrow(/authentication failed/);
	});

	test("re-encrypting under the same key rewrites nothing", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring);
		expect(reencryptChannelConfig("ntfy", stored, ring)).toEqual(stored);
	});

	test("the rotation pass also envelopes a legacy plaintext secret", () => {
		const rotating = createFieldKeyRing({ current: KEY, next: NEXT });
		const rotated = reencryptChannelConfig("ntfy", CONFIG, rotating);
		expect(rotated.token).toMatch(/^ditero:v1:/);
		expect(JSON.stringify(rotated)).not.toContain(CONFIG.token);
		expect(
			decryptChannelConfig(
				"ntfy",
				rotated,
				createFieldKeyRing({ current: NEXT }),
			),
		).toEqual(CONFIG);
	});

	test("channelKeyRing is null without a configured key", () => {
		expect(channelKeyRing({} as NodeJS.ProcessEnv)).toBeNull();
		expect(
			channelKeyRing({ DITERO_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv),
		).not.toBeNull();
	});
});
