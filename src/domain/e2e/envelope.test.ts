import { describe, expect, it } from "vitest";
import {
	aad,
	decryptWrapped,
	ENVELOPE_OPENERS,
	ENVELOPE_VERSION,
	EnvelopeOpenError,
	encryptWrapped,
	KEY_BYTES,
	type MetadataField,
	NONCE_BYTES,
	TAG_BYTES,
	type Wrapped,
} from "./envelope.ts";

const key = () => crypto.getRandomValues(new Uint8Array(KEY_BYTES));
const bytes = () => crypto.getRandomValues(new Uint8Array(48));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("aad", () => {
	it("builds the private-key passphrase binding", () => {
		expect(text(aad.privateKeyPassphrase("u_1"))).toBe("ditero:sk-pass:v1|u_1");
	});

	it("builds the private-key recovery binding", () => {
		expect(text(aad.privateKeyRecovery("u_1"))).toBe(
			"ditero:sk-recovery:v1|u_1",
		);
	});

	it("builds the device binding", () => {
		expect(text(aad.privateKeyDevice("u_1", "d_1"))).toBe(
			"ditero:sk-device:v1|u_1|d_1",
		);
	});

	it("builds the DEK binding from workspace, version and attachment", () => {
		expect(text(aad.dek("ws_1", 3, "att_1"))).toBe(
			"ditero:dek:v1|ws_1|3|att_1",
		);
	});

	it("builds a per-field metadata binding", () => {
		expect(text(aad.metadata("att_1", "filename"))).toBe(
			"ditero:meta:v1|att_1|filename",
		);
		expect(text(aad.metadata("att_1", "contentType"))).toBe(
			"ditero:meta:v1|att_1|contentType",
		);
	});

	// The prefixes are what keep the six contexts apart once the identifiers
	// coincide, which they do whenever one id is reused across roles.
	it("keeps every context distinct for identical identifiers", () => {
		const all = [
			aad.privateKeyPassphrase("x"),
			aad.privateKeyRecovery("x"),
			aad.privateKeyDevice("x", "x"),
			aad.dek("x", 1, "x"),
			aad.metadata("x", "filename"),
			aad.metadata("x", "contentType"),
		].map(text);
		expect(new Set(all).size).toBe(all.length);
	});

	// The separator is the whole binding: an identifier carrying one lets two
	// distinct contexts serialize identically, so aad.dek("a|1", 2, "b") and
	// aad.dek("a", 1, "2|b") would authenticate each other's ciphertexts.
	it("rejects a separator in a passphrase-wrap identifier", () => {
		expect(() => aad.privateKeyPassphrase("u|1")).toThrow(
			'aad: userId must not contain "|"',
		);
	});

	it("rejects a separator in a recovery-wrap identifier", () => {
		expect(() => aad.privateKeyRecovery("u|1")).toThrow(
			'aad: userId must not contain "|"',
		);
	});

	it("rejects a separator in a device-wrap identifier", () => {
		expect(() => aad.privateKeyDevice("u|1", "d_1")).toThrow(
			'aad: userId must not contain "|"',
		);
		expect(() => aad.privateKeyDevice("u_1", "d|1")).toThrow(
			'aad: deviceId must not contain "|"',
		);
	});

	it("rejects a separator in a DEK-wrap identifier", () => {
		expect(() => aad.dek("ws|1", 1, "att_1")).toThrow(
			'aad: workspaceId must not contain "|"',
		);
		expect(() => aad.dek("ws_1", 1, "att|1")).toThrow(
			'aad: attachmentId must not contain "|"',
		);
	});

	it("rejects a separator in a metadata-wrap identifier", () => {
		expect(() => aad.metadata("att|1", "filename")).toThrow(
			'aad: attachmentId must not contain "|"',
		);
	});

	// A fractional or negative version serializes without collapsing, but it is a
	// caller bug that would silently mint an AAD no rotation can ever reproduce.
	it("rejects a key version that is not a positive integer", () => {
		expect(() => aad.dek("ws_1", 1.5, "att_1")).toThrow(
			"aad: keyVersion must be a positive integer",
		);
		expect(() => aad.dek("ws_1", 0, "att_1")).toThrow(
			"aad: keyVersion must be a positive integer",
		);
		expect(() => aad.dek("ws_1", Number.NaN, "att_1")).toThrow(
			"aad: keyVersion must be a positive integer",
		);
	});

	// Injectivity survives an empty id, so this is not a binding break -- it is a
	// caller bug (an unresolved userId, a deviceId not yet minted) that would
	// otherwise mint a storable wrap bound to nothing and fail much later,
	// against the real id, looking like a wrong key.
	it("rejects an empty identifier", () => {
		expect(() => aad.privateKeyPassphrase("")).toThrow(
			"aad: userId must not be empty",
		);
		expect(() => aad.privateKeyRecovery("")).toThrow(
			"aad: userId must not be empty",
		);
		expect(() => aad.privateKeyDevice("u_1", "")).toThrow(
			"aad: deviceId must not be empty",
		);
		expect(() => aad.dek("", 1, "att_1")).toThrow(
			"aad: workspaceId must not be empty",
		);
		expect(() => aad.metadata("", "filename")).toThrow(
			"aad: attachmentId must not be empty",
		);
	});

	// The union stops guarding the field name the moment a caller casts, and the
	// field is the only thing separating two ciphertexts on the same row.
	it("rejects a metadata field outside the known set", () => {
		expect(() => aad.metadata("att_1", "notes" as MetadataField)).toThrow(
			'envelope: unknown metadata field "notes"',
		);
	});
});

