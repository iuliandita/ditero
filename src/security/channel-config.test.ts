import { describe, expect, test } from "vitest";
import {
	channelKeyRing,
	decryptChannelConfig,
	encryptChannelConfig,
	isEncryptedChannelValue,
} from "./channel-config.ts";
import { createFieldKeyRing } from "./field-encryption.ts";

const KEY = Buffer.alloc(32, 3).toString("base64");
const OTHER = Buffer.alloc(32, 4).toString("base64");
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
		expect(isEncryptedChannelValue(stored.token)).toBe(true);
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

	test("channelKeyRing is null without a configured key", () => {
		expect(channelKeyRing({} as NodeJS.ProcessEnv)).toBeNull();
		expect(
			channelKeyRing({ DITERO_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv),
		).not.toBeNull();
	});
});
