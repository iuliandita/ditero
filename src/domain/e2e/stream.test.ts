import { describe, expect, it } from "vitest";
import {
	DEK_BYTES,
	decryptStream,
	deriveStreamKey,
	encryptStream,
	HEADER_BYTES,
	MAGIC,
	MAX_SEGMENT_BYTES,
	MIN_SEGMENT_BYTES,
	SALT_BYTES,
	STREAM_FORMATS,
	STREAM_VERSION,
	StreamError,
	type StreamPurpose,
	streamNonceForTests,
	TAG_BYTES,
} from "./stream.ts";

// Small segments keep the multi-segment cases cheap; every assertion below
// derives its offsets from SEG rather than pinning a constant, so changing the
// segment size cannot leave a test passing against the wrong framing.
const SEG = MIN_SEGMENT_BYTES;

const DEK = () => crypto.getRandomValues(new Uint8Array(DEK_BYTES));
const SALT = () => crypto.getRandomValues(new Uint8Array(SALT_BYTES));

// getRandomValues throws above 65536 bytes per call, so the multi-megabyte
// fixtures have to be filled in windows.
function randomBytes(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let at = 0; at < n; at += 65536) {
		crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
	}
	return out;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const c of stream) chunks.push(c);
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

async function* source(data: Uint8Array, chunk = 7): AsyncIterable<Uint8Array> {
	for (let at = 0; at < data.length; at += chunk) {
		yield Uint8Array.from(data.subarray(at, at + chunk));
	}
}

// Every chunk is a view into one larger buffer, which is what a real reader
// hands us. Passing `.buffer` anywhere downstream seals the whole store.
async function* viewSource(
	data: Uint8Array,
	chunk: number,
): AsyncIterable<Uint8Array> {
	const backing = new Uint8Array(data.length + 64);
	backing.set(data, 32);
	for (let at = 0; at < data.length; at += chunk) {
		const view = backing.subarray(
			32 + at,
			32 + Math.min(at + chunk, data.length),
		);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		yield view;
	}
}

async function* pooledSource(
	data: Uint8Array,
	chunk: number,
): AsyncIterable<Uint8Array> {
	for (let at = 0; at < data.length; at += chunk) {
		const slice = data.subarray(at, at + chunk);
		const pooled = Buffer.allocUnsafe(slice.length);
		pooled.set(slice);
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		yield pooled;
	}
}

// A producer reading into ONE reused buffer: a ReadableStreamBYOBReader, or a
// manual pooled read. Retaining these chunks by reference seals whatever the
// producer overwrote them with, and the GCM tag is then valid over the
// corruption -- no integrity check further down can ever catch it. Chunk sizes
// that divide the segment evenly do not trigger it, so the size here matters.
async function* recyclingSource(
	data: Uint8Array,
	chunk: number,
): AsyncIterable<Uint8Array> {
	const scratch = new Uint8Array(chunk);
	for (let at = 0; at < data.length; at += chunk) {
		const slice = data.subarray(at, at + chunk);
		scratch.fill(0xa5);
		scratch.set(slice);
		yield scratch.subarray(0, slice.length);
	}
}

const seal = (pt: Uint8Array, dek: Uint8Array, segmentSize = SEG) =>
	collect(encryptStream(source(pt, 97), dek, "content", segmentSize));

const open = (
	ct: Uint8Array,
	dek: Uint8Array,
	purpose: StreamPurpose = "content",
) => collect(decryptStream(source(ct, 97), dek, purpose));

async function failure(p: Promise<unknown>): Promise<StreamError> {
	try {
		await p;
	} catch (error) {
		if (error instanceof StreamError) return error;
		throw error;
	}
	throw new Error("expected a StreamError, got success");
}

const dv = (v: Uint8Array) =>
	new DataView(v.buffer, v.byteOffset, v.byteLength);

const SALT_AT = MAGIC.length + 1 + 4;

