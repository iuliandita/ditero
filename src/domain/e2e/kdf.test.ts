import { describe, expect, it } from "vitest";
import {
	CURRENT_KDF_VERSION,
	deriveKek,
	generateSalt,
	KDF_PARAMS,
	type KekPurpose,
	MAX_SECRET_LENGTH,
} from "./kdf.ts";

describe("KDF_PARAMS", () => {
	// Direction, which the known-answer vector cannot express: it fails
	// identically for a weakening and for a strengthening.
	it("keeps the v1 cost at or above the RFC 9106 second recommended option", () => {
		expect(KDF_PARAMS[1].memorySizeKiB).toBeGreaterThanOrEqual(65536);
		expect(KDF_PARAMS[1].iterations).toBeGreaterThanOrEqual(3);
		expect(KDF_PARAMS[1].hashLength).toBe(32);
	});

	it("derives by default at the current version", () => {
		expect(CURRENT_KDF_VERSION).toBe(1);
	});
});

// Each derivation is memory-hard by design (~0.6s), and the first also pays
// WASM instantiation, which blew vitest's 5s default on a cold loaded run.
describe("deriveKek", { timeout: 30_000 }, () => {
	// Known-answer test. Pins the parameters as APPLIED, the domain-separation
	// string, and the v1 format: every stored wrap re-derives through here.
	// Changing any of them orphans every existing wrap at formatVersion 1 --
	// add a version, do not edit this vector.
	it("matches the v1 known-answer vector", async () => {
		const salt = new Uint8Array(16).fill(0x42);
		expect(
			Buffer.from(
				await deriveKek("correct horse", salt, "passphrase"),
			).toString("hex"),
		).toBe("a1f79fffcf2d70818fca22c5ff22d35e1bc1124e7a6e4630c0f6643ae9f2ef27");
	});

	it("derives the explicit version 1 identically to the default", async () => {
		const salt = generateSalt();
		expect(await deriveKek("s", salt, "passphrase", 1)).toEqual(
			await deriveKek("s", salt, "passphrase"),
		);
	});

	it("is deterministic for the same secret, salt and purpose", async () => {
		const salt = generateSalt();
		const a = await deriveKek("correct horse", salt, "passphrase");
		const b = await deriveKek("correct horse", salt, "passphrase");
		expect(a).toEqual(b);
	});

	it("separates the passphrase and recovery domains", async () => {
		const salt = generateSalt();
		const pass = await deriveKek("same secret", salt, "passphrase");
		const rec = await deriveKek("same secret", salt, "recovery");
		expect(pass).not.toEqual(rec);
	});

	it("differs for a different salt", async () => {
		const a = await deriveKek("s", generateSalt(), "passphrase");
		const b = await deriveKek("s", generateSalt(), "passphrase");
		expect(a).not.toEqual(b);
	});

	it("returns 32 bytes", async () => {
		expect((await deriveKek("s", generateSalt(), "passphrase")).length).toBe(
			32,
		);
	});

	// Without normalisation the same visible passphrase typed on macOS and on
	// Android derives different KEKs, and the failure is indistinguishable from a
	// wrong passphrase. With the recovery code also lost, the key is gone.
	it("derives the same KEK from composed and decomposed forms", async () => {
		const composed = "caf\u00e9";
		const decomposed = "cafe\u0301";
		expect(composed).not.toBe(decomposed);
		const salt = generateSalt();
		expect(await deriveKek(composed, salt, "passphrase")).toEqual(
			await deriveKek(decomposed, salt, "passphrase"),
		);
	});

	it("keeps compatibility-distinct secrets distinct (NFC, not NFKC)", async () => {
		const salt = generateSalt();
		expect(await deriveKek("A", salt, "passphrase")).not.toEqual(
			await deriveKek("\uff21", salt, "passphrase"),
		);
	});

	it("rejects an empty secret", async () => {
		await expect(deriveKek("", generateSalt(), "passphrase")).rejects.toThrow(
			"kdf: E2E secret must not be empty",
		);
	});

	it("rejects a secret past the length cap", async () => {
		await expect(
			deriveKek(
				"x".repeat(MAX_SECRET_LENGTH + 1),
				generateSalt(),
				"passphrase",
			),
		).rejects.toThrow("kdf: E2E secret must be at most 1024 characters");
	});

	it("rejects a salt of the wrong length", async () => {
		await expect(
			deriveKek("s", new Uint8Array(8), "passphrase"),
		).rejects.toThrow("kdf: E2E salt must be 16 bytes");
	});

	// The type stops guarding the separator the moment a caller casts, and a
	// purpose containing ":" makes two distinct contexts serialize identically.
	it("rejects a purpose outside the known set", async () => {
		await expect(
			deriveKek("s", generateSalt(), "recovery:" as KekPurpose),
		).rejects.toThrow('kdf: unknown purpose "recovery:"');
	});

	// Passing `salt.buffer` instead of `salt` hashes the whole backing store and
	// still succeeds, so a salt that is a view over a larger buffer must derive
	// the same KEK as a standalone copy of those same bytes.
	it("honours byteOffset when the salt is a view over a larger buffer", async () => {
		const big = crypto.getRandomValues(new Uint8Array(64));
		const view = big.subarray(32, 48);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await deriveKek("s", view, "passphrase")).toEqual(
			await deriveKek("s", copy, "passphrase"),
		);
	});

	// Node pools small Buffers into a shared ArrayBuffer, so an unsliced Buffer
	// is the same hazard arriving from a different allocator.
	it("honours byteOffset when the salt is a pooled Node Buffer", async () => {
		const pooled = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		const copy = Uint8Array.from(pooled);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await deriveKek("s", pooled, "passphrase")).toEqual(
			await deriveKek("s", copy, "passphrase"),
		);
	});
});

describe("generateSalt", () => {
	it("returns 16 distinct bytes per call", () => {
		const a = generateSalt();
		expect(a.length).toBe(16);
		expect(a).not.toEqual(generateSalt());
	});
});
