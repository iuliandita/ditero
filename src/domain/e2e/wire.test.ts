import { describe, expect, it } from "vitest";
import {
	aad,
	decryptWrapped,
	EnvelopeOpenError,
	encryptWrapped,
	NONCE_BYTES,
	TAG_BYTES,
	type Wrapped,
} from "./envelope.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
	MAX_WRAPPED_LENGTH,
} from "./wire.ts";

const KEY = new Uint8Array(32).fill(9);
const AAD = aad.privateKeyPassphrase("u_1");

function failure(fn: () => unknown): EnvelopeOpenError {
	const caught = (() => {
		try {
			fn();
			return null;
		} catch (e) {
			return e;
		}
	})();
	expect(caught).toBeInstanceOf(EnvelopeOpenError);
	return caught as EnvelopeOpenError;
}

const wrapped = (over: Partial<Wrapped> = {}): Wrapped => ({
	version: 1,
	nonce: new Uint8Array(NONCE_BYTES).fill(1),
	ciphertext: new Uint8Array(TAG_BYTES + 8).fill(2),
	...over,
});

describe("encodeWrapped / decodeWrapped", () => {
	it("round-trips a real wrap through the string form", async () => {
		const plaintext = crypto.getRandomValues(new Uint8Array(32));
		const original = await encryptWrapped(plaintext, KEY, AAD);
		// The end-to-end property, not just field equality: a swapped nonce and
		// ciphertext would still compare equal field-by-field if the decoder
		// swapped them back, and would still fail to decrypt.
		const opened = await decryptWrapped(
			decodeWrapped(encodeWrapped(original)),
			KEY,
			AAD,
		);
		expect(opened).toEqual(plaintext);
	});

	it("preserves every field exactly", () => {
		const original = wrapped();
		expect(decodeWrapped(encodeWrapped(original))).toEqual(original);
	});

	it("emits url-safe base64 with no padding", () => {
		const encoded = encodeWrapped(
			wrapped({ ciphertext: new Uint8Array(TAG_BYTES + 1).fill(0xfb) }),
		);
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("refuses to encode an unregistered version", () => {
		expect(failure(() => encodeWrapped(wrapped({ version: 2 }))).reason).toBe(
			"unsupported-version",
		);
	});

	it("refuses to encode a nonce of the wrong length", () => {
		expect(
			failure(() =>
				encodeWrapped(wrapped({ nonce: new Uint8Array(NONCE_BYTES - 1) })),
			).reason,
		).toBe("malformed");
	});

	it("reports an unknown version before it reports a length", () => {
		// Order matters and is the same ordering decryptWrapped uses: reversed,
		// every record from a newer client reads as corruption, and the user is
		// told to retype a passphrase that was never wrong.
		//
		// The probe record is BOTH unregistered AND too short, which is what
		// makes this an ordering test. A full-length record with a bogus version
		// byte passes whichever check runs first, so a truncation check hoisted
		// above the dispatch left it green -- verified by mutation.
		const bogus = new Uint8Array([7, 1, 2, 3, 4]);
		expect(failure(() => decodeWrapped(encodeBytes(bogus))).reason).toBe(
			"unsupported-version",
		);
		// Presence assertion: the same record at a registered version really does
		// trip the length check, so the assertion above is a choice between two
		// live outcomes rather than the only one available.
		const short = new Uint8Array([1, 1, 2, 3, 4]);
		expect(failure(() => decodeWrapped(encodeBytes(short))).reason).toBe(
			"malformed",
		);
	});

	it("rejects a record truncated below the GCM tag", () => {
		const raw = decodeBytes(encodeWrapped(wrapped()));
		const short = raw.slice(0, 1 + NONCE_BYTES + TAG_BYTES - 1);
		expect(failure(() => decodeWrapped(encodeBytes(short))).reason).toBe(
			"malformed",
		);
	});

	it("rejects an empty record", () => {
		expect(failure(() => decodeWrapped("")).reason).toBe("malformed");
	});

	it("rejects non-base64url input", () => {
		for (const bad of ["not base64!!", "abc+def", "abc/def"]) {
			expect(failure(() => decodeWrapped(bad)).reason, bad).toBe("malformed");
		}
	});

	it("rejects a record over the input cap without scanning it", () => {
		// Presence assertion first, so the cap is shown to be what rejects this
		// rather than the alphabet check it sits in front of.
		const legal = "A".repeat(MAX_WRAPPED_LENGTH);
		expect(failure(() => decodeWrapped(legal)).message).not.toContain(
			"too long",
		);
		expect(failure(() => decodeWrapped(`${legal}A`)).message).toContain(
			"too long",
		);
	});
});

describe("encodeBytes / decodeBytes", () => {
	it("round-trips every byte value and every padding remainder", () => {
		for (const length of [0, 1, 2, 3, 32, 255]) {
			const bytes = new Uint8Array(length).map((_, i) => (i * 7 + 3) & 0xff);
			expect(decodeBytes(encodeBytes(bytes)), `length ${length}`).toEqual(
				bytes,
			);
		}
	});

	// Spread-argument limits are engine-specific -- historically ~65535 on
	// Safari, far higher on V8 -- so no portable size proves the chunking is
	// load-bearing, and mutation-removing it leaves this green here. It stays a
	// round-trip over a multi-chunk payload: it pins that chunking does not
	// CORRUPT anything, which is the half a test can honestly assert.
	it("round-trips a payload spanning several chunks", () => {
		// Not getRandomValues: it caps at 65536 bytes per call, which is under
		// the size this needs.
		const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => (i * 31) & 0xff);
		expect(decodeBytes(encodeBytes(big))).toEqual(big);
	});
});
