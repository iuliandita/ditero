import { argon2id } from "hash-wasm";

// Every wrapped private key is openable only by re-deriving with the exact
// parameters that produced it, and the wrap records its version rather than the
// parameters. Raising cost is therefore ADDITIVE: add a version, never edit one.
export const KDF_PARAMS = {
	1: { memorySizeKiB: 65536, iterations: 3, parallelism: 1, hashLength: 32 },
} as const;

export const CURRENT_KDF_VERSION = 1;

export type KdfVersion = keyof typeof KDF_PARAMS;

export const SALT_BYTES = 16;

// WASM copies the password into a working set already sized at 64 MiB, and the
// mobile WebView is the tightest caller.
export const MAX_SECRET_LENGTH = 1024;

export type KekPurpose = "passphrase" | "recovery";

const PURPOSES: readonly KekPurpose[] = ["passphrase", "recovery"];

export function generateSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

// The two wraps of the private key must be independent: knowing the passphrase
// KEK must say nothing about the recovery KEK even when a user reuses the same
// string for both. Domain separation in the secret, plus independent salts at
// the call site, gives that.
export async function deriveKek(
	secret: string,
	salt: Uint8Array,
	purpose: KekPurpose,
	version: KdfVersion = CURRENT_KDF_VERSION,
): Promise<Uint8Array> {
	if (!secret) throw new Error("kdf: E2E secret must not be empty");
	if (secret.length > MAX_SECRET_LENGTH) {
		throw new Error(
			`kdf: E2E secret must be at most ${MAX_SECRET_LENGTH} characters`,
		);
	}
	if (salt.length !== SALT_BYTES) {
		throw new Error(`kdf: E2E salt must be ${SALT_BYTES} bytes`);
	}
	// The separator is only unambiguous while no purpose can contain ":", which
	// the type system stops asserting the moment a caller casts.
	if (!PURPOSES.includes(purpose)) {
		throw new Error(`kdf: unknown purpose "${purpose}"`);
	}
	const params = KDF_PARAMS[version];
	// NFC and not NFKC: compatibility folding would collapse distinct passphrases
	// (full-width vs half-width) and cost entropy. Without ANY normalisation the
	// same visible passphrase typed on macOS and on Android derives a different
	// KEK, which is indistinguishable from a wrong passphrase and, with the
	// recovery code also lost, is permanent key loss.
	// "v1" labels the wire format, not `version`, which selects parameters only.
	const separated = `ditero:kek:v1:${purpose}:${secret.normalize("NFC")}`;
	return await argon2id({
		password: separated,
		salt,
		memorySize: params.memorySizeKiB,
		iterations: params.iterations,
		parallelism: params.parallelism,
		hashLength: params.hashLength,
		outputType: "binary",
	});
}