// The repo's lib.dom rejects Uint8Array<ArrayBufferLike> where BufferSource is
// wanted; these fixtures are deliberately views, so narrow rather than copy.
const src = (v: Uint8Array) => v as Uint8Array<ArrayBuffer>;

describe("deriveStreamKey", () => {
	it("derives a 256-bit key", async () => {
		expect((await deriveStreamKey(DEK(), SALT(), "content")).length).toBe(32);
	});

	it("separates content and thumbnail subkeys from one DEK", async () => {
		const dek = DEK();
		const salt = SALT();
		expect(await deriveStreamKey(dek, salt, "content")).not.toEqual(
			await deriveStreamKey(dek, salt, "thumbnail"),
		);
	});

	it("is deterministic", async () => {
		const dek = DEK();
		const salt = SALT();
		expect(await deriveStreamKey(dek, salt, "content")).toEqual(
			src(await deriveStreamKey(dek, salt, "content")),
		);
	});

	it("separates files by salt", async () => {
		const dek = DEK();
		expect(await deriveStreamKey(dek, SALT(), "content")).not.toEqual(
			await deriveStreamKey(dek, SALT(), "content"),
		);
	});

	// HKDF accepts any IKM length, so a short or empty DEK derives a perfectly
	// usable key and every round-trip stays green.
	it("rejects a DEK that is not 32 bytes", async () => {
		await expect(
			deriveStreamKey(new Uint8Array(16), SALT(), "content"),
		).rejects.toThrow("stream: DEK must be 32 bytes");
	});

	it("rejects a salt that is not 16 bytes", async () => {
		await expect(
			deriveStreamKey(DEK(), new Uint8Array(8), "content"),
		).rejects.toThrow("stream: salt must be 16 bytes");
	});

	// The union stops guarding this the moment a caller casts, and the purpose is
	// the only thing keeping the two ciphertexts on one attachment apart.
	it("rejects an unknown purpose", async () => {
		await expect(
			deriveStreamKey(DEK(), SALT(), "other" as StreamPurpose),
		).rejects.toThrow('stream: unknown purpose "other"');
	});

	it("honours byteOffset when the DEK is a view over a larger buffer", async () => {
		const salt = SALT();
		const big = randomBytes(64);
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await deriveStreamKey(view, salt, "content")).toEqual(
			await deriveStreamKey(copy, salt, "content"),
		);
	});

	it("honours byteOffset when the DEK is a pooled Node Buffer", async () => {
		const salt = SALT();
		const pooled = Buffer.allocUnsafe(DEK_BYTES);
		pooled.set(randomBytes(DEK_BYTES));
		expect(pooled.byteLength).toBeLessThan(pooled.buffer.byteLength);
		const copy = Uint8Array.from(pooled);
		expect(copy.byteLength).toBe(copy.buffer.byteLength);
		expect(await deriveStreamKey(pooled, salt, "content")).toEqual(
			await deriveStreamKey(copy, salt, "content"),
		);
	});

	it("honours byteOffset when the salt is a view over a larger buffer", async () => {
		const dek = DEK();
		const big = randomBytes(64);
		const view = big.subarray(32, 48);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		expect(await deriveStreamKey(dek, view, "content")).toEqual(
			await deriveStreamKey(dek, copy, "content"),
		);
	});

	it("rejects a shared-memory backed DEK", async () => {
		const shared = new Uint8Array(new SharedArrayBuffer(DEK_BYTES));
		await expect(deriveStreamKey(shared, SALT(), "content")).rejects.toThrow(
			"stream: byte views must not be shared-memory backed",
		);
	});
});

