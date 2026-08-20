// Every wrap in the system routes through here, so the wire shape is a one-way
// door: `version` selects the FORMAT, not a cost parameter, which is why
// encryptWrapped takes no version argument the way deriveKek does. Old wraps
// must stay openable, but nothing should ever be written in an old format, so
// the version registry below is decrypt-side only. Raising the version is
// therefore ADDITIVE: add an opener, never retire one, or every stored wrap at
// the retired version -- private keys, DEKs, filenames -- becomes unreadable.
export const ENVELOPE_VERSION = 1;

export const KEY_BYTES = 32;

// 96 bits is AES-GCM's standard nonce; other lengths are legal but route
// through a GHASH derivation. Random rather than a counter: this module wraps
// keys and short metadata, so no key here is used often enough for the 2^-32
// birthday bound at 2^32 wraps to matter (a WDK wraps one DEK per attachment
// per key version, a DEK wraps two metadata fields, a KEK wraps one key). The
// high-volume path -- blob segments -- deliberately does NOT use this module
// and derives counter nonces instead. A counter here would need cross-device
// coordination that a local-first client cannot have, and a device restored
// from backup would replay it.
export const NONCE_BYTES = 12;

// Full-length GCM tag. A truncated tag is a real forgery weakening and is
// unrecoverable once wraps are stored, so it is pinned rather than defaulted.
export const TAG_BYTES = 16;
const TAG_BITS = TAG_BYTES * 8;

export type Wrapped = {
	version: number;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
};

export type MetadataField = "filename" | "contentType";

const METADATA_FIELDS: readonly MetadataField[] = ["filename", "contentType"];

export type EnvelopeOpenFailure =
	| "unsupported-version"
	| "malformed"
	| "cannot-open";

// The UI must tell "this record predates a format change" and "this record is
// corrupt" apart from "your passphrase is wrong". WebCrypto signals all three
// as one bare OperationError, so the discriminant is assigned by phase.
export class EnvelopeOpenError extends Error {
	constructor(
		readonly reason: EnvelopeOpenFailure,
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "EnvelopeOpenError";
	}
}

const SEPARATOR = "|";

// Shared with every other AAD builder in this directory (hpke.ts, and the
// invite fragment later). Hand-rolling the checks per module is how hpke.ts
// ended up binding a "NaN" key version that no rotation could reproduce.
export function aadId(field: string, value: string): string {
	// The separator is the whole binding: an identifier carrying one lets two
	// distinct contexts serialize identically, so a ciphertext bound to one
	// would authenticate under the other.
	if (value.includes(SEPARATOR)) {
		throw new Error(`aad: ${field} must not contain "${SEPARATOR}"`);
	}
	// Injectivity survives an empty id, but an unresolved id is always a caller
	// bug and the wrap it mints only fails later, against the real id.
	if (value === "") {
		throw new Error(`aad: ${field} must not be empty`);
	}
	return value;
}

export function aadKeyVersion(keyVersion: number): string {
	// "NaN" and "1.5" both serialize without collapsing, so the binding stays
	// injective and every check here passes -- and no rotation can ever
	// reproduce the value, leaving the wrap permanently unopenable.
	if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
		throw new Error(
			`aad: keyVersion must be a positive integer, got ${keyVersion}`,
		);
	}
	return String(keyVersion);
}

export function joinAad(parts: readonly string[]): Uint8Array {
	return new TextEncoder().encode(parts.join(SEPARATOR));
}

// The ":v1" inside these prefixes is the AAD's OWN version and is independent
// of ENVELOPE_VERSION, which versions the {nonce, ciphertext} record. Bumping
// one does not move the other: a new envelope format over the same context
// keeps these strings, and a re-cut binding over the same format changes only
// the prefix. Either change orphans existing data, so both are additive.
export const aad = {
	privateKeyPassphrase: (userId: string) =>
		joinAad(["ditero:sk-pass:v1", aadId("userId", userId)]),
	privateKeyRecovery: (userId: string) =>
		joinAad(["ditero:sk-recovery:v1", aadId("userId", userId)]),
	privateKeyDevice: (userId: string, deviceId: string) =>
		joinAad([
			"ditero:sk-device:v1",
			aadId("userId", userId),
			aadId("deviceId", deviceId),
		]),
	dek: (workspaceId: string, keyVersion: number, attachmentId: string) =>
		joinAad([
			"ditero:dek:v1",
			aadId("workspaceId", workspaceId),
			aadKeyVersion(keyVersion),
			aadId("attachmentId", attachmentId),
		]),
	metadata: (attachmentId: string, field: MetadataField) => {
		// The union stops guarding this the moment a caller casts, and the field
		// is the only thing keeping two ciphertexts on the same row apart.
		if (!METADATA_FIELDS.includes(field)) {
			throw new Error(`envelope: unknown metadata field "${field}"`);
		}
		return joinAad([
			"ditero:meta:v1",
			aadId("attachmentId", attachmentId),
			field,
		]);
	},
};

