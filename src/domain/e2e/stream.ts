// AES-GCM-HKDF-STREAMING, the Tink streaming-AEAD shape, adopted rather than
// invented (design 5).
//
//   header  = magic(5) || version(1) || segmentSize(4 BE) || salt(16) || noncePrefix(7)
//   fileKey = HKDF-SHA256(DEK, salt, "ditero:stream:<purpose>:v1")
//   nonce_i = noncePrefix(7) || counter_i(4 BE) || finalFlag(1)     // exactly 12 bytes
//
// The 12-byte nonce is deliberate: AES-GCM's standard nonce is 96 bits, and any
// other length goes through a GHASH derivation for no benefit. The 16-byte salt
// gives per-file key separation rather than leaning on the 56-bit prefix alone.
// The whole header is bound as AAD on every segment, so re-framing a stream by
// editing its declared segment size invalidates it instead of reinterpreting it.
//
// FRAMING INVARIANT: the final segment always carries STRICTLY FEWER than
// segmentSize plaintext bytes, so an exact multiple ends with an empty final
// segment costing one extra tag. That is what lets the decoder treat any full
// sealed segment as non-final on sight -- and what lets it report a stream cut
// on a segment boundary as a truncation rather than as a tag failure.
//
// PARTIAL PLAINTEXT: decryptStream yields each segment as it authenticates, so
// segments 1..n-1 reach the caller before the final segment proves the stream
// is complete. Design 5 forbids surfacing partial plaintext TO THE USER, and
// that obligation is the caller's: downloads land in a temporary sink and are
// handed over only after this iterator completes without throwing. Buffering
// here instead would defeat the constant-memory goal that streaming exists for.
//
// Everything above is a one-way door: it shapes bytes at rest the moment a user
// uploads a file.

export const MAGIC = new Uint8Array([0x44, 0x54, 0x52, 0x4f, 0x31]); // "DTRO1"

// Selects the FORMAT, not a cost parameter. Raising it is ADDITIVE: add a
// reader to STREAM_FORMATS, never retire one, or every blob written at the
// retired version becomes unreadable.
export const STREAM_VERSION = 1;

export const DEK_BYTES = 32;
export const SALT_BYTES = 16;
export const NONCE_PREFIX_BYTES = 7;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
const TAG_BITS = TAG_BYTES * 8;
const MAX_COUNTER = 0xffffffff;

// magic and version sit at fixed offsets for every version that will ever
// exist; nothing past them may be read without first selecting a format.
const VERSION_OFFSET = MAGIC.length;
const PREAMBLE_BYTES = MAGIC.length + 1;

const SEGMENT_SIZE_OFFSET = PREAMBLE_BYTES;
const SALT_OFFSET = SEGMENT_SIZE_OFFSET + 4;
const PREFIX_OFFSET = SALT_OFFSET + SALT_BYTES;
export const HEADER_BYTES = PREFIX_OFFSET + NONCE_PREFIX_BYTES; // 33

export const MIN_SEGMENT_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 1024 * 1024;
export const DEFAULT_SEGMENT_BYTES = MAX_SEGMENT_BYTES;

export type StreamPurpose = "content" | "thumbnail";

const PURPOSES: readonly StreamPurpose[] = ["content", "thumbnail"];

export type StreamFailure =
	| "not-a-stream"
	| "unsupported-version"
	| "segment-size-out-of-range"
	| "truncated"
	| "counter-overflow"
	| "cannot-open";

// The UI must tell "this blob is not ours or predates a format change" and
// "this download was cut short" apart from "this ciphertext was tampered with
// or is not yours". WebCrypto signals the last of those as a bare
// OperationError, so the discriminant is assigned by phase.
export class StreamError extends Error {
	constructor(
		readonly reason: StreamFailure,
		message: string,
		cause?: unknown,
	) {
		super(`stream: ${message}`, { cause });
		this.name = "StreamError";
	}
}