// The header and the nonce are stored bytes: once a user uploads a file, every
// offset below is unchangeable.
describe("wire format", () => {
	it("lays out magic, version and segment size", async () => {
		const ct = await seal(new Uint8Array(10), DEK(), 4096);
		expect(ct.subarray(0, MAGIC.length)).toEqual(MAGIC);
		expect(ct[MAGIC.length]).toBe(STREAM_VERSION);
		expect(dv(ct).getUint32(MAGIC.length + 1, false)).toBe(4096);
		expect(HEADER_BYTES).toBe(MAGIC.length + 1 + 4 + 16 + 7);
	});

	it("builds a 12-byte nonce as prefix, big-endian counter, final flag", () => {
		const prefix = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
		const nonce = streamNonceForTests(prefix, 0x01020304, false);
		expect(nonce).toEqual(
			Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 0]),
		);
		expect(nonce.length).toBe(12);
	});

	it("sets the final flag in the last nonce byte only", () => {
		const prefix = new Uint8Array(7);
		const plain = streamNonceForTests(prefix, 3, false);
		const final = streamNonceForTests(prefix, 3, true);
		expect(final[11]).toBe(1);
		expect(final.subarray(0, 11)).toEqual(plain.subarray(0, 11));
	});

	it("accepts the largest counter a uint32 can hold", () => {
		const nonce = streamNonceForTests(new Uint8Array(7), 0xffffffff, true);
		expect(nonce.subarray(7, 11)).toEqual(
			Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
		);
	});

	// setUint32 wraps silently past 2^32, which would reuse a nonce under the
	// same key -- the one failure AES-GCM cannot survive.
	it("refuses a counter past uint32", () => {
		const error = (() => {
			try {
				streamNonceForTests(new Uint8Array(7), 0x100000000, false);
			} catch (e) {
				return e;
			}
		})();
		expect(error).toBeInstanceOf(StreamError);
		expect((error as StreamError).reason).toBe("counter-overflow");
	});

	// Deleting a format entry makes every stored blob at that version
	// unrecoverable by any route, and nothing else in the suite goes red.
	it("keeps a v1 format reader forever", () => {
		expect(STREAM_FORMATS[1]).toBeDefined();
		expect(STREAM_FORMATS[STREAM_VERSION]).toBeDefined();
	});
});

describe("encryptStream", () => {
	it("rejects a segment size below the minimum", async () => {
		await expect(
			collect(encryptStream(source(new Uint8Array(1)), DEK(), "content", 16)),
		).rejects.toThrow("stream: segmentSize must be between");
	});

	it("rejects a segment size above the maximum", async () => {
		await expect(
			collect(
				encryptStream(
					source(new Uint8Array(1)),
					DEK(),
					"content",
					MAX_SEGMENT_BYTES + 1,
				),
			),
		).rejects.toThrow("stream: segmentSize must be between");
	});

	it("rejects a non-integer segment size", async () => {
		await expect(
			collect(
				encryptStream(source(new Uint8Array(1)), DEK(), "content", 4096.5),
			),
		).rejects.toThrow("stream: segmentSize must be between");
	});

	it("rejects an unknown purpose", async () => {
		await expect(
			collect(
				encryptStream(
					source(new Uint8Array(1)),
					DEK(),
					"other" as StreamPurpose,
				),
			),
		).rejects.toThrow('stream: unknown purpose "other"');
	});

	// The framing invariant the decoder leans on: the final segment always
	// carries strictly fewer than segmentSize plaintext bytes, so a full sealed
	// segment is never the last one and an exact multiple ends with an empty
	// final segment. Without it a boundary truncation is indistinguishable from
	// a complete shorter file except by tag failure.
	it.each([
		0,
		1,
		SEG - 1,
		SEG,
		SEG + 1,
		SEG * 2,
		SEG * 2 + 1,
	])("emits floor(n/segment)+1 segments for %i plaintext bytes", async (n) => {
		const ct = await seal(randomBytes(n), DEK());
		const segments = Math.floor(n / SEG) + 1;
		expect(ct.length).toBe(HEADER_BYTES + n + segments * TAG_BYTES);
	});

	// The final flag is the completeness claim bound INTO the ciphertext. This
	// decoder also catches a boundary cut structurally (empty tail), so the flag
	// is belt-and-braces here; it is pinned directly rather than through a
	// decoder path, or nothing would notice it being dropped from the nonce.
	it("seals the tail segment with the final flag and the others without", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG + 5);
		const ct = await seal(pt, dek);
		const header = ct.subarray(0, HEADER_BYTES);
		const salt = header.subarray(SALT_AT, SALT_AT + SALT_BYTES);
		const prefix = header.subarray(SALT_AT + SALT_BYTES, HEADER_BYTES);
		const key = await crypto.subtle.importKey(
			"raw",
			src(await deriveStreamKey(dek, salt, "content")),
			"AES-GCM",
			false,
			["decrypt"],
		);
		const openWith = (data: Uint8Array, counter: number, final: boolean) =>
			crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: src(streamNonceForTests(prefix, counter, final)),
					additionalData: src(header),
				},
				key,
				src(data),
			);
		const sealedSize = SEG + TAG_BYTES;
		const head = ct.subarray(HEADER_BYTES, HEADER_BYTES + sealedSize);
		const tail = ct.subarray(HEADER_BYTES + sealedSize);

		expect(new Uint8Array(await openWith(head, 0, false))).toEqual(
			pt.subarray(0, SEG),
		);
		await expect(openWith(head, 0, true)).rejects.toThrow();
		expect(new Uint8Array(await openWith(tail, 1, true))).toEqual(
			pt.subarray(SEG),
		);
		await expect(openWith(tail, 1, false)).rejects.toThrow();
	});

	it("produces a different ciphertext each time for the same input", async () => {
		const dek = DEK();
		const pt = randomBytes(100);
		expect(await seal(pt, dek)).not.toEqual(await seal(pt, dek));
	});
});

