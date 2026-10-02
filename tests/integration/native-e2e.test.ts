import { randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import * as schema from "../../src/db/schema.ts";
import { e2eRoutes } from "../../src/server/e2e/routes.ts";
import { makeGuards } from "../../src/server/guards.ts";
import {
	type Sessions,
	s256Challenge,
} from "../../src/server/native-auth/contracts.ts";
import { nativeE2ERoutes } from "../../src/server/native-auth/e2e-routes.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const role = `native_e2e_${suffix}`;
const password = randomBytes(32).toString("hex");
const roleURL = new URL(databaseURL);
roleURL.username = role;
roleURL.password = password;
const restricted = new Pool({ connectionString: roleURL.toString(), max: 6 });
const users: string[] = [];
const grants: string[] = [];
const verifier = "c".repeat(43);
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
	.origin;
let roleCreated = false;
let sessions: Sessions;
let store: NativeGrantStore;
let routes: ReturnType<typeof nativeE2ERoutes>;
let browserRoutes: ReturnType<typeof e2eRoutes>;
let allowRequests = true;
const previousE2E = process.env.DITERO_E2E_ENABLED;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on "user", session, user_device, native_auth_grant, native_session_link, workspace, membership, workspace_access_scope, user_key, user_key_secret to "${role}"`,
	);
	const privilege = await restricted.query<{
		rolsuper: boolean;
		rolbypassrls: boolean;
	}>(
		"select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
	);
	expect(privilege.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
	const adapter = (await auth.$context).internalAdapter;
	sessions = {
		createSession: (userId) => adapter.createSession(userId, false),
		deleteSession: (token) => adapter.deleteSession(token),
	};
	store = new NativeGrantStore(restricted, sessions);
	const database = drizzle(restricted, { schema });
	routes = nativeE2ERoutes({
		pool: restricted,
		database,
		rateLimit: async () => allowRequests,
	});
	browserRoutes = e2eRoutes(
		restricted,
		database,
		makeGuards([origin], (headers) => auth.api.getSession({ headers })),
		"/api/e2e",
	);
	process.env.DITERO_E2E_ENABLED = "true";
});

afterAll(async () => {
	if (previousE2E === undefined) delete process.env.DITERO_E2E_ENABLED;
	else process.env.DITERO_E2E_ENABLED = previousE2E;
	const errors: unknown[] = [];
	for (const cleanup of [
		async () => {
			// Links, sessions and devices go before the user; the projection row
			// follows its membership, which goes before its workspace.
			await admin.query(
				"delete from native_session_link where user_id = any($1::text[])",
				[users],
			);
			await admin.query("delete from session where user_id = any($1::text[])", [
				users,
			]);
			await admin.query(
				"delete from user_device where user_id = any($1::text[])",
				[users],
			);
			await admin.query(
				"delete from membership where user_id = any($1::text[]) or workspace_id in (select id from workspace where owner_id = any($1::text[]))",
				[users],
			);
			await admin.query(
				"delete from workspace where owner_id = any($1::text[])",
				[users],
			);
			await admin.query(
				"delete from native_auth_grant where id = any($1::text[])",
				[grants],
			);
			await admin.query('delete from "user" where id = any($1::text[])', [
				users,
			]);
		},
		async () => {
			await restricted.end();
		},
		async () => {
			if (roleCreated) {
				await admin.query(`drop owned by "${role}"`);
				await admin.query(`drop role "${role}"`);
			}
		},
		async () => {
			await admin.end();
		},
	]) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "Native encryption cleanup failed");
});

// A real user, browser session, and native session minted through the actual
// grant flow, so authentication is never faked.
async function actor(label: string) {
	const id = `native-e2e-${randomUUID()}`;
	users.push(id);
	const name = `${label} ${suffix}`;
	const email = `${id}@example.test`;
	await admin.query(
		'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
		[id, name, email],
	);
	const browser = await sessions.createSession(id);
	const grant = await store.create(
		s256Challenge(verifier),
		"Encryption test device",
	);
	grants.push(grant.grantId);
	expect(await store.approve(grant.grantId, id, browser.id)).toBe("approved");
	const native = await store.exchange(grant.grantId, verifier);
	if (native.kind !== "ok") throw new Error(`Exchange failed: ${native.kind}`);
	return {
		id,
		name,
		email,
		browser,
		token: native.token,
		sessionId: native.sessionId,
		deviceId: native.deviceId,
	};
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function material() {
	return {
		publicKey: randomBytes(32).toString("base64url"),
		passphraseWrapped: `passphrase-${randomUUID()}`,
		recoveryWrapped: `recovery-${randomUUID()}`,
		passphraseSalt: `passphrase-salt-${randomUUID()}`,
		recoverySalt: `recovery-salt-${randomUUID()}`,
		formatVersion: 1,
	};
}

function identity(headers: Record<string, string>, query = "") {
	return routes.handle(
		new Request(`${origin}/api/native/e2e/identity${query}`, { headers }),
	);
}

function enroll(
	headers: Record<string, string>,
	body = JSON.stringify(material()),
) {
	return routes.handle(
		new Request(`${origin}/api/native/e2e/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body,
		}),
	);
}