describe("encryptWrapped / decryptWrapped", () => {
	it("round-trips under matching AAD", async () => {
		const k = key();
		const pt = bytes();
		const a = aad.dek("ws_1", 1, "att_1");
		expect(await decryptWrapped(await encryptWrapped(pt, k, a), k, a)).toEqual(
			pt,
		);
	});

	it("refuses a different key", async () => {
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), key(), a);
		await expect(decryptWrapped(wrapped, key(), a)).rejects.toThrow(
			"envelope: cannot open envelope",
		);
	});

	// This is the transplant defence: without per-attachment AAD a server that
	// can write metadata rows could move one attachment's encrypted filename
	// onto another row and learn which files share a name.
	it("refuses a ciphertext transplanted to another attachment", async () => {
		const k = key();
		const wrapped = await encryptWrapped(
			bytes(),
			k,
			aad.metadata("att_1", "filename"),
		);
		const opening = decryptWrapped(
			wrapped,
			k,
			aad.metadata("att_2", "filename"),
		);
		// Class as well as reason here: toMatchObject alone is satisfied by any
		// object carrying the field, including a plain Error the caller cannot
		// discriminate on.
		await expect(opening).rejects.toBeInstanceOf(EnvelopeOpenError);
		await expect(opening).rejects.toMatchObject({ reason: "cannot-open" });
	});

	it("refuses a ciphertext transplanted to another field of the same attachment", async () => {
		const k = key();
		const wrapped = await encryptWrapped(
			bytes(),
			k,
			aad.metadata("att_1", "filename"),
		);
		await expect(
			decryptWrapped(wrapped, k, aad.metadata("att_1", "contentType")),
		).rejects.toMatchObject({ reason: "cannot-open" });
	});

	it("refuses a DEK wrap replayed under another key version", async () => {
		const k = key();
		const wrapped = await encryptWrapped(
			bytes(),
			k,
			aad.dek("ws_1", 1, "att_1"),
		);
		await expect(
			decryptWrapped(wrapped, k, aad.dek("ws_1", 2, "att_1")),
		).rejects.toMatchObject({ reason: "cannot-open" });
	});

	it("refuses a DEK wrap replayed onto another workspace", async () => {
		const k = key();
		const wrapped = await encryptWrapped(
			bytes(),
			k,
			aad.dek("ws_1", 1, "att_1"),
		);
		await expect(
			decryptWrapped(wrapped, k, aad.dek("ws_2", 1, "att_1")),
		).rejects.toMatchObject({ reason: "cannot-open" });
	});

	it("uses a fresh nonce per call", async () => {
		const k = key();
		const pt = bytes();
		const a = aad.dek("ws_1", 1, "att_1");
		const one = await encryptWrapped(pt, k, a);
		const two = await encryptWrapped(pt, k, a);
		expect(one.nonce).not.toEqual(two.nonce);
		expect(one.ciphertext).not.toEqual(two.ciphertext);
	});

	// Pins the wire shape rather than the constants: a 16-byte nonce is legal
	// AES-GCM but routes through GHASH derivation, and a short tag is a real
	// forgery weakening. Both are one-way doors once a wrap is stored.
	it("writes the current version, a 12-byte nonce and a full 16-byte tag", async () => {
		const pt = bytes();
		const wrapped = await encryptWrapped(
			pt,
			key(),
			aad.dek("ws_1", 1, "att_1"),
		);
		expect(wrapped.version).toBe(ENVELOPE_VERSION);
		expect(wrapped.nonce.length).toBe(NONCE_BYTES);
		expect(NONCE_BYTES).toBe(12);
		expect(wrapped.ciphertext.length).toBe(pt.length + TAG_BYTES);
		expect(TAG_BYTES).toBe(16);
	});

	it("refuses an unknown envelope version", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		await expect(
			decryptWrapped({ ...wrapped, version: 2 }, k, a),
		).rejects.toThrow("envelope: unsupported envelope version 2");
		await expect(
			decryptWrapped({ ...wrapped, version: 2 }, k, a),
		).rejects.toMatchObject({ reason: "unsupported-version" });
	});

	// Phase order is the point: the version is a property of the stored record,
	// so it must be reported ahead of every other check. Reversed, an old-format
	// row surfaces as a key problem and the UI tells the user their passphrase is
	// bad instead of prompting a migration. A wrong-LENGTH key is the probe
	// because it is the one other failure that fires before the decrypt call --
	// a merely wrong key of the right length cannot tell the two orders apart.
	it("reports an unknown version ahead of every key check", async () => {
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), key(), a);
		await expect(
			decryptWrapped({ ...wrapped, version: 2 }, new Uint8Array(16), a),
		).rejects.toMatchObject({ reason: "unsupported-version" });
	});

	// Same order, other direction: a malformed record must not be reported as a
	// key failure either, or a corrupt row reads as a bad passphrase.
	it("reports a malformed nonce ahead of every key check", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		await expect(
			decryptWrapped(
				{ ...wrapped, nonce: crypto.getRandomValues(new Uint8Array(16)) },
				new Uint8Array(16),
				a,
			),
		).rejects.toMatchObject({ reason: "malformed" });
	});

	it("reports a wrong key as cannot-open, not malformed", async () => {
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), key(), a);
		await expect(decryptWrapped(wrapped, key(), a)).rejects.toMatchObject({
			reason: "cannot-open",
		});
	});

	// A nonce of the wrong length is a broken record, not a wrong key: AES-GCM
	// accepts any nonce length, so without this check the row would open the
	// GHASH path and fail as an ordinary auth failure.
	it("reports a nonce of the wrong length as malformed", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		const broken: Wrapped = {
			...wrapped,
			nonce: crypto.getRandomValues(new Uint8Array(16)),
		};
		await expect(decryptWrapped(broken, k, a)).rejects.toMatchObject({
			reason: "malformed",
		});
	});

	// importKey accepts 16 and 24 bytes too, so a short key silently downgrades
	// this module from AES-256 to AES-128 and every test still passes.
	it("rejects a key that is not 32 bytes on encrypt", async () => {
		await expect(
			encryptWrapped(bytes(), new Uint8Array(16), aad.dek("ws_1", 1, "att_1")),
		).rejects.toThrow("envelope: key must be 32 bytes");
	});

	it("rejects a key that is not 32 bytes on decrypt", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		await expect(decryptWrapped(wrapped, k.subarray(0, 16), a)).rejects.toThrow(
			"envelope: key must be 32 bytes",
		);
	});

	// Passing `plaintext.buffer` seals the whole backing store and still
	// succeeds, so a view over a larger buffer must wrap only its own bytes.
	it("honours byteOffset when the plaintext is a view over a larger buffer", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const big = crypto.getRandomValues(new Uint8Array(64));
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		const wrapped = await encryptWrapped(view, k, a);
		expect(wrapped.ciphertext.length).toBe(view.length + TAG_BYTES);
		expect(await decryptWrapped(wrapped, k, a)).toEqual(copy);
	});

	// Node pools small Buffers into a shared ArrayBuffer: the same hazard from a
	// different allocator, and the one that actually bit us.
	it("honours byteOffset when the plaintext is a pooled Node Buffer", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const pooled = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		const copy = Uint8Array.from(pooled);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		const wrapped = await encryptWrapped(pooled, k, a);
		expect(wrapped.ciphertext.length).toBe(pooled.length + TAG_BYTES);
		expect(await decryptWrapped(wrapped, k, a)).toEqual(copy);
	});

	it("honours byteOffset when the key is a view over a larger buffer", async () => {
		const a = aad.dek("ws_1", 1, "att_1");
		const pt = bytes();
		const big = crypto.getRandomValues(new Uint8Array(64));
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(
			await decryptWrapped(await encryptWrapped(pt, view, a), copy, a),
		).toEqual(pt);
	});

	it("honours byteOffset when the key is a pooled Node Buffer", async () => {
		const a = aad.dek("ws_1", 1, "att_1");
		const pt = bytes();
		const pooled = Buffer.from(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
		);
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		const copy = Uint8Array.from(pooled);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(
			await decryptWrapped(await encryptWrapped(pt, pooled, a), copy, a),
		).toEqual(pt);
	});

	// The AAD is caller-supplied too, and a `.buffer` there authenticates
	// unrelated heap bytes that the decrypting peer can never reconstruct.
	it("honours byteOffset when the AAD is a view over a larger buffer", async () => {
		const k = key();
		const big = crypto.getRandomValues(new Uint8Array(64));
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		const pt = bytes();
		expect(
			await decryptWrapped(await encryptWrapped(pt, k, view), k, copy),
		).toEqual(pt);
	});

	// No valid AES-GCM output is shorter than its tag, so a short ciphertext is a
	// truncated column, not a key problem. Without this a bad backup restore
	// tells the user their passphrase is wrong; they then burn the recovery code
	// and fail identically.
	it("reports a ciphertext shorter than the tag as malformed", async () => {
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		for (const length of [0, TAG_BYTES - 1]) {
			await expect(
				decryptWrapped(
					{ ...wrapped, ciphertext: new Uint8Array(length) },
					k,
					a,
				),
			).rejects.toMatchObject({ reason: "malformed" });
		}
		// The boundary itself is a possible record (an empty plaintext), so it
		// must NOT be classified as malformed.
		await expect(
			decryptWrapped(
				{ ...wrapped, ciphertext: new Uint8Array(TAG_BYTES) },
				k,
				a,
			),
		).rejects.toMatchObject({ reason: "cannot-open" });
	});

	it("round-trips an empty plaintext", async () => {
		const k = key();
		const a = aad.metadata("att_1", "filename");
		const wrapped = await encryptWrapped(new Uint8Array(0), k, a);
		expect(wrapped.ciphertext.length).toBe(TAG_BYTES);
		expect(await decryptWrapped(wrapped, k, a)).toEqual(new Uint8Array(0));
	});

	// The module's premise is that nothing is wrapped without stating its
	// context. Every aad.* helper returns non-empty, but nothing forces a caller
	// through them, and an empty AAD wraps successfully and silently unbound.
	it("rejects an empty AAD on encrypt", async () => {
		await expect(
			encryptWrapped(bytes(), key(), new Uint8Array(0)),
		).rejects.toThrow("envelope: additionalData must not be empty");
	});

	it("rejects an empty AAD on decrypt", async () => {
		const k = key();
		const wrapped = await encryptWrapped(bytes(), k, aad.dek("ws_1", 1, "a_1"));
		await expect(decryptWrapped(wrapped, k, new Uint8Array(0))).rejects.toThrow(
			"envelope: additionalData must not be empty",
		);
	});

	// WebCrypto rejects shared-memory views, and the narrowing must fail loud
	// rather than cast past it.
	it("rejects a shared-memory backed plaintext", async () => {
		const shared = new Uint8Array(new SharedArrayBuffer(32));
		await expect(
			encryptWrapped(shared, key(), aad.dek("ws_1", 1, "att_1")),
		).rejects.toThrow("envelope: byte views must not be shared-memory backed");
	});

	it("rejects a shared-memory backed key", async () => {
		const shared = new Uint8Array(new SharedArrayBuffer(KEY_BYTES));
		await expect(
			encryptWrapped(bytes(), shared, aad.dek("ws_1", 1, "att_1")),
		).rejects.toThrow("envelope: byte views must not be shared-memory backed");
	});
});

