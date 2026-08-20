import { argon2id } from "hash-wasm";

export const ARGON2_PARAMS = {
	memorySizeKiB: 65536,
	iterations: 3,
	parallelism: 1,
	hashLength: 32,
} as const;

export const SALT_BYTES = 16;

export type KekPurpose = "passphrase" | "recovery";

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
): Promise<Uint8Array> {
	if (!secret) throw new Error("E2E secret must not be empty");
	if (salt.length !== SALT_BYTES) throw new Error("E2E salt must be 16 bytes");
	const separated = `ditero:kek:v1:${purpose}:${secret}`;
	return await argon2id({
		password: separated,
		salt,
		memorySize: ARGON2_PARAMS.memorySizeKiB,
		iterations: ARGON2_PARAMS.iterations,
		parallelism: ARGON2_PARAMS.parallelism,
		hashLength: ARGON2_PARAMS.hashLength,
		outputType: "binary",
	});
}
