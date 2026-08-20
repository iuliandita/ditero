// Every wrap in the system routes through here, so the wire shape is a one-way
// door: `version` selects the FORMAT, not a cost parameter, which is why
// encryptWrapped takes no version argument the way deriveKek does. Old wraps
// must stay openable, but nothing should ever be written in an old format, so
// the version registry belongs on the decrypt side alone.
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

function id(field: string, value: string): string {
	// The separator is the whole binding: an identifier carrying one lets two
	// distinct contexts serialize identically, so a ciphertext bound to one
	// would authenticate under the other.
	if (value.includes(SEPARATOR)) {
		throw new Error(`envelope: ${field} must not contain "${SEPARATOR}"`);
	}
	return value;
}

function keyVersionPart(keyVersion: number): string {
	if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
		throw new Error(
			`envelope: keyVersion must be a positive integer, got ${keyVersion}`,
		);
	}
	return String(keyVersion);
}

const join = (parts: string[]) =>
	new TextEncoder().encode(parts.join(SEPARATOR));

export const aad = {
	privateKeyPassphrase: (userId: string) =>
		join(["ditero:sk-pass:v1", id("userId", userId)]),
	privateKeyRecovery: (userId: string) =>
		join(["ditero:sk-recovery:v1", id("userId", userId)]),
	privateKeyDevice: (userId: string, deviceId: string) =>
		join([
			"ditero:sk-device:v1",
			id("userId", userId),
			id("deviceId", deviceId),
		]),
	dek: (workspaceId: string, keyVersion: number, attachmentId: string) =>
		join([
			"ditero:dek:v1",
			id("workspaceId", workspaceId),
			keyVersionPart(keyVersion),
			id("attachmentId", attachmentId),
		]),
	metadata: (attachmentId: string, field: MetadataField) => {
		// The union stops guarding this the moment a caller casts, and the field
		// is the only thing keeping two ciphertexts on the same row apart.
		if (!METADATA_FIELDS.includes(field)) {
			throw new Error(`envelope: unknown metadata field "${field}"`);
		}
		return join(["ditero:meta:v1", id("attachmentId", attachmentId), field]);
	},
};

// WebCrypto rejects a SharedArrayBuffer-backed view, and the DOM types say so;
// this narrows to that contract without copying, so byteOffset is preserved.
// Passing `.buffer` instead of the view would seal the whole backing store.
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

export async function encryptWrapped(
	plaintext: Uint8Array,
	key: Uint8Array,
	additionalData: Uint8Array,
): Promise<Wrapped> {
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

export async function decryptWrapped(
	wrapped: Wrapped,
	key: Uint8Array,
	additionalData: Uint8Array,
): Promise<Uint8Array> {
	// Split by phase, not by caught error class. The version is a property of the
	// stored record and must be reported ahead of any key work: reversed, every
	// old-format row surfaces as "wrong key" and the user is told to fix a
	// passphrase that was never the problem.
	if (wrapped.version !== ENVELOPE_VERSION) {
		throw new EnvelopeOpenError(
			"unsupported-version",
			`envelope: unsupported envelope version ${wrapped.version}`,
		);
	}
	// AES-GCM accepts any nonce length, so a wrong-length nonce would otherwise
	// open the GHASH path and fail indistinguishably from a wrong key.
	if (wrapped.nonce.length !== NONCE_BYTES) {
		throw new EnvelopeOpenError(
			"malformed",
			`envelope: malformed envelope, nonce must be ${NONCE_BYTES} bytes`,
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
