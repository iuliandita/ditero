// Crockford base32: 32 symbols with I, L, O and U left out. The first three
// are omitted because they are ambiguous against 1, 1 and 0 on paper, and U so
// that a random code cannot spell an obscenity at the user.
export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const BITS_PER_SYMBOL = 5;

export const RECOVERY_GROUP_SIZE = 5;

export type RecoveryFormat = {
	version: number;
	payloadGroups: number;
	checksumGroups: number;
	payloadLength: number;
	checksumLength: number;
	// The checksum's domain string, and the second "v1" in this module. It
	// versions the checksum construction, not the format record.
	domain: string;
};

// 6 groups of 5 symbols = 30 symbols x 5 bits = 150 bits of entropy, over the
// ~128 the design asks for and a whole number of symbols, which a 128-bit
// target is not. The seventh group is a checksum and carries no entropy.
const V1: RecoveryFormat = {
	version: 1,
	payloadGroups: 6,
	checksumGroups: 1,
	payloadLength: 30,
	checksumLength: 5,
	domain: "ditero:recovery:v1",
};

// Keyed by the canonical length, because a printed code has no room for a
// version marker and its length is the only discriminant it already carries. A
// `!== 35` here would be the same landmine a constant envelope version was:
// bump it for a second format and every code a user has on paper is rejected
// with every test still green. A future format must therefore differ in length.
export const RECOVERY_FORMATS: Record<number, RecoveryFormat> = {
	[V1.payloadLength + V1.checksumLength]: V1,
};

export const CURRENT_RECOVERY_FORMAT = V1;

// Bounded before the string is scanned: this is fed straight from a paste into
// a text field, and the longest format the registry could ever hold is a few
// dozen symbols plus separators.
export const MAX_RECOVERY_INPUT_LENGTH = 256;

export type RecoveryCodeFailure = "malformed" | "length" | "checksum";

// The UI must tell "that is not a recovery code" from "you mistyped a
// character of one", and neither may reach the Argon2 derivation: a wrong code
// there costs ~0.5s and reports the indistinguishable "wrong recovery code".
export class RecoveryCodeError extends Error {
	constructor(
		readonly reason: RecoveryCodeFailure,
		detail: string,
	) {
		super(`recovery-code: recovery code is not valid (${detail})`);
		this.name = "RecoveryCodeError";
	}
}

// Crockford's decoding rule. The uppercase pass happens first, so a
// transcribed lowercase `l` arrives here as `L`.
const LOOK_ALIKES: Record<string, string> = { O: "0", I: "1", L: "1" };

// 25 bits of a SHA-256, packed MSB-first into 5 symbols. It is an error
// detector and NOT a security control: an attacker guessing codes computes a
// valid checksum for free, so it removes nothing from the 150-bit payload
// search. A cryptographic hash behaves as a random function, so any
// transcription error -- one symbol, a swapped pair, a dropped-then-reinserted
// group, anything -- survives with probability 2^-25, about 3e-8. That is a
// deliberate trade against a Damm or Luhn mod-32 check digit, which would
// GUARANTEE detection of single-symbol and adjacent-transposition errors but
// only give 1/32 against everything else; codes copied off paper in groups get
// whole groups reordered and dropped, which is exactly what the guaranteed
// classes miss.
async function checksumOf(
	payload: string,
	format: RecoveryFormat,
): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${format.domain}|${payload}`),
		),
	);
	let out = "";
	for (let i = 0; i < format.checksumLength; i++) {
		const offset = i * BITS_PER_SYMBOL;
		const byte = offset >> 3;
		const window =
			((digest[byte] as number) << 8) | ((digest[byte + 1] as number) ?? 0);
		const index = (window >> (11 - (offset & 7))) & 31;
		out += RECOVERY_ALPHABET[index] as string;
	}
	return out;
}

export function formatRecoveryCode(canonical: string): string {
	const format = RECOVERY_FORMATS[canonical.length];
	if (!format) throw new RecoveryCodeError("length", "length");
	const groups: string[] = [];
	for (let i = 0; i < canonical.length; i += RECOVERY_GROUP_SIZE) {
		groups.push(canonical.slice(i, i + RECOVERY_GROUP_SIZE));
	}
	return groups.join("-");
}

export async function generateRecoveryCode(): Promise<string> {
	const format = CURRENT_RECOVERY_FORMAT;
	// One byte per symbol and the low 5 bits of each: uniform over the alphabet
	// with no modulo bias, and far under getRandomValues' 65536-byte cap.
	const raw = crypto.getRandomValues(new Uint8Array(format.payloadLength));
	let payload = "";
	for (const b of raw) {
		payload += RECOVERY_ALPHABET[b & 31] as string;
	}
	return formatRecoveryCode(`${payload}${await checksumOf(payload, format)}`);
}

/**
 * Validates a hand-transcribed code and returns its canonical, separator-free
 * form -- the exact string to hand to `deriveKek`, so there is only ever one
 * form a KEK can be derived from.
 */
export async function normaliseRecoveryCode(input: string): Promise<string> {
	// Distinguishable from the format dispatch below on purpose: both are
	// "length", and sharing the detail string made a test asserting the cap
	// pass with the cap deleted, since an over-long input reaches the registry
	// and is rejected there anyway. What the cap adds is that it never gets
	// scanned -- this is fed straight from a paste.
	if (input.length > MAX_RECOVERY_INPUT_LENGTH) {
		throw new RecoveryCodeError("length", "too long");
	}
	let canonical = "";
	for (const char of input.toUpperCase()) {
		// Crockford ignores inserted hyphens, and a user reading off paper types
		// spaces and newlines just as readily.
		if (char === "-" || /\s/.test(char)) continue;
		const mapped = LOOK_ALIKES[char] ?? char;
		// Ahead of the length check on purpose: a separator this pass does not
		// strip -- an en dash pasted from a styled document -- would otherwise be
		// reported as a wrong-length code and send the user hunting for a missing
		// character that is not missing.
		if (!RECOVERY_ALPHABET.includes(mapped)) {
			// The code is the user's secret; naming the character in a message that
			// may be logged hands over a symbol of it for free.
			throw new RecoveryCodeError("malformed", "unrecognised character");
		}
		canonical += mapped;
	}
	const format = RECOVERY_FORMATS[canonical.length];
	if (!format) throw new RecoveryCodeError("length", "length");
	const payload = canonical.slice(0, format.payloadLength);
	if ((await checksumOf(payload, format)) !== canonical.slice(payload.length)) {
		throw new RecoveryCodeError("checksum", "checksum");
	}
	// NFC, which kdf.ts applies to every secret, is the identity on this string:
	// the alphabet is ASCII and everything else was rejected above. A code
	// pasted in fullwidth or with a look-alike from another script fails loudly
	// at entry, which is what this function is for.
	return canonical;
}