function expectPrivate(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	return response;
}

async function keyCounts(userId: string) {
	const result = await admin.query<{ identities: number; secrets: number }>(
		`select (select count(*)::int from user_key where user_id = $1) as identities,
		(select count(*)::int from user_key_secret where user_id = $1) as secrets`,
		[userId],
	);
	return result.rows[0];
}

test("native enrollment and identity are owner-only and reject browser credentials", async () => {
	const alice = await actor("Alice");
	const bob = await actor("Bob");
	const aliceKey = material();
	const bobKey = material();
	for (const [owner, key] of [
		[alice, aliceKey],
		[bob, bobKey],
	] as const) {
		const response = expectPrivate(
			await enroll(bearer(owner.token), JSON.stringify(key)),
			200,
		);
		expect(await response.json()).toEqual({
			publicKey: key.publicKey,
			state: "ready",
		});
		expect(await keyCounts(owner.id)).toEqual({ identities: 1, secrets: 1 });
	}
	const response = expectPrivate(
		await identity(bearer(alice.token), `?userId=${bob.id}`),
		200,
	);
	const text = await response.text();
	expect(JSON.parse(text)).toEqual({
		enrolled: true,
		publicKey: aliceKey.publicKey,
		formatVersion: aliceKey.formatVersion,
		passphraseWrapped: aliceKey.passphraseWrapped,
		passphraseSalt: aliceKey.passphraseSalt,
	});
	for (const secret of [
		aliceKey.recoveryWrapped,
		aliceKey.recoverySalt,
		bobKey.publicKey,
		bobKey.passphraseWrapped,
		alice.token,
	])
		expect(text).not.toContain(secret);
	const bobIdentity = expectPrivate(await identity(bearer(bob.token)), 200);
	expect((await bobIdentity.json()).passphraseWrapped).toBe(
		bobKey.passphraseWrapped,
	);

	const orphan = await sessions.createSession(alice.id);
	for (const token of [alice.browser.token, orphan.token, "not-a-session"]) {
		expectPrivate(await identity(bearer(token)), 401);
		expectPrivate(await enroll(bearer(token)), 401);
	}
	// Presence, even with an empty value, is forbidden; no precedence rule can
	// silently select the bearer over a cookie or same-origin browser request.
	const forbiddenHeaders: Record<string, string>[] = [
		{ cookie: "" },
		{ cookie: "irrelevant=1" },
		{ origin: "" },
		{ origin },
	];
	for (const extra of forbiddenHeaders) {
		expectPrivate(await identity({ ...bearer(alice.token), ...extra }), 400);
		expectPrivate(await enroll({ ...bearer(alice.token), ...extra }), 400);
	}
	// Admission must precede JSON parsing, including malformed unauthenticated bodies.
	expectPrivate(await enroll({}, "{"), 401);
	expectPrivate(await enroll({ cookie: "" }, "{"), 400);
	expect(await keyCounts(alice.id)).toEqual({ identities: 1, secrets: 1 });
});