// WebCrypto rejects a SharedArrayBuffer-backed view, and the DOM types say so;
// this narrows to that contract without copying, so byteOffset is preserved.
// Passing `.buffer` instead of the view would seal the whole backing store --
// the hazard this module is most exposed to, since every segment is a view over
// a larger buffer by construction. Deliberately `instanceof ArrayBuffer` and
// NOT `!(x instanceof SharedArrayBuffer)`: a cross-realm ArrayBuffer fails this
// check, costing one copy, whereas the inverted form passes anything
// unrecognised straight through.
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
	if (!(view.buffer instanceof ArrayBuffer)) {
		throw new Error("stream: byte views must not be shared-memory backed");
	}
	return view as Uint8Array<ArrayBuffer>;
}

function view(v: Uint8Array): DataView {
	return new DataView(v.buffer, v.byteOffset, v.byteLength);
}

function requirePurpose(purpose: StreamPurpose): void {
	// The union stops guarding this the moment a caller casts, and the purpose
	// is the only thing keeping an attachment's two ciphertexts on separate keys.
	if (!PURPOSES.includes(purpose)) {
		throw new Error(`stream: unknown purpose "${purpose}"`);
	}
}

export async function deriveStreamKey(
	dek: Uint8Array,
	salt: Uint8Array,
	purpose: StreamPurpose,
): Promise<Uint8Array> {
	// HKDF accepts any IKM length, so a short or empty DEK derives a perfectly
	// usable key and every round-trip stays green.
	if (dek.length !== DEK_BYTES) {
		throw new Error(`stream: DEK must be ${DEK_BYTES} bytes`);
	}
	if (salt.length !== SALT_BYTES) {
		throw new Error(`stream: salt must be ${SALT_BYTES} bytes`);
	}
	requirePurpose(purpose);
	const base = await crypto.subtle.importKey("raw", bytes(dek), "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: bytes(salt),
			// ":v1" is this label's OWN version and moves independently of
			// STREAM_VERSION, which versions the header record. Either change
			// orphans stored blobs, so both are additive.
			info: new TextEncoder().encode(`ditero:stream:${purpose}:v1`),
		},
		base,
		256,
	);
	return new Uint8Array(bits);
}

// importKey also accepts 16 and 24 bytes, silently downgrading this module from
// AES-256 to AES-128 with every test still green.
function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== 32) throw new Error("stream: file key must be 32 bytes");
	return crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

function nonceFor(
	prefix: Uint8Array,
	counter: number,
	final: boolean,
): Uint8Array {
	// setUint32 wraps silently past 2^32, which reuses a nonce under the same
	// key -- the one failure AES-GCM does not survive. Unreachable in practice
	// (4 PiB at the default segment size) but not left to chance.
	if (!Number.isSafeInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
		throw new StreamError(
			"counter-overflow",
			`Segment counter out of range: ${counter}`,
		);
	}
	const nonce = new Uint8Array(NONCE_BYTES);
	nonce.set(prefix, 0);
	view(nonce).setUint32(NONCE_PREFIX_BYTES, counter, false);
	nonce[NONCE_BYTES - 1] = final ? 1 : 0;
	return nonce;
}

/** Test-only. The nonce layout is stored-byte shape and needs pinning directly. */
export function streamNonceForTests(
	prefix: Uint8Array,
	counter: number,
	final: boolean,
): Uint8Array {
	return nonceFor(prefix, counter, final);
}

// Chunk boundaries are the caller's and never match segment boundaries, so
// bytes are held as a list and joined only when a whole segment is available.
// Concatenating the pending buffer on every push instead is O(n^2) and copies
// hundreds of megabytes per segment on a 4 KiB reader.
class ChunkQueue {
	#chunks: Uint8Array[] = [];
	#bytes = 0;