// WebCrypto rejects a SharedArrayBuffer-backed view, and the DOM types say so;
// this narrows to that contract without copying, so byteOffset is preserved.
// Passing `.buffer` instead of the view would seal the whole backing store.
// Deliberately `instanceof ArrayBuffer` and NOT `!(x instanceof
// SharedArrayBuffer)`: a cross-realm ArrayBuffer fails this check, which costs
// a caller one copy, whereas the inverted form passes anything unrecognised
// straight through. Same check, and only this direction fails safe.
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
	if (!(view.buffer instanceof ArrayBuffer)) {
		throw new Error("envelope: byte views must not be shared-memory backed");
	}
	return view as Uint8Array<ArrayBuffer>;
}

// importKey also accepts 16 and 24 bytes, silently downgrading this module from
// AES-256 to AES-128 with every test still green.
function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
	if (raw.length !== KEY_BYTES) {
		throw new Error(`envelope: key must be ${KEY_BYTES} bytes`);
	}
	return crypto.subtle.importKey("raw", bytes(raw), "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

// The module's premise, and design 4.5, is that nothing is wrapped without
// stating its context. The aad.* helpers all return non-empty, but nothing
// forces a caller through them.
function requireAad(additionalData: Uint8Array): void {
	if (additionalData.length === 0) {
		throw new Error("envelope: additionalData must not be empty");
	}
}

export async function encryptWrapped(
	plaintext: Uint8Array,
	key: Uint8Array,
	additionalData: Uint8Array,
): Promise<Wrapped> {
	requireAad(additionalData);
	const aesKey = await importAesKey(key);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: nonce,
			additionalData: bytes(additionalData),
			tagLength: TAG_BITS,
		},
		aesKey,
		bytes(plaintext),
	);
	return {
		version: ENVELOPE_VERSION,
		nonce,
		ciphertext: new Uint8Array(ciphertext),
	};
}

type EnvelopeOpener = (
	wrapped: Wrapped,
	key: Uint8Array,
	additionalData: Uint8Array,
) => Promise<Uint8Array>;

async function openV1(
	wrapped: Wrapped,
	key: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	// Record shape before key work: a broken record must never be reported as a
	// key failure, or a column truncated by a bad restore reads as a bad
	// passphrase and the user burns their recovery code on it too.
	//
	// AES-GCM accepts any nonce length, so a wrong-length nonce would otherwise
	// open the GHASH path and fail indistinguishably from a wrong key.
	if (wrapped.nonce.length !== NONCE_BYTES) {
		throw new EnvelopeOpenError(
			"malformed",
			`envelope: malformed envelope, nonce must be ${NONCE_BYTES} bytes`,
		);
	}
	// No valid AES-GCM output is shorter than its tag, so this is definitionally
	// a truncated record rather than a wrong key.
	if (wrapped.ciphertext.length < TAG_BYTES) {
		throw new EnvelopeOpenError(
			"malformed",
			`envelope: malformed envelope, ciphertext must be at least ${TAG_BYTES} bytes`,
		);
	}
	const aesKey = await importAesKey(key);
	const params = {
		name: "AES-GCM",
		iv: bytes(wrapped.nonce),
		additionalData: bytes(additionalData),
		tagLength: TAG_BITS,
	};
	const ciphertext = bytes(wrapped.ciphertext);
	try {
		const plaintext = await crypto.subtle.decrypt(params, aesKey, ciphertext);
		return new Uint8Array(plaintext);
	} catch (cause) {
		throw new EnvelopeOpenError(
			"cannot-open",
			"envelope: cannot open envelope",
			cause,
		);
	}
}

// Every version ever written needs an entry here forever. Deleting one makes
// its stored wraps unrecoverable by any route, and no test outside this module
// would go red.
export const ENVELOPE_OPENERS: Record<number, EnvelopeOpener> = {
	1: openV1,
};

export async function decryptWrapped(
	wrapped: Wrapped,
	key: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	// The AAD is the context the caller claims; with none there is nothing to
	// classify the record against, so this precedes the record checks. It is a
	// programming error either way -- stored data never supplies it.
	requireAad(additionalData);
	// Split by phase, not by caught error class. The version is a property of the
	// stored record and must be reported ahead of any key work: reversed, every
	// old-format row surfaces as "wrong key" and the user is told to fix a
	// passphrase that was never the problem.
	const open = ENVELOPE_OPENERS[wrapped.version];
	if (!open) {
		throw new EnvelopeOpenError(
			"unsupported-version",
			`envelope: unsupported envelope version ${wrapped.version}`,
		);
	}
	return await open(wrapped, key, additionalData);
}