describe("encryptStream / decryptStream round trip", () => {
	it.each([
		0,
		1,
		SEG - 1,
		SEG,
		SEG + 1,
		SEG * 2,
		SEG * 2 + 1,
		SEG * 3 + 77,
	])("round-trips %i plaintext bytes", async (n) => {
		const dek = DEK();
		const pt = randomBytes(n);
		expect(await open(await seal(pt, dek), dek)).toEqual(pt);
	});

	it("round-trips a multi-megabyte payload at the default segment size", async () => {
		const dek = DEK();
		const pt = randomBytes(MAX_SEGMENT_BYTES * 2 + 1234);
		const ct = await collect(encryptStream(source(pt, 65536), dek, "content"));
		expect(ct.length).toBe(HEADER_BYTES + pt.length + 3 * TAG_BYTES);
		const back = await collect(
			decryptStream(source(ct, 65536), dek, "content"),
		);
		// Buffer.compare rather than toEqual: a deep-equal over two megabytes
		// costs seconds and proves nothing extra.
		expect(Buffer.compare(back, pt)).toBe(0);
	});

	// 333 does not divide 1024; a chunk size that does (1024, 2048) hits only
	// the whole-chunk path and passes even when chunks are retained by
	// reference, which would make this test vacuous.
	it.each([
		333, 512,
	])("round-trips a producer recycling one buffer at chunk size %i", async (chunk) => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 700);
		const ct = await collect(
			encryptStream(recyclingSource(pt, chunk), dek, "content", SEG),
		);
		expect(await open(ct, dek)).toEqual(pt);
	});

	it("round-trips a ciphertext source recycling one buffer", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 700);
		const ct = await seal(pt, dek);
		expect(
			await collect(decryptStream(recyclingSource(ct, 333), dek, "content")),
		).toEqual(pt);
	});

	it("round-trips one byte at a time", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG + 3);
		const ct = await collect(encryptStream(source(pt, 1), dek, "content", SEG));
		expect(await collect(decryptStream(source(ct, 1), dek, "content"))).toEqual(
			pt,
		);
	});

	it("ignores empty chunks from either side", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG + 3);
		async function* padded(data: Uint8Array): AsyncIterable<Uint8Array> {
			yield new Uint8Array(0);
			for await (const c of source(data, 97)) {
				yield c;
				yield new Uint8Array(0);
			}
		}
		const ct = await collect(encryptStream(padded(pt), dek, "content", SEG));
		expect(await collect(decryptStream(padded(ct), dek, "content"))).toEqual(
			pt,
		);
	});

	it("round-trips a thumbnail stream", async () => {
		const dek = DEK();
		const pt = randomBytes(200);
		const ct = await collect(encryptStream(source(pt), dek, "thumbnail", SEG));
		expect(await open(ct, dek, "thumbnail")).toEqual(pt);
	});

	it("round-trips plaintext chunks that are views over a larger buffer", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 5);
		const ct = await collect(
			encryptStream(viewSource(pt, SEG), dek, "content", SEG),
		);
		expect(await open(ct, dek)).toEqual(pt);
	});

	it("round-trips plaintext chunks that are pooled Node Buffers", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 5);
		const ct = await collect(
			encryptStream(pooledSource(pt, 512), dek, "content", SEG),
		);
		expect(await open(ct, dek)).toEqual(pt);
	});

	it("round-trips ciphertext chunks that are views over a larger buffer", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 5);
		const ct = await seal(pt, dek);
		expect(
			await collect(
				decryptStream(viewSource(ct, SEG + TAG_BYTES), dek, "content"),
			),
		).toEqual(pt);
	});

	it("round-trips ciphertext chunks that are pooled Node Buffers", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG + 5);
		const ct = await seal(pt, dek);
		expect(
			await collect(decryptStream(pooledSource(ct, 300), dek, "content")),
		).toEqual(pt);
	});

	it("honours byteOffset when the DEK is a view over a larger buffer", async () => {
		const big = randomBytes(64);
		const view = big.subarray(32, 64);
		expect(view.byteLength).toBeLessThan(view.buffer.byteLength);
		const copy = Uint8Array.from(view);
		const pt = randomBytes(SEG + 3);
		expect(await open(await seal(pt, view), copy)).toEqual(pt);
	});
});