	get length(): number {
		return this.#bytes;
	}

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.length;
	}

	take(n: number): Uint8Array {
		if (n > this.#bytes) throw new Error("stream: take beyond buffered bytes");
		const first = this.#chunks[0];
		// Fast path: hand the caller's own chunk through untouched. It may be a
		// view over a much larger buffer, which every consumer here must honour.
		if (first && first.length === n) {
			this.#chunks.shift();
			this.#bytes -= n;
			return first;
		}
		const out = new Uint8Array(n);
		let at = 0;
		while (at < n) {
			const head = this.#chunks[0];
			if (!head) throw new Error("stream: take beyond buffered bytes");
			const want = Math.min(n - at, head.length);
			out.set(want === head.length ? head : head.subarray(0, want), at);
			at += want;
			if (want === head.length) this.#chunks.shift();
			else this.#chunks[0] = head.subarray(want);
		}
		this.#bytes -= n;
		return out;
	}
}

function requireSegmentSize(segmentSize: number): void {
	if (
		!Number.isSafeInteger(segmentSize) ||
		segmentSize < MIN_SEGMENT_BYTES ||
		segmentSize > MAX_SEGMENT_BYTES
	) {
		throw new Error(
			`stream: segmentSize must be between ${MIN_SEGMENT_BYTES} and ${MAX_SEGMENT_BYTES}, got ${segmentSize}`,
		);
	}
}

function buildHeader(
	segmentSize: number,
	salt: Uint8Array,
	prefix: Uint8Array,
): Uint8Array {
	const header = new Uint8Array(HEADER_BYTES);
	header.set(MAGIC, 0);
	header[VERSION_OFFSET] = STREAM_VERSION;
	view(header).setUint32(SEGMENT_SIZE_OFFSET, segmentSize, false);
	header.set(salt, SALT_OFFSET);
	header.set(prefix, PREFIX_OFFSET);
	return header;
}

export async function* encryptStream(
	plaintext: AsyncIterable<Uint8Array>,
	dek: Uint8Array,
	purpose: StreamPurpose,
	segmentSize: number = DEFAULT_SEGMENT_BYTES,
): AsyncIterable<Uint8Array> {
	requireSegmentSize(segmentSize);
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const prefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
	const header = buildHeader(segmentSize, salt, prefix);
	// Everything that can reject the caller's arguments runs before the header
	// is emitted, so a rejected call never leaves a half-written blob.
	const key = await importAesKey(await deriveStreamKey(dek, salt, purpose));
	yield header;

	let counter = 0;
	const sealSegment = async (data: Uint8Array, final: boolean) => {
		const nonce = nonceFor(prefix, counter, final);
		const sealed = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: bytes(nonce),
				additionalData: bytes(header),
				tagLength: TAG_BITS,
			},
			key,
			bytes(data),
		);
		counter += 1;
		return new Uint8Array(sealed);
	};

	const pending = new ChunkQueue();
	for await (const chunk of plaintext) {
		if (!ArrayBuffer.isView(chunk)) {
			throw new Error("stream: plaintext chunks must be byte views");
		}
		pending.push(chunk as Uint8Array);
		// `>=`, not `>`: a full segment is never the final one, so it can be
		// sealed the moment it is complete without waiting to see what follows.
		while (pending.length >= segmentSize) {
			yield await sealSegment(pending.take(segmentSize), false);
		}
	}
	yield await sealSegment(pending.take(pending.length), true);
}

type Source = {
	/** Pulls until at least n bytes are buffered; false at end of input. */
	fill: (n: number) => Promise<boolean>;
	queue: ChunkQueue;
};

type StreamFormat = {
	headerBytes: number;
	decrypt: (
		header: Uint8Array,
		source: Source,
		dek: Uint8Array,
		purpose: StreamPurpose,
	) => AsyncIterable<Uint8Array>;
};