test("native bearer cannot enter browser encryption routes, with a real browser-cookie control", async () => {
	const owner = await actor("Browser control");
	const key = material();
	expectPrivate(await enroll(bearer(owner.token), JSON.stringify(key)), 200);
	const context = await auth.$context;
	const signed = `${owner.browser.token}.${await makeSignature(owner.browser.token, context.secret)}`;
	const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
	const browser = await browserRoutes.handle(
		new Request(`${origin}/api/e2e/identity`, { headers: { cookie } }),
	);
	expect(browser.status).toBe(200);
	expect((await browser.json()).passphraseWrapped).toBe(key.passphraseWrapped);
	for (const path of ["identity", "enroll"]) {
		const isWrite = path === "enroll";
		const response = await browserRoutes.handle(
			new Request(`${origin}/api/e2e/${path}`, {
				method: isWrite ? "POST" : "GET",
				headers: {
					...bearer(owner.token),
					...(isWrite ? { origin, "content-type": "application/json" } : {}),
				},
				...(isWrite ? { body: JSON.stringify(key) } : {}),
			}),
		);
		expect(response.status).toBe(401);
	}
	expectPrivate(await identity(bearer(owner.browser.token)), 401);
	expectPrivate(
		await enroll(bearer(owner.browser.token), JSON.stringify(key)),
		401,
	);
	expect(await keyCounts(owner.id)).toEqual({ identities: 1, secrets: 1 });
});

test("revoked devices, expired sessions, and deleted users cannot read or enroll keys", async () => {
	const revoke = await actor("Revoked");
	const expire = await actor("Expired");
	const deleted = await actor("Deleted");
	// Each live credential first proves it can enroll and read; separate actors
	// ensure a prior invalidation cannot make a later condition unreachable.
	for (const owner of [revoke, expire, deleted]) {
		expectPrivate(await enroll(bearer(owner.token)), 200);
		expectPrivate(await identity(bearer(owner.token)), 200);
	}
	await admin.query("update user_device set revoked_at = now() where id = $1", [
		revoke.deviceId,
	]);
	await admin.query(
		"update session set expires_at = now() - interval '1 second' where id = $1",
		[expire.sessionId],
	);
	await admin.query('update "user" set deleted_at = now() where id = $1', [
		deleted.id,
	]);
	for (const owner of [revoke, expire, deleted]) {
		const before = await keyCounts(owner.id);
		expectPrivate(await identity(bearer(owner.token)), 401);
		expectPrivate(await enroll(bearer(owner.token)), 401);
		expect(await keyCounts(owner.id)).toEqual(before);
	}
});

test("rate refusal has no key effects and disabled encryption returns 404", async () => {
	const owner = await actor("Rate control");
	const before = await keyCounts(owner.id);
	try {
		allowRequests = false;
		const refusal = expectPrivate(await enroll(bearer(owner.token)), 429);
		expect(refusal.headers.get("retry-after")).toBe("5");
		expectPrivate(await identity(bearer(owner.token)), 429);
		expectPrivate(await enroll({}, "{"), 429);
		expect(await keyCounts(owner.id)).toEqual(before);
		allowRequests = true;
		expectPrivate(await enroll(bearer(owner.token)), 200);
		const enrolled = await keyCounts(owner.id);
		process.env.DITERO_E2E_ENABLED = "false";
		expectPrivate(await identity(bearer(owner.token)), 404);
		expectPrivate(await enroll(bearer(owner.token)), 404);
		expect(await keyCounts(owner.id)).toEqual(enrolled);
	} finally {
		allowRequests = true;
		process.env.DITERO_E2E_ENABLED = "true";
	}
});