describe("decryptStream refusals", () => {
	it("refuses the wrong DEK", async () => {
		const ct = await seal(randomBytes(50), DEK());
		expect((await failure(open(ct, DEK()))).reason).toBe("cannot-open");
	});

	// The thumbnail is a second ciphertext under the same DEK; without subkey
	// separation the two share a key with independent nonce spaces.
	it("refuses a content stream decrypted as a thumbnail", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(50), dek);
		expect((await failure(open(ct, dek, "thumbnail"))).reason).toBe(
			"cannot-open",
		);
	});

	it("refuses an empty ciphertext", async () => {
		const error = await failure(open(new Uint8Array(0), DEK()));
		expect(error.reason).toBe("truncated");
		expect(error.message).toContain("Ciphertext ended before the header");
	});

	it("refuses a partial header", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const error = await failure(open(ct.slice(0, HEADER_BYTES - 1), dek));
		expect(error.reason).toBe("truncated");
		expect(error.message).toContain("Ciphertext ended before the header");
	});

	it("refuses a header with no segments at all", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const error = await failure(open(ct.slice(0, HEADER_BYTES), dek));
		expect(error.reason).toBe("truncated");
		expect(error.message).toContain(
			"Ciphertext ended before the final segment",
		);
	});

	it("refuses a truncated final segment", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(50), dek);
		expect((await failure(open(ct.slice(0, ct.length - 1), dek))).reason).toBe(
			"cannot-open",
		);
	});

	it("refuses a final segment shorter than the tag", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(50), dek);
		const error = await failure(open(ct.slice(0, HEADER_BYTES + 8), dek));
		expect(error.reason).toBe("truncated");
		expect(error.message).toContain(
			"Ciphertext ended before the final segment",
		);
	});

	// The whole point of the final flag plus the short-final-segment invariant:
	// a stream cut on a segment boundary must not read as a complete, shorter
	// file, and the decoder can say so structurally rather than by tag failure.
	it("refuses a stream cut on a segment boundary", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(SEG * 2), dek);
		const twoSegments = HEADER_BYTES + 2 * (SEG + TAG_BYTES);
		const error = await failure(open(ct.slice(0, twoSegments), dek));
		expect(error.reason).toBe("truncated");
		expect(error.message).toContain(
			"Ciphertext ended before the final segment",
		);
	});

	it("refuses a flipped byte in the body", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(200), dek);
		const tampered = Uint8Array.from(ct);
		tampered[HEADER_BYTES + 5] ^= 0xff;
		expect((await failure(open(tampered, dek))).reason).toBe("cannot-open");
	});

	// The header is bound as AAD on every segment, so editing it invalidates the
	// whole stream rather than just re-framing it.
	it("refuses a tampered nonce prefix in the header", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(200), dek);
		const tampered = Uint8Array.from(ct);
		tampered[HEADER_BYTES - 1] ^= 0xff;
		expect((await failure(open(tampered, dek))).reason).toBe("cannot-open");
	});

	it("refuses a tampered salt in the header", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(200), dek);
		const tampered = Uint8Array.from(ct);
		tampered[MAGIC.length + 5] ^= 0xff;
		expect((await failure(open(tampered, dek))).reason).toBe("cannot-open");
	});

	// A declared size the encoder never used still parses, and only the AAD
	// binding stops it re-framing the stream.
	it("refuses a rewritten declared segment size", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(SEG * 2 + 5), dek);
		const tampered = Uint8Array.from(ct);
		dv(tampered).setUint32(MAGIC.length + 1, SEG * 2, false);
		expect((await failure(open(tampered, dek))).reason).toBe("cannot-open");
	});

	it("refuses an unknown magic", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const tampered = Uint8Array.from(ct);
		tampered[0] ^= 0xff;
		const error = await failure(open(tampered, dek));
		expect(error.reason).toBe("not-a-stream");
		expect(error.message).toContain("Not a Ditero stream");
	});

	it("refuses an unknown stream version", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const tampered = Uint8Array.from(ct);
		tampered[MAGIC.length] = 9;
		const error = await failure(open(tampered, dek));
		expect(error.reason).toBe("unsupported-version");
		expect(error.message).toContain("Unsupported stream version 9");
	});

	// Allocation guard: a hostile header must be rejected on the declared size,
	// before anything allocates a buffer of that size.
	it("refuses an oversized declared segment size before allocating", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const tampered = Uint8Array.from(ct);
		dv(tampered).setUint32(MAGIC.length + 1, 0xffffffff, false);
		const error = await failure(open(tampered, dek));
		expect(error.reason).toBe("segment-size-out-of-range");
		expect(error.message).toContain("Declared segment size out of range");
	});

	it("refuses a zero declared segment size", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(10), dek);
		const tampered = Uint8Array.from(ct);
		dv(tampered).setUint32(MAGIC.length + 1, 0, false);
		const error = await failure(open(tampered, dek));
		expect(error.reason).toBe("segment-size-out-of-range");
		expect(error.message).toContain("Declared segment size out of range");
	});

	// Appended bytes are absorbed into the final segment, whose tag then fails.
	// There is no byte pattern that makes this structurally detectable, so the
	// refusal is an authentication failure by construction, not a framing check.
	it("refuses data appended after the final segment", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(50), dek);
		const extended = new Uint8Array(ct.length + 32);
		extended.set(ct, 0);
		expect((await failure(open(extended, dek))).reason).toBe("cannot-open");
	});

	it("refuses a whole extra segment appended after the final segment", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(SEG + 5), dek);
		const extended = new Uint8Array(ct.length + SEG + TAG_BYTES);
		extended.set(ct, 0);
		expect((await failure(open(extended, dek))).reason).toBe("cannot-open");
	});

	it("refuses reordered segments", async () => {
		const dek = DEK();
		const ct = await seal(randomBytes(SEG * 2 + 10), dek);
		const sealed = SEG + TAG_BYTES;
		const swapped = Uint8Array.from(ct);
		swapped.set(
			ct.subarray(HEADER_BYTES + sealed, HEADER_BYTES + sealed * 2),
			HEADER_BYTES,
		);
		swapped.set(
			ct.subarray(HEADER_BYTES, HEADER_BYTES + sealed),
			HEADER_BYTES + sealed,
		);
		expect(swapped).not.toEqual(ct);
		expect((await failure(open(swapped, dek))).reason).toBe("cannot-open");
	});

	// A segment lifted from another file under the same DEK: the per-file salt
	// and nonce prefix are what stop it authenticating here.
	it("refuses a segment spliced in from another stream", async () => {
		const dek = DEK();
		const sealedSize = SEG + TAG_BYTES;
		const one = await seal(randomBytes(SEG * 2 + 10), dek);
		const two = await seal(randomBytes(SEG * 2 + 10), dek);
		const spliced = Uint8Array.from(one);
		spliced.set(
			two.subarray(HEADER_BYTES, HEADER_BYTES + sealedSize),
			HEADER_BYTES,
		);
		expect((await failure(open(spliced, dek))).reason).toBe("cannot-open");
	});

	it("refuses an unknown purpose before pulling from the source", async () => {
		let pulled = false;
		async function* watched(): AsyncIterable<Uint8Array> {
			pulled = true;
			yield new Uint8Array(1);
		}
		await expect(
			collect(decryptStream(watched(), DEK(), "other" as StreamPurpose)),
		).rejects.toThrow('stream: unknown purpose "other"');
		// deriveStreamKey re-checks the purpose, so asserting only the throw
		// passes with the early check deleted; the difference is that the early
		// one refuses without consuming a stream it can never decrypt.
		expect(pulled).toBe(false);
	});

	it("refuses a plaintext chunk that is not bytes", async () => {
		async function* bad(): AsyncIterable<Uint8Array> {
			yield "hello" as unknown as Uint8Array;
		}
		await expect(
			collect(encryptStream(bad(), DEK(), "content", SEG)),
		).rejects.toThrow("stream: plaintext chunks must be byte views");
	});

	it("refuses a source chunk that is not bytes", async () => {
		async function* bad(): AsyncIterable<Uint8Array> {
			yield "DTRO1" as unknown as Uint8Array;
		}
		await expect(
			collect(decryptStream(bad(), DEK(), "content")),
		).rejects.toThrow("stream: ciphertext chunks must be byte views");
	});
});

