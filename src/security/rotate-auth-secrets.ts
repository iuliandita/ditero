import { Pool, type PoolClient } from "pg";
import { authFieldContext } from "../auth/encrypted-adapter.ts";
import {
	type AuthSecretRotation,
	rotateAuthSecretValue,
} from "./auth-secret-rotation.ts";
import {
	createFieldKeyRing,
	decryptField,
	encryptField,
} from "./field-encryption.ts";

const columns = [
	["account", "access_token", "account", "accessToken"],
	["account", "refresh_token", "account", "refreshToken"],
	["account", "id_token", "account", "idToken"],
	["jwks", "private_key", "jwks", "privateKey"],
	["two_factor", "secret", "twoFactor", "secret"],
	["two_factor", "backup_codes", "twoFactor", "backupCodes"],
] as const;

async function rotateColumn(
	client: PoolClient,
	table: string,
	column: string,
	model: string,
	field: string,
	ring: ReturnType<typeof createFieldKeyRing>,
	secrets?: AuthSecretRotation,
): Promise<number> {
	const result = await client.query<{ id: string; value: string }>(
		`select id, ${column} as value from ${table} where ${column} is not null`,
	);
	let changed = 0;
	for (const row of result.rows) {
		const context = authFieldContext(model, field);
		const decrypted = row.value.startsWith("ditero:v1:")
			? decryptField(row.value, context, ring)
			: { plaintext: row.value, needsRotation: true };
		const plaintext = secrets
			? await rotateAuthSecretValue(decrypted.plaintext, model, secrets)
			: decrypted.plaintext;
		if (!decrypted.needsRotation && plaintext === decrypted.plaintext) continue;
		const ciphertext = encryptField(plaintext, context, ring);
		if (ciphertext !== row.value) {
			await client.query(`update ${table} set ${column} = $1 where id = $2`, [
				ciphertext,
				row.id,
			]);
			changed += 1;
		}
	}
	return changed;
}

export async function rotateAuthFields(
	client: PoolClient,
	ring: ReturnType<typeof createFieldKeyRing>,
	secrets?: AuthSecretRotation,
): Promise<number> {
	try {
		await client.query("begin");
		let changed = 0;
		for (const [table, column, model, field] of columns) {
			changed += await rotateColumn(
				client,
				table,
				column,
				model,
				field,
				ring,
				secrets,
			);
		}
		await client.query("commit");
		return changed;
	} catch (error) {
		await client.query("rollback");
		throw error;
	}
}

if (import.meta.main) {
	const current = process.env.DITERO_ENCRYPTION_KEY;
	const next = process.env.DITERO_ENCRYPTION_KEY_NEXT;
	const authNext = process.env.BETTER_AUTH_SECRET_NEXT;
	const authCurrent = process.env.BETTER_AUTH_SECRET;
	const databaseURL =
		process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
	if (!current || (!next && !authNext) || !databaseURL) {
		throw new Error(
			"DATABASE_MIGRATION_URL, DITERO_ENCRYPTION_KEY, and either DITERO_ENCRYPTION_KEY_NEXT or BETTER_AUTH_SECRET_NEXT are required",
		);
	}
	if (authNext !== undefined && (!authCurrent || authNext.length < 32)) {
		throw new Error(
			"Auth secret rotation requires the original BETTER_AUTH_SECRET and a BETTER_AUTH_SECRET_NEXT of at least 32 characters",
		);
	}
	const ring = createFieldKeyRing({ current, next });
	const pool = new Pool({ connectionString: databaseURL });
	pool.on("error", () =>
		console.error("auth rotation: database connection lost"),
	);
	const client = await pool.connect();
	client.on("error", () =>
		console.error("auth rotation: database connection lost"),
	);
	try {
		const changed = await rotateAuthFields(
			client,
			ring,
			authNext && authCurrent
				? { current: authCurrent, next: authNext }
				: undefined,
		);
		console.log(`rotated ${changed} encrypted auth fields`);
	} finally {
		client.release();
		await pool.end();
	}
}
