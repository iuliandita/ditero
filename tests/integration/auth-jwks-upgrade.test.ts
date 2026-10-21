import { randomBytes, randomUUID } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricEncrypt } from "better-auth/crypto";
import { jwt } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	jwtVerify,
	SignJWT,
} from "jose";
import { Pool } from "pg";
import { afterAll, expect, test } from "vitest";
import {
	authFieldContext,
	withFieldEncryption,
} from "../../src/auth/encrypted-adapter.ts";
import { verifyStoredJwks } from "../../src/auth/startup.ts";
import * as schema from "../../src/db/auth-schema.ts";
import {
	createFieldKeyRing,
	encryptField,
} from "../../src/security/field-encryption.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const database = `jwks_upgrade_${suffix}`;
const ownerRole = `jwks_owner_${suffix}`;
const runtimeRole = `jwks_runtime_${suffix}`;
const password = randomBytes(32).toString("hex");
const pools: Pool[] = [];
const roles: string[] = [];
let databaseCreated = false;

afterAll(async () => {
	await Promise.all(pools.map((pool) => pool.end()));
	try {
		if (databaseCreated) await admin.query(`drop database "${database}"`);
		for (const role of roles) await admin.query(`drop role "${role}"`);
	} finally {
		await admin.end();
	}
});

test("JWT migration preserves encrypted legacy keys and runtime-role signing and rotation", async () => {
	for (const role of [ownerRole, runtimeRole]) {
		await admin.query(
			`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
		);
		roles.push(role);
	}
	await admin.query(`create database "${database}" owner "${ownerRole}"`);
	databaseCreated = true;
	const templateURL = new URL(databaseURL);
	function connect(role: string) {
		const url = new URL(templateURL);
		url.pathname = `/${database}`;
		url.username = role;
		url.password = password;
		const pool = new Pool({ connectionString: url.toString(), max: 1 });
		pools.push(pool);
		return pool;
	}
	const owner = connect(ownerRole);
	const runtime = connect(runtimeRole);
	const config = {
		migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
	};
	const journal = JSON.parse(
		readFileSync(`${config.migrationsFolder}/meta/_journal.json`, "utf8"),
	) as { entries: { tag: string }[] };
	const upgradeIndex = journal.entries.findIndex((entry) =>
		entry.tag.endsWith("_better_auth_jwks"),
	);
	expect(upgradeIndex).toBeGreaterThan(0);
	const ownerDB = drizzle(owner);
	const baseline = mkdtempSync(join(tmpdir(), "ditero-jwks-upgrade-"));
	try {
		mkdirSync(join(baseline, "meta"));
		const entries = journal.entries.slice(0, upgradeIndex);
		writeFileSync(
			join(baseline, "meta/_journal.json"),
			JSON.stringify({ ...journal, entries }),
		);
		for (const entry of entries)
			copyFileSync(
				join(config.migrationsFolder, `${entry.tag}.sql`),
				join(baseline, `${entry.tag}.sql`),
			);
		await migrate(ownerDB, { migrationsFolder: baseline });
	} finally {
		rmSync(baseline, { recursive: true, force: true });
	}
	await owner.query(`grant usage on schema public to "${runtimeRole}"`);
	await owner.query(
		`grant select, insert, update, delete on all tables in schema public to "${runtimeRole}"`,
	);
	expect(
		(
			await runtime.query(
				"select rolsuper, rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	const secret = "jwt-upgrade-regression-secret-at-least-32-characters";
	const ring = createFieldKeyRing({
		current: Buffer.alloc(32, 7).toString("base64"),
	});
	const pair = await generateKeyPair("EdDSA", {
		crv: "Ed25519",
		extractable: true,
	});
	const legacyId = randomUUID();
	const publicKey = JSON.stringify(await exportJWK(pair.publicKey));
	// The 1.6 key format has Better Auth encryption inside Ditero's field envelope.
	const privateKey = encryptField(
		JSON.stringify(
			await symmetricEncrypt({
				key: secret,
				data: JSON.stringify(await exportJWK(pair.privateKey)),
			}),
		),
		authFieldContext("jwks", "privateKey"),
		ring,
	);
	await runtime.query(
		"insert into jwks (id, public_key, private_key, created_at) values ($1,$2,$3,now())",
		[legacyId, publicKey, privateKey],
	);
	const legacyToken = await new SignJWT({ sub: "existing-user" })
		.setProtectedHeader({ alg: "EdDSA", kid: legacyId })
		.setExpirationTime("5m")
		.sign(pair.privateKey);
	await verifyStoredJwks(runtime, secret, ring);
	await migrate(ownerDB, config);
	expect(
		(await runtime.query("select * from jwks where id=$1", [legacyId])).rows,
	).toMatchObject([
		{
			id: legacyId,
			public_key: publicKey,
			private_key: privateKey,
			alg: null,
			crv: null,
		},
	]);
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret,
		database: withFieldEncryption(
			drizzleAdapter(drizzle(runtime, { schema }), { provider: "pg" }),
			ring,
		),
		plugins: [jwt()],
	});
	const first = await auth.api.signJWT({
		body: { payload: { sub: "existing-user" } },
	});
	const oldKeys = createLocalJWKSet(await auth.api.getJwks());
	expect((await jwtVerify(legacyToken, oldKeys)).payload.sub).toBe(
		"existing-user",
	);
	expect((await jwtVerify(first.token, oldKeys)).protectedHeader.kid).toBe(
		legacyId,
	);
	await runtime.query(
		"update jwks set expires_at=now()-interval '1 second' where id=$1",
		[legacyId],
	);
	const rotated = await auth.api.signJWT({
		body: { payload: { sub: "existing-user" } },
	});
	const newKeys = createLocalJWKSet(await auth.api.getJwks());
	const verified = await jwtVerify(rotated.token, newKeys);
	expect(verified.protectedHeader.kid).not.toBe(legacyId);
	expect((await jwtVerify(legacyToken, newKeys)).payload.sub).toBe(
		"existing-user",
	);
	expect(
		(
			await runtime.query(
				"select alg, crv, private_key from jwks where id=$1",
				[verified.protectedHeader.kid],
			)
		).rows,
	).toEqual([
		{
			alg: "EdDSA",
			crv: "Ed25519",
			private_key: expect.stringMatching(/^ditero:v1:/),
		},
	]);
	await verifyStoredJwks(runtime, secret, ring);
	expect(
		(
			await runtime.query("delete from jwks where id=$1 returning id", [
				verified.protectedHeader.kid,
			])
		).rowCount,
	).toBe(1);
}, 60_000);
