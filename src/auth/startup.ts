import { symmetricDecrypt } from "better-auth/crypto";
import { importJWK } from "jose";
import type { Pool } from "pg";
import {
	decryptField,
	type FieldKeyRing,
} from "../security/field-encryption.ts";
import { authFieldContext } from "./encrypted-adapter.ts";

export async function verifyStoredJwks(
	pool: Pick<Pool, "query">,
	secret: Parameters<typeof symmetricDecrypt>[0]["key"],
	ring?: FieldKeyRing,
): Promise<void> {
	const { rows } = await pool.query<{ private_key: string }>(
		"select private_key from jwks",
	);
	for (const row of rows) {
		try {
			const stored = row.private_key.startsWith("ditero:v1:")
				? decryptField(
						row.private_key,
						authFieldContext("jwks", "privateKey"),
						ringRequired(ring),
					).plaintext
				: row.private_key;
			const decrypted = await symmetricDecrypt({
				key: secret,
				data: JSON.parse(stored),
			});
			await importJWK(JSON.parse(decrypted), "EdDSA");
		} catch {
			// Neither ciphertext nor decrypted key material belongs in startup logs.
			throw new Error(
				"Stored JWKS private key cannot be decrypted with the current BETTER_AUTH_SECRET and DITERO_ENCRYPTION_KEY. Restore the original secrets or follow docs/runbooks/key-rotation.md and bun run security:rotate-auth-secrets before restarting.",
			);
		}
	}
}

function ringRequired(ring: FieldKeyRing | undefined): FieldKeyRing {
	if (!ring) throw new Error("Field encryption key is required");
	return ring;
}
