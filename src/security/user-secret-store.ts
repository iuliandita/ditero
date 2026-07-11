import type { PoolClient } from "pg";
import type { FieldKeyRing } from "./field-encryption.ts";
import { decryptField, encryptField } from "./field-encryption.ts";

function context(userId: string, kind: string): string {
	return `user-secret:${userId}:${kind}`;
}

export async function putUserSecret(
	client: PoolClient,
	input: { id: string; userId: string; kind: string; plaintext: string },
	ring: FieldKeyRing,
): Promise<void> {
	const ciphertext = encryptField(
		input.plaintext,
		context(input.userId, input.kind),
		ring,
	);
	const keyFingerprint = ciphertext.split(":")[2];
	await client.query(
		`insert into user_secret
			(id, user_id, kind, ciphertext, key_fingerprint)
		 values ($1, $2, $3, $4, $5)
		 on conflict (user_id, kind) do update
		 set ciphertext = excluded.ciphertext,
		     key_fingerprint = excluded.key_fingerprint,
		     updated_at = now()`,
		[input.id, input.userId, input.kind, ciphertext, keyFingerprint],
	);
}

export async function getUserSecret(
	client: PoolClient,
	userId: string,
	kind: string,
	ring: FieldKeyRing,
): Promise<string | null> {
	const result = await client.query<{
		id: string;
		ciphertext: string;
	}>(
		"select id, ciphertext from user_secret where user_id = $1 and kind = $2",
		[userId, kind],
	);
	const row = result.rows[0];
	if (!row) return null;
	const decrypted = decryptField(row.ciphertext, context(userId, kind), ring);
	if (decrypted.needsRotation) {
		const ciphertext = encryptField(
			decrypted.plaintext,
			context(userId, kind),
			ring,
		);
		await client.query(
			`update user_secret
			 set ciphertext = $1, key_fingerprint = $2, updated_at = now()
			 where id = $3`,
			[ciphertext, ciphertext.split(":")[2], row.id],
		);
	}
	return decrypted.plaintext;
}
