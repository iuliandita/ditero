import {
	EnvelopeOpenError,
	NONCE_BYTES,
	TAG_BYTES,
	type Wrapped,
} from "./envelope.ts";

// The single string form of a Wrapped record, for the text columns that hold
// one (user_key.passphrase_wrapped and friends). encryptWrapped returns three
// fields and the schema has one column, so something has to join them; doing it
// per caller is how two call sites end up with two orders and a wrap that
// decodes into a nonce made of ciphertext.
//
// Layout: base64url( version | nonce | ciphertext ). The version leads so the
// decoder can dispatch before it assumes any length -- a v2 with a different
// nonce size stays decodable, which a fixed 12-byte split would not be.

export const MAX_WRAPPED_LENGTH = 64 * 1024;

type WrappedLayout = { nonceBytes: number };

// Same contract as ENVELOPE_OPENERS: an entry deleted here makes every wrap
// ever written under that version unreadable, and nothing outside this file
// goes red.
const LAYOUTS: Record<number, WrappedLayout> = {
	1: { nonceBytes: NONCE_BYTES },
};

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	// Chunked: String.fromCharCode(...bytes) spreads one argument per byte, and
	// the spread limit is engine-specific (historically ~65535 on Safari, far
	// higher on V8). No portable payload size proves this necessary, so the
	// tests pin only that chunking round-trips; this stays for the engines that
	// do cap low.
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	// atob accepts neither the URL alphabet nor missing padding, and it throws a
	// bare InvalidCharacterError that says nothing about which record failed.
	if (!/^[A-Za-z0-9_-]*$/.test(value)) {
		throw new EnvelopeOpenError("malformed", "wire: not base64url");
	}
	const padded = value.replace(/-/g, "+").replace(/_/g, "/");
	let binary: string;
	try {
		binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
	} catch (cause) {
		throw new EnvelopeOpenError("malformed", "wire: not base64url", cause);
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

export function encodeWrapped(wrapped: Wrapped): string {
	const layout = LAYOUTS[wrapped.version];
	// The encoder only ever emits shapes the decoder can dispatch. Without this
	// a caller could construct a Wrapped by hand at an unregistered version,
	// store it, and discover at unlock that nothing can read it back.
	if (!layout) {
		throw new EnvelopeOpenError(
			"unsupported-version",
			`wire: unsupported envelope version ${wrapped.version}`,
		);
	}
	if (wrapped.nonce.length !== layout.nonceBytes) {
		throw new EnvelopeOpenError(
			"malformed",
			`wire: v${wrapped.version} nonce must be ${layout.nonceBytes} bytes`,
		);
	}
	const out = new Uint8Array(
		1 + wrapped.nonce.length + wrapped.ciphertext.length,
	);
	out[0] = wrapped.version;
	out.set(wrapped.nonce, 1);
	out.set(wrapped.ciphertext, 1 + wrapped.nonce.length);
	return toBase64Url(out);
}

export function decodeWrapped(value: string): Wrapped {
	// Bounded before it is scanned: this arrives from a database column and, on
	// the grant path, from another user's write.
	if (value.length > MAX_WRAPPED_LENGTH) {
		throw new EnvelopeOpenError("malformed", "wire: wrapped record too long");
	}
	const raw = fromBase64Url(value);
	const version = raw[0];
	if (version === undefined) {
		throw new EnvelopeOpenError("malformed", "wire: empty wrapped record");
	}
	const layout = LAYOUTS[version];
	// Reported ahead of any length check, matching decryptWrapped: a record from
	// a newer client must say so, not surface as corruption the user might try
	// to fix by retyping a passphrase.
	if (!layout) {
		throw new EnvelopeOpenError(
			"unsupported-version",
			`wire: unsupported envelope version ${version}`,
		);
	}
	// A ciphertext shorter than the GCM tag cannot be a wrap of anything, and
	// slicing without this yields an empty ciphertext that fails later as
	// "cannot-open" -- indistinguishable from a wrong passphrase.
	if (raw.length < 1 + layout.nonceBytes + TAG_BYTES) {
		throw new EnvelopeOpenError("malformed", "wire: wrapped record truncated");
	}
	return {
		version,
		nonce: raw.slice(1, 1 + layout.nonceBytes),
		ciphertext: raw.slice(1 + layout.nonceBytes),
	};
}

export { fromBase64Url as decodeBytes, toBase64Url as encodeBytes };
