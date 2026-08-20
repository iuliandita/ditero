import { describe, expect, it } from "vitest";
import { ARGON2_PARAMS, deriveKek, generateSalt } from "./kdf.ts";

describe("ARGON2_PARAMS", () => {
	// Pinned by a test because a downtuned KDF is invisible in review and fatal
	// in the threat model: the wrapped private key sits on a server we model as
	// possibly hostile.
	it("keeps memory-hard parameters", () => {
		expect(ARGON2_PARAMS).toEqual({
			memorySizeKiB: 65536,
			iterations: 3,
			parallelism: 1,
			hashLength: 32,
		});
	});
});

// Each derivation is memory-hard by design (~0.6s), and the first also pays
// WASM instantiation, which blew vitest's 5s default on a cold loaded run.
describe("deriveKek", { timeout: 30_000 }, () => {
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

	it("rejects an empty secret", async () => {
		await expect(deriveKek("", generateSalt(), "passphrase")).rejects.toThrow(
			"E2E secret must not be empty",
		);
	});

	it("rejects a salt of the wrong length", async () => {
		await expect(
			deriveKek("s", new Uint8Array(8), "passphrase"),
		).rejects.toThrow("E2E salt must be 16 bytes");
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
		expect(await deriveKek("s", pooled, "passphrase")).toEqual(
			await deriveKek("s", copy, "passphrase"),
		);
	});
});

describe("generateSalt", () => {
	it("returns 16 unpredictable bytes", () => {
		const a = generateSalt();
		expect(a.length).toBe(16);
		expect(a).not.toEqual(generateSalt());
	});
});