describe("ENVELOPE_OPENERS", () => {
	// Bumping ENVELOPE_VERSION without leaving the old opener in place makes
	// every stored wrap at that version unrecoverable by any route, and nothing
	// else in the suite would go red.
	it("keeps an opener for v1 forever", () => {
		expect(ENVELOPE_OPENERS[1]).toBeTypeOf("function");
	});

	it("can open what encryptWrapped currently writes", () => {
		expect(ENVELOPE_OPENERS[ENVELOPE_VERSION]).toBeTypeOf("function");
	});

	// Behaviour, not shape: proves decryptWrapped is a registry lookup rather
	// than a comparison against the constant, which is what makes leaving an old
	// opener in place actually keep old wraps readable.
	it("dispatches decryptWrapped through the registry", async () => {
		const opened = new Uint8Array([1, 2, 3]);
		const k = key();
		const a = aad.dek("ws_1", 1, "att_1");
		const wrapped = await encryptWrapped(bytes(), k, a);
		ENVELOPE_OPENERS[99] = async () => opened;
		try {
			expect(await decryptWrapped({ ...wrapped, version: 99 }, k, a)).toBe(
				opened,
			);
		} finally {
			delete ENVELOPE_OPENERS[99];
		}
		await expect(
			decryptWrapped({ ...wrapped, version: 99 }, k, a),
		).rejects.toMatchObject({ reason: "unsupported-version" });
	});
});
