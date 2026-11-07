import { describe, expect, test } from "vitest";
import {
	channelKeyRing,
	decryptChannelConfig,
	encryptChannelConfig,
	reencryptChannelConfig,
} from "./channel-config.ts";
import { createFieldKeyRing, encryptField } from "./field-encryption.ts";

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
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(stored.serverUrl).toBe(CONFIG.serverUrl);
		expect(stored.topic).toBe(CONFIG.topic);
		expect(stored.token).not.toBe(CONFIG.token);
		expect(stored.token).toMatch(/^ditero:channel:v2:/);
		expect(JSON.stringify(stored)).not.toContain(CONFIG.token);
	});

	test("round-trips through decrypt", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(decryptChannelConfig("ntfy", stored, ring, "owner")).toEqual(CONFIG);
	});

	test("a submitted envelope is encrypted as literal text, never adopted", () => {
		const once = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		const twice = encryptChannelConfig("ntfy", once, ring, "owner");
		expect(twice.token).not.toBe(once.token);
		expect(decryptChannelConfig("ntfy", twice, ring, "owner").token).toBe(
			once.token,
		);
	});

	test("owner-bound secrets cannot move between owners or downgrade to legacy", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(() => decryptChannelConfig("ntfy", stored, ring, "other")).toThrow(
			/authentication failed/,
		);
		expect(() =>
			decryptChannelConfig(
				"ntfy",
				{
					...stored,
					token: (stored.token as string).slice("ditero:channel:v2:".length),
				},
				ring,
				"owner",
			),
		).toThrow(/authentication failed/);
	});

	test("legacy ciphertext stays readable and backfills to the owner and next key", () => {
		const legacy = {
			...CONFIG,
			token: encryptField(
				CONFIG.token,
				"notification-channel:ntfy:token",
				ring,
			),
		};
		expect(decryptChannelConfig("ntfy", legacy, ring, "owner")).toEqual(CONFIG);
		const rotating = createFieldKeyRing({ current: KEY, next: NEXT });
		const upgraded = reencryptChannelConfig("ntfy", legacy, rotating, "owner");
		const next = createFieldKeyRing({ current: NEXT });
		expect(decryptChannelConfig("ntfy", upgraded, next, "owner")).toEqual(
			CONFIG,
		);
		expect(() => decryptChannelConfig("ntfy", upgraded, next, "other")).toThrow(
			/authentication failed/,
		);
		expect(reencryptChannelConfig("ntfy", upgraded, next, "owner")).toEqual(
			upgraded,
		);
	});

	test("legacy plaintext secrets still read", () => {
		expect(decryptChannelConfig("ntfy", CONFIG, ring, "owner")).toEqual(CONFIG);
	});

	test("a wrong key fails loud rather than leaking a ciphertext as a token", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(() =>
			decryptChannelConfig(
				"ntfy",
				stored,
				createFieldKeyRing({ current: OTHER }),
				"owner",
			),
		).toThrow(/authentication failed/);
	});

	test("an encrypted config with no key configured throws", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(() => decryptChannelConfig("ntfy", stored, null, "owner")).toThrow(
			/no encryption key/,
		);
	});

	test("the envelope is bound to its kind and field", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(() =>
			decryptChannelConfig("telegram", { token: stored.token }, ring, "owner"),
		).toThrow(/authentication failed/);
	});

	test("re-envelopes an existing secret onto the next key", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		const rotating = createFieldKeyRing({ current: KEY, next: NEXT });

		const rotated = reencryptChannelConfig("ntfy", stored, rotating, "owner");
		expect(rotated.token).not.toBe(stored.token);

		// The point: the old key alone can no longer read it, the new key alone can.
		const nextOnly = createFieldKeyRing({ current: NEXT });
		expect(decryptChannelConfig("ntfy", rotated, nextOnly, "owner")).toEqual(
			CONFIG,
		);
		expect(() =>
			decryptChannelConfig(
				"ntfy",
				rotated,
				createFieldKeyRing({ current: KEY }),
				"owner",
			),
		).toThrow(/authentication failed/);
	});

	test("re-encrypting under the same key rewrites nothing", () => {
		const stored = encryptChannelConfig("ntfy", CONFIG, ring, "owner");
		expect(reencryptChannelConfig("ntfy", stored, ring, "owner")).toEqual(
			stored,
		);
	});

	test("the rotation pass also envelopes a legacy plaintext secret", () => {
		const rotating = createFieldKeyRing({ current: KEY, next: NEXT });
		const rotated = reencryptChannelConfig("ntfy", CONFIG, rotating, "owner");
		expect(rotated.token).toMatch(/^ditero:channel:v2:/);
		expect(JSON.stringify(rotated)).not.toContain(CONFIG.token);
		expect(
			decryptChannelConfig(
				"ntfy",
				rotated,
				createFieldKeyRing({ current: NEXT }),
				"owner",
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
