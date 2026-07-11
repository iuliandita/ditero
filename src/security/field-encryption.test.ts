import { describe, expect, test } from "vitest";
import {
	createFieldKeyRing,
	decryptField,
	encryptField,
	fingerprintKey,
	hashPAT,
	reencryptField,
} from "./field-encryption.ts";

const oldKey = Buffer.alloc(32, 1).toString("base64");
const newKey = Buffer.alloc(32, 2).toString("base64");

describe("field encryption", () => {
	test("round-trips with context-bound AES-256-GCM", () => {
		const ring = createFieldKeyRing({ current: oldKey });
		const encrypted = encryptField("replayable-secret", "channel:123", ring);

		expect(encrypted).not.toContain("replayable-secret");
		expect(decryptField(encrypted, "channel:123", ring)).toEqual({
			plaintext: "replayable-secret",
			needsRotation: false,
		});
		expect(() => decryptField(encrypted, "channel:456", ring)).toThrow();
	});

	test("rejects modified ciphertext", () => {
		const ring = createFieldKeyRing({ current: oldKey });
		const encrypted = encryptField("secret", "oauth:1", ring);
		const parts = encrypted.split(":");
		const tag = Buffer.from(parts[5], "base64url");
		tag[0] ^= 1;
		parts[5] = tag.toString("base64url");
		const modified = parts.join(":");
		expect(() => decryptField(modified, "oauth:1", ring)).toThrow();
	});

	test("writes with the next key and migrates old envelopes", () => {
		const oldRing = createFieldKeyRing({ current: oldKey });
		const rotatingRing = createFieldKeyRing({
			current: oldKey,
			next: newKey,
		});
		const oldEnvelope = encryptField("secret", "webhook:1", oldRing);

		expect(decryptField(oldEnvelope, "webhook:1", rotatingRing)).toMatchObject({
			plaintext: "secret",
			needsRotation: true,
		});
		const migrated = reencryptField(oldEnvelope, "webhook:1", rotatingRing);
		expect(migrated).not.toBe(oldEnvelope);
		expect(
			decryptField(
				migrated,
				"webhook:1",
				createFieldKeyRing({ current: newKey }),
			),
		).toMatchObject({ plaintext: "secret", needsRotation: false });
	});

	test("uses a stable non-secret key fingerprint", () => {
		expect(fingerprintKey(oldKey)).toBe(fingerprintKey(oldKey));
		expect(fingerprintKey(oldKey)).not.toBe(fingerprintKey(newKey));
		expect(fingerprintKey(oldKey)).not.toContain(oldKey);
	});

	test("hashes PATs without storing the token", () => {
		const token = "ditero_pat_0123456789abcdefghijklmnopqrstuvwxyz";
		expect(hashPAT(token)).toBe(hashPAT(token));
		expect(hashPAT(token)).not.toContain(token);
		expect(hashPAT(`${token}x`)).not.toBe(hashPAT(token));
	});

	test("rejects keys that are not 256 bits", () => {
		expect(() => createFieldKeyRing({ current: "not-a-key" })).toThrow(
			/32 bytes/i,
		);
	});
});