async function* decryptV1(
	header: Uint8Array,
	source: Source,
	dek: Uint8Array,
	purpose: StreamPurpose,
): AsyncIterable<Uint8Array> {
	const declared = view(header).getUint32(SEGMENT_SIZE_OFFSET, false);
	// Checked before anything sized by it is allocated or buffered: an
	// unbounded declared size is an allocation DoS from a hostile header alone.
	if (declared < MIN_SEGMENT_BYTES || declared > MAX_SEGMENT_BYTES) {
		throw new StreamError(
			"segment-size-out-of-range",
			`Declared segment size out of range: ${declared}`,
		);
	}
	const salt = header.subarray(SALT_OFFSET, SALT_OFFSET + SALT_BYTES);
	const prefix = header.subarray(PREFIX_OFFSET, HEADER_BYTES);
	const key = await importAesKey(await deriveStreamKey(dek, salt, purpose));

	let counter = 0;
	const openSegment = async (data: Uint8Array, final: boolean) => {
		const nonce = nonceFor(prefix, counter, final);
		try {
			const plain = await crypto.subtle.decrypt(
				{
					name: "AES-GCM",
					iv: bytes(nonce),
					additionalData: bytes(header),
					tagLength: TAG_BITS,
				},
				key,
				bytes(data),
			);
			counter += 1;
			return new Uint8Array(plain);
		} catch (cause) {
			throw new StreamError(
				"cannot-open",
				`Cannot open segment ${counter}`,
				cause,
			);
		}
	};

	const sealedSize = declared + TAG_BYTES;
	while (await source.fill(sealedSize)) {
		yield await openSegment(source.queue.take(sealedSize), false);
	}

	// The framing invariant makes the tail unambiguous: a complete stream always
	// ends with a segment shorter than a full one, so an empty tail is a stream
	// cut exactly on a segment boundary -- the case the final flag exists for,
	// caught structurally rather than as a tag failure.
	const rest = source.queue.length;
	if (rest < TAG_BYTES) {
		throw new StreamError(
			"truncated",
			"Ciphertext ended before the final segment",
		);
	}
	yield await openSegment(source.queue.take(rest), true);
}

// Every version ever written needs an entry here forever. Deleting one makes
// its stored blobs unrecoverable by any route, and no test outside this module
// would go red. Per-version record validation lives inside the reader, because
// a later version may use a different header width, segment range or nonce
// layout; only the magic and the version byte are fixed across versions.
export const STREAM_FORMATS: Record<number, StreamFormat> = {
	1: { headerBytes: HEADER_BYTES, decrypt: decryptV1 },
};

export async function* decryptStream(
	ciphertext: AsyncIterable<Uint8Array>,
	dek: Uint8Array,
	purpose: StreamPurpose,
): AsyncIterable<Uint8Array> {
	requirePurpose(purpose);
	const iterator = ciphertext[Symbol.asyncIterator]();
	const queue = new ChunkQueue();
	const fill = async (n: number): Promise<boolean> => {
		while (queue.length < n) {
			const next = await iterator.next();
			if (next.done) return false;
			if (!ArrayBuffer.isView(next.value)) {
				throw new Error("stream: ciphertext chunks must be byte views");
			}
			queue.push(next.value as Uint8Array);
		}
		return true;
	};

	try {
		if (!(await fill(PREAMBLE_BYTES))) {
			throw new StreamError("truncated", "Ciphertext ended before the header");
		}
		const preamble = queue.take(PREAMBLE_BYTES);
		if (!MAGIC.every((b, i) => preamble[i] === b)) {
			throw new StreamError("not-a-stream", "Not a Ditero stream");
		}
		const version = preamble[VERSION_OFFSET] as number;
		const format = STREAM_FORMATS[version];
		if (!format) {
			throw new StreamError(
				"unsupported-version",
				`Unsupported stream version ${version}`,
			);
		}
		const remaining = format.headerBytes - PREAMBLE_BYTES;
		if (!(await fill(remaining))) {
			throw new StreamError("truncated", "Ciphertext ended before the header");
		}
		const header = new Uint8Array(format.headerBytes);
		header.set(preamble, 0);
		header.set(queue.take(remaining), PREAMBLE_BYTES);
		yield* format.decrypt(header, { fill, queue }, dek, purpose);
	} finally {
		// A refused stream must not leave the reader open; the source is usually
		// a generator holding a file handle or a response body.
		await iterator.return?.();
	}
}
