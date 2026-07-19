// Mint-side properties of the ack capability. The consume side is
// database-backed and lives in tests/integration/ack.test.ts.
import { describe, expect, it } from "vitest";
import {
	ACK_TOKEN_BYTES,
	ackBaseUrl,
	ackToken,
	hashAckToken,
} from "./capability.ts";

describe("ack token", () => {
	it("carries at least 32 bytes of entropy", () => {
		const token = ackToken();
		expect(ACK_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
		// base64url of N bytes is ceil(N*4/3) chars unpadded.
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(Buffer.from(token, "base64url").byteLength).toBe(ACK_TOKEN_BYTES);
	});

	it("is unique per call", () => {
		const seen = new Set(Array.from({ length: 200 }, () => ackToken()));
		expect(seen.size).toBe(200);
	});

	// The raw token is returned once to the caller and never persisted; only the
	// hash is stored, so a database read cannot reconstruct a working ack link.
	it("hashes to something that is not the token", () => {
		const token = ackToken();
		const hash = hashAckToken(token);
		expect(hash).not.toBe(token);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hashAckToken(token)).toBe(hash);
		expect(hashAckToken(ackToken())).not.toBe(hash);
	});
});

describe("ackBaseUrl", () => {
	it("prefers the explicit public URL", () => {
		expect(
			ackBaseUrl({
				DITERO_PUBLIC_URL: "https://todo.example",
				BETTER_AUTH_URL: "https://auth.example",
			}),
		).toBe("https://todo.example");
	});

	it("falls back to BETTER_AUTH_URL", () => {
		expect(ackBaseUrl({ BETTER_AUTH_URL: "https://auth.example" })).toBe(
			"https://auth.example",
		);
	});

	// Null disables the ack action rather than minting a link nobody can follow.
	it("is null when neither is configured", () => {
		expect(ackBaseUrl({})).toBeNull();
		expect(ackBaseUrl({ DITERO_PUBLIC_URL: "  " })).toBeNull();
	});
});
