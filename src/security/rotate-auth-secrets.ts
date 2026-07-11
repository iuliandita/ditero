import { Pool, type PoolClient } from "pg";
import { authFieldContext } from "../auth/encrypted-adapter.ts";
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
		if (!decrypted.needsRotation) continue;
		const plaintext = decrypted.plaintext;
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

const current = process.env.DITERO_ENCRYPTION_KEY;
const next = process.env.DITERO_ENCRYPTION_KEY_NEXT;
const databaseURL =
	process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!current || !next || !databaseURL) {
	throw new Error(
		"DATABASE_MIGRATION_URL, DITERO_ENCRYPTION_KEY, and DITERO_ENCRYPTION_KEY_NEXT are required",
	);
}

const ring = createFieldKeyRing({ current, next });
const pool = new Pool({ connectionString: databaseURL });
const client = await pool.connect();
try {
	await client.query("begin");
	let changed = 0;
	for (const [table, column, model, field] of columns) {
		changed += await rotateColumn(client, table, column, model, field, ring);
	}
	await client.query("commit");
	console.log(`rotated ${changed} encrypted auth fields`);
} catch (error) {
	await client.query("rollback");
	throw error;
} finally {
	client.release();
	await pool.end();
}