// Design 5 requires that no partial plaintext reaches the USER; the sink that
// holds it back is the caller's, not this module's, because buffering a
// multi-megabyte file here would defeat the constant-memory goal that is the
// point of streaming. This pins the contract so the obligation cannot be
// forgotten: segments 1..n-1 ARE yielded before the final one authenticates.
describe("partial plaintext contract", () => {
	it("yields earlier segments before the final segment authenticates", async () => {
		const dek = DEK();
		const pt = randomBytes(SEG * 2 + 10);
		const ct = await seal(pt, dek);
		const tampered = Uint8Array.from(ct);
		tampered[ct.length - 1] ^= 0xff;

		const seen: Uint8Array[] = [];
		let threw: unknown;
		try {
			for await (const chunk of decryptStream(
				source(tampered, 97),
				dek,
				"content",
			)) {
				seen.push(chunk);
			}
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeInstanceOf(StreamError);
		expect(seen.reduce((n, c) => n + c.length, 0)).toBe(SEG * 2);
	});

	it("closes the ciphertext source when it aborts", async () => {
		let closed = false;
		async function* watched(data: Uint8Array): AsyncIterable<Uint8Array> {
			try {
				yield data;
			} finally {
				closed = true;
			}
		}
		const bad = Uint8Array.from(await seal(randomBytes(10), DEK()));
		bad[0] ^= 0xff;
		await failure(collect(decryptStream(watched(bad), DEK(), "content")));
		expect(closed).toBe(true);
	});
});
