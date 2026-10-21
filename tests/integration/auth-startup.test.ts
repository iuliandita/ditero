import { randomUUID } from "node:crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { exportJWK, generateKeyPair } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { authFieldContext } from "../../src/auth/encrypted-adapter.ts";
import { verifyStoredJwks } from "../../src/auth/startup.ts";
import {
	createFieldKeyRing,
	decryptField,
	encryptField,
} from "../../src/security/field-encryption.ts";
import { rotateAuthFields } from "../../src/security/rotate-auth-secrets.ts";

const schema = `auth_startup_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	options: `-c search_path=${schema},public`,
});
const current = "old-auth-secret-at-least-32-characters";
const next = "new-auth-secret-at-least-32-characters";
const ring = createFieldKeyRing({
	current: Buffer.alloc(32, 7).toString("base64"),
});

beforeAll(async () => {
	await admin.query(`create schema ${schema}`);
	await pool.query(
		"create table account (id text, access_token text, refresh_token text, id_token text); create table jwks (id text, private_key text); create table two_factor (id text, secret text, backup_codes text)",
	);
});
beforeEach(async () => {
	await pool.query("truncate account,jwks,two_factor");
	const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
	const inner = JSON.stringify(
		await symmetricEncrypt({
			key: current,
			data: JSON.stringify(await exportJWK(privateKey)),
		}),
	);
	await pool.query("insert into jwks values ('key', $1)", [
		encryptField(inner, authFieldContext("jwks", "privateKey"), ring),
	]);
	for (const [column, plaintext] of [
		["secret", "totp-fixture-secret"],
		["backup_codes", '["fixture-backup-code"]'],
	]) {
		const value = await symmetricEncrypt({ key: current, data: plaintext });
		const field = column === "secret" ? "secret" : "backupCodes";
		await pool.query(`insert into two_factor (id,${column}) values ($1,$2)`, [
			column,
			encryptField(value, authFieldContext("twoFactor", field), ring),
		]);
	}
	await pool.query(
		"insert into account values ('oauth','oauth-fixture-token',null,null)",
	);
});
afterAll(async () => {
	await pool.end();
	await admin.query(`drop schema ${schema} cascade`);
	await admin.end();
});

test("rejects a changed auth secret, then rotates retained JWKS and two-factor data idempotently", async () => {
	await expect(verifyStoredJwks(pool, current, ring)).resolves.toBeUndefined();
	await expect(verifyStoredJwks(pool, next, ring)).rejects.toThrow(
		"docs/runbooks/key-rotation.md and bun run security:rotate-auth-secrets",
	);
	const client = await pool.connect();
	try {
		expect(await rotateAuthFields(client, ring, { current, next })).toBe(4);
		expect(await rotateAuthFields(client, ring, { current, next })).toBe(0);
	} finally {
		client.release();
	}
	await expect(verifyStoredJwks(pool, next, ring)).resolves.toBeUndefined();
	await expect(verifyStoredJwks(pool, current, ring)).rejects.toThrow(
		"Stored JWKS",
	);
	const rows = (
		await pool.query<{ id: string; secret: string; backup_codes: string }>(
			"select * from two_factor",
		)
	).rows;
	for (const row of rows) {
		const field = row.id === "secret" ? "secret" : "backupCodes";
		const wrapped = row.id === "secret" ? row.secret : row.backup_codes;
		const value = decryptField(
			wrapped,
			authFieldContext("twoFactor", field),
			ring,
		).plaintext;
		expect(await symmetricDecrypt({ key: next, data: value })).toBe(
			row.id === "secret" ? "totp-fixture-secret" : '["fixture-backup-code"]',
		);
	}
});

test("a bad auth secret rolls back all earlier field updates", async () => {
	const before = (await pool.query("select * from account")).rows;
	const client = await pool.connect();
	try {
		await expect(
			rotateAuthFields(client, ring, { current: "wrong-auth-secret", next }),
		).rejects.toThrow("could not decrypt");
	} finally {
		client.release();
	}
	expect((await pool.query("select * from account")).rows).toEqual(before);
	await expect(verifyStoredJwks(pool, current, ring)).resolves.toBeUndefined();
});
