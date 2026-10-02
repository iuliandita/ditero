import { randomBytes, randomUUID } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { makeGuards } from "../../src/server/guards.ts";
import {
	type SessionHandle,
	type Sessions,
	s256Challenge,
} from "../../src/server/native-auth/contracts.ts";
import { nativeAuthRoutes } from "../../src/server/native-auth/routes.ts";
import {
	authenticateNative,
	lookupNativeSession,
} from "../../src/server/native-auth/session.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import { nativeZeroPayload } from "../../src/server/zero-auth.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const role = `native_test_${suffix}`;
const password = randomBytes(32).toString("hex");
const roleURL = new URL(databaseURL);
roleURL.username = role;
roleURL.password = password;
const restricted = new Pool({ connectionString: roleURL.toString(), max: 6 });
const users: string[] = [];
const grants: string[] = [];
const verifier = "a".repeat(43);
const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000")
	.origin;
let roleCreated = false;
let sessions: Sessions;
let store: NativeGrantStore;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on "user", session, user_device, native_auth_grant, native_session_link to "${role}"`,
	);
	const privilege = await restricted.query<{
		rolsuper: boolean;
		rolbypassrls: boolean;
	}>(
		"select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
	);
	expect(privilege.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
	const rls = await restricted.query<{
		relrowsecurity: boolean;
		relforcerowsecurity: boolean;
	}>(
		"select relrowsecurity, relforcerowsecurity from pg_class where oid = 'user_device'::regclass",
	);
	expect(rls.rows[0]).toEqual({
		relrowsecurity: true,
		relforcerowsecurity: true,
	});
	const adapter = (await auth.$context).internalAdapter;
	sessions = {
		createSession: (userId) => adapter.createSession(userId, false),
		deleteSession: (token) => adapter.deleteSession(token),
	};
	store = new NativeGrantStore(restricted, sessions);
});

afterAll(async () => {
	const errors: unknown[] = [];
	for (const cleanup of [
		async () => {
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
		throw new AggregateError(errors, "Native auth test cleanup failed");
});

async function person() {
	const id = `native-${randomUUID()}`;
	users.push(id);
	await admin.query(
		'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
		[id, "Native Tester", `${id}@example.test`],
	);
	const browser = await sessions.createSession(id);
	return { id, browser };
}
async function pending(target = store) {
	const grant = await target.create(s256Challenge(verifier), "Test device");
	grants.push(grant.grantId);
	return grant.grantId;
}
async function approved(target = store) {
	const owner = await person();
	const grantId = await pending(target);
	expect(await target.approve(grantId, owner.id, owner.browser.id)).toBe(
		"approved",
	);
	return { ...owner, grantId };
}
async function successful(grantId: string, target = store) {
	const result = await target.exchange(grantId, verifier);
	if (result.kind !== "ok") throw new Error(`Exchange failed: ${result.kind}`);
	return result;
}

test("concurrent exchanges create exactly one independent native session and refuse replay", async () => {
	const fixture = await approved();
	const results = await Promise.all([
		store.exchange(fixture.grantId, verifier),
		store.exchange(fixture.grantId, verifier),
	]);
	expect(results.filter((row) => row.kind === "ok")).toHaveLength(1);
	expect(
		results.filter((row) => row.kind !== "ok").map((row) => row.kind),
	).toEqual([expect.stringMatching(/^(busy|invalid)$/)]);
	const created = results.find((row) => row.kind === "ok");
	if (created?.kind !== "ok") throw new Error("Missing winner");
	expect(created.sessionId).not.toBe(fixture.browser.id);
	expect(created.token).not.toBe(fixture.browser.token);
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
	const links = await admin.query(
		"select session_id from native_session_link where user_id = $1",
		[fixture.id],
	);
	expect(links.rows).toEqual([{ session_id: created.sessionId }]);
	const persisted = await admin.query(
		"select id from session where user_id = $1 order by id",
		[fixture.id],
	);
	expect(persisted.rows.map((row) => row.id).sort()).toEqual(
		[fixture.browser.id, created.sessionId].sort(),
	);
});

test("held grant contention returns busy for exchange and an approval burst and pruning skips locked expired grants", async () => {
	const fixture = await approved();
	const expiredGrantId = await pending();
	await admin.query(
		"update native_auth_grant set expires_at = now() - interval '1 second' where id = $1",
		[expiredGrantId],
	);
	const holder = await admin.connect();
	let calls: Promise<unknown>[] = [];
	try {
		await holder.query("begin");
		await holder.query(
			"select id from native_auth_grant where id = any($1::text[]) for update",
			[[fixture.grantId, expiredGrantId]],
		);
		calls = [
			...Array.from({ length: 8 }, () =>
				store.approve(fixture.grantId, fixture.id, fixture.browser.id),
			),
			store.exchange(fixture.grantId, verifier),
			store.prune(),
		];
		const deadline = AbortSignal.timeout(1000);
		const timeout = new Promise<never>((_, reject) => {
			deadline.addEventListener(
				"abort",
				() =>
					reject(
						new Error("Contended native grant operations waited for a lock"),
					),
				{ once: true },
			);
		});
		const results = await Promise.race([Promise.all(calls), timeout]);
		expect(results.slice(0, 8)).toEqual(Array(8).fill("busy"));
		expect(results[8]).toEqual({ kind: "busy" });
		expect(
			(
				await admin.query("select id from native_auth_grant where id = $1", [
					expiredGrantId,
				])
			).rows,
		).toEqual([{ id: expiredGrantId }]);
	} finally {
		try {
			await holder.query("rollback");
		} finally {
			holder.release();
		}
		// Settle all callers after releasing the lock even when the deadline fails.
		await Promise.allSettled(calls);
	}
	await store.prune();
	expect(
		(
			await admin.query("select id from native_auth_grant where id = $1", [
				expiredGrantId,
			])
		).rows,
	).toEqual([]);
	expect((await successful(fixture.grantId)).userId).toBe(fixture.id);
	expect((await restricted.query("select current_user as role")).rows).toEqual([
		{ role },
	]);
}, 2000);

test("a wrong verifier does not consume an otherwise usable grant", async () => {
	const fixture = await approved();
	expect(await store.exchange(fixture.grantId, "b".repeat(43))).toEqual({
		kind: "invalid",
	});
	expect((await successful(fixture.grantId)).userId).toBe(fixture.id);
});

test("unapproved and expired grants never create a session", async () => {
	const grantId = await pending();
	expect(await store.exchange(grantId, verifier)).toEqual({ kind: "pending" });
	await admin.query(
		"update native_auth_grant set expires_at = now() - interval '1 second' where id = $1",
		[grantId],
	);
	expect(await store.exchange(grantId, verifier)).toEqual({ kind: "invalid" });
	const fixture = await approved();
	await admin.query(
		"update native_auth_grant set expires_at = now() - interval '1 second' where id = $1",
		[fixture.grantId],
	);
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
	expect(
		(
			await admin.query("select id from session where user_id = $1", [
				fixture.id,
			])
		).rows,
	).toEqual([{ id: fixture.browser.id }]);
});

test.each([
	"revoked",
	"expired",
	"deleted-user",
] as const)("rejects approval whose authority became %s", async (change) => {
	const fixture = await approved();
	if (change === "revoked") await sessions.deleteSession(fixture.browser.token);
	else if (change === "expired")
		await admin.query(
			"update session set expires_at = now() - interval '1 second' where id = $1",
			[fixture.browser.id],
		);
	else
		await admin.query('update "user" set deleted_at = now() where id = $1', [
			fixture.id,
		]);
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
	expect(
		(
			await admin.query(
				"select session_id from native_session_link where user_id = $1",
				[fixture.id],
			)
		).rows,
	).toEqual([]);
});

test("failed session creation burns the claimed grant", async () => {
	const failing = new NativeGrantStore(restricted, {
		...sessions,
		createSession: async () => {
			throw new Error("create refused");
		},
	});
	const fixture = await approved(failing);
	await expect(failing.exchange(fixture.grantId, verifier)).rejects.toThrow(
		"create refused",
	);
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
});

test.each([
	false,
	true,
])("post-creation SQL failure compensates, or refuses an orphan when cleanup fails=%s", async (cleanupFails) => {
	let created: SessionHandle | undefined;
	const failing = new NativeGrantStore(restricted, {
		createSession: async (userId) => {
			created = await sessions.createSession(userId);
			return created;
		},
		deleteSession: async (token) => {
			if (cleanupFails) throw new Error("cleanup refused");
			await sessions.deleteSession(token);
		},
	});
	const fixture = await approved(failing);
	await admin.query(`revoke insert on native_session_link from "${role}"`);
	try {
		if (cleanupFails)
			await expect(
				failing.exchange(fixture.grantId, verifier),
			).rejects.toMatchObject({ cleanupFailed: true });
		else
			await expect(failing.exchange(fixture.grantId, verifier)).rejects.toThrow(
				/permission denied/,
			);
		if (!created) throw new Error("Real adapter did not create a session");
		expect(await lookupNativeSession(restricted, created.token)).toBeNull();
		const persisted = await admin.query(
			"select id from session where id = $1",
			[created.id],
		);
		expect(persisted.rows).toEqual(cleanupFails ? [{ id: created.id }] : []);
		expect(
			(
				await admin.query(
					"select consumed_at from native_auth_grant where id = $1",
					[fixture.grantId],
				)
			).rows[0].consumed_at,
		).not.toBeNull();
		expect(
			(
				await admin.query("select id from user_device where user_id = $1", [
					fixture.id,
				])
			).rows,
		).toEqual([]);
	} finally {
		await admin.query(`grant insert on native_session_link to "${role}"`);
		if (created) await sessions.deleteSession(created.token);
	}
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
});

test("expiration during real session creation compensates and leaves the claim consumed", async () => {
	let created: SessionHandle | undefined;
	const delayed = new NativeGrantStore(restricted, {
		createSession: async (userId) => {
			await admin.query("select pg_sleep(1.1)");
			created = await sessions.createSession(userId);
			return created;
		},
		deleteSession: (token) => sessions.deleteSession(token),
	});
	const fixture = await approved(delayed);
	await admin.query(
		"update native_auth_grant set expires_at = statement_timestamp() + interval '1 second' where id = $1",
		[fixture.grantId],
	);
	expect(await delayed.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
	if (!created)
		throw new Error("Expiration case did not reach actual session creation");
	expect(
		(await admin.query("select id from session where id = $1", [created.id]))
			.rows,
	).toEqual([]);
	expect(
		(
			await admin.query(
				"select consumed_at from native_auth_grant where id = $1",
				[fixture.grantId],
			)
		).rows[0].consumed_at,
	).not.toBeNull();
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
});

test("session minting starts only after the grant claim commits and releases row locks", async () => {
	let grantId = "";
	const probing = new NativeGrantStore(restricted, {
		createSession: async (userId) => {
			const probe = await admin.connect();
			try {
				await probe.query("begin");
				await probe.query(
					'select id from "user" where id = $1 for update nowait',
					[userId],
				);
				const claim = await probe.query(
					"select consumed_at from native_auth_grant where id = $1 for update nowait",
					[grantId],
				);
				expect(claim.rows).toHaveLength(1);
				expect(claim.rows[0].consumed_at).not.toBeNull();
			} finally {
				try {
					await probe.query("rollback");
				} finally {
					probe.release();
				}
			}
			return sessions.createSession(userId);
		},
		deleteSession: (token) => sessions.deleteSession(token),
	});
	const fixture = await approved(probing);
	grantId = fixture.grantId;
	const created = await successful(grantId, probing);
	expect(await lookupNativeSession(restricted, created.token)).toMatchObject({
		userId: fixture.id,
	});
});

test.each([
	"signed-out",
	"deleted-user",
] as const)("authority becoming %s during minting refuses binding and compensates the real session", async (change) => {
	let browserSessionId = "";
	let created: SessionHandle | undefined;
	const changing = new NativeGrantStore(restricted, {
		createSession: async (userId) => {
			const client = await admin.connect();
			try {
				await client.query("begin");
				await client.query("set local lock_timeout = '500ms'");
				if (change === "signed-out")
					await client.query("delete from session where id = $1", [
						browserSessionId,
					]);
				else
					await client.query(
						'update "user" set deleted_at = now() where id = $1',
						[userId],
					);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			} finally {
				client.release();
			}
			created = await sessions.createSession(userId);
			return created;
		},
		deleteSession: (token) => sessions.deleteSession(token),
	});
	const fixture = await approved(changing);
	browserSessionId = fixture.browser.id;
	expect(await changing.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
	if (!created)
		throw new Error(
			"Authority-change case did not reach real session creation",
		);
	expect(
		(await admin.query("select id from session where id = $1", [created.id]))
			.rows,
	).toEqual([]);
	expect(await lookupNativeSession(restricted, created.token)).toBeNull();
	expect(await store.exchange(fixture.grantId, verifier)).toEqual({
		kind: "invalid",
	});
});

test("an independent native session cannot approve another grant", async () => {
	const fixture = await approved();
	const native = await successful(fixture.grantId);
	const grantId = await pending();
	expect(await store.approve(grantId, fixture.id, native.sessionId)).toBe(
		"invalid",
	);
	expect(await store.exchange(grantId, verifier)).toEqual({ kind: "pending" });
	expect(await store.approve(grantId, fixture.id, fixture.browser.id)).toBe(
		"approved",
	);
});

test("native lookup passes forced device RLS, while browser/orphan/revoked credentials fail", async () => {
	const fixture = await approved();
	const created = await successful(fixture.grantId);
	const unscoped = await restricted.query(
		"select id from user_device where id = $1",
		[created.deviceId],
	);
	expect(unscoped.rows).toEqual([]);
	expect(await lookupNativeSession(restricted, created.token)).toMatchObject({
		userId: fixture.id,
		deviceId: created.deviceId,
	});
	expect(
		await lookupNativeSession(restricted, fixture.browser.token),
	).toBeNull();
	const orphan = await sessions.createSession(fixture.id);
	expect(await lookupNativeSession(restricted, orphan.token)).toBeNull();
	const ambientCases: Array<Record<string, string>> = [
		{ origin },
		{ cookie: "browser=present" },
	];
	for (const ambient of ambientCases) {
		expect(
			await authenticateNative(
				restricted,
				new Headers({ authorization: `Bearer ${created.token}`, ...ambient }),
			),
		).toBeNull();
	}
	await admin.query("update user_device set revoked_at = now() where id = $1", [
		created.deviceId,
	]);
	expect(await lookupNativeSession(restricted, created.token)).toBeNull();
});

test("real browser cookie and origin guards authorize the route exchange", async () => {
	const owner = await person();
	const context = await auth.$context;
	const signed = `${owner.browser.token}.${await makeSignature(owner.browser.token, context.secret)}`;
	const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
	const routes = nativeAuthRoutes({
		pool: restricted,
		sessions,
		guards: makeGuards([origin], (headers) => auth.api.getSession({ headers })),
		rateLimit: async () => true,
		signZeroToken: async (session) =>
			(
				await auth.api.signJWT({
					body: { payload: nativeZeroPayload(session) },
				})
			).token,
	});
	const post = (
		path: string,
		body: unknown,
		headers: Record<string, string> = {},
	) =>
		routes.handle(
			new Request(`${origin}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			}),
		);
	const creation = await post("/api/native/grants", {
		challenge: s256Challenge(verifier),
		deviceLabel: "Route device",
	});
	expect(creation.status).toBe(200);
	const { grantId } = (await creation.json()) as { grantId: string };
	grants.push(grantId);
	expect(creation.headers.get("cache-control")).toBe("no-store");
	expect(
		(
			await post(
				"/api/native/grants/approve",
				{ grantId },
				{ cookie, origin: "https://foreign.example" },
			)
		).status,
	).toBe(403);
	expect(
		(await post("/api/native/grants/approve", { grantId }, { origin })).status,
	).toBe(401);
	expect(
		(
			await post(
				"/api/native/grants/approve",
				{ grantId },
				{ cookie, origin, authorization: `Bearer ${owner.browser.token}` },
			)
		).status,
	).toBe(400);
	expect(
		(await post("/api/native/grants/approve", { grantId }, { cookie, origin }))
			.status,
	).toBe(200);
	const rejectedHeaders: Array<Record<string, string>> = [
		{ origin },
		{ cookie },
		{ authorization: `Bearer ${owner.browser.token}` },
	];
	for (const headers of rejectedHeaders) {
		expect(
			(
				await post(
					"/api/native/grants",
					{ challenge: s256Challenge(verifier), deviceLabel: "Rejected" },
					headers,
				)
			).status,
		).toBe(400);
		expect(
			(
				await post(
					"/api/native/grants/exchange",
					{ grantId, verifier },
					headers,
				)
			).status,
		).toBe(400);
	}
	const exchange = await post("/api/native/grants/exchange", {
		grantId,
		verifier,
	});
	expect(exchange.status).toBe(200);
	expect(exchange.headers.get("set-cookie")).toBeNull();
	const native = (await exchange.json()) as {
		token: string;
		userId: string;
		deviceId: string;
	};
	expect(native.userId).toBe(owner.id);
	const authenticated = await routes.handle(
		new Request(`${origin}/api/native/session`, {
			headers: { authorization: `Bearer ${native.token}` },
		}),
	);
	expect(authenticated.status).toBe(200);
	expect(await authenticated.json()).toMatchObject({
		userId: owner.id,
		deviceId: native.deviceId,
	});
	expect(
		(
			await routes.handle(
				new Request(`${origin}/api/native/session`, {
					headers: { authorization: `Bearer ${owner.browser.token}` },
				}),
			)
		).status,
	).toBe(401);
});

test("grant preview exposes only metadata while pending and approved, then refuses a consumed claim", async () => {
	const owner = await person();
	const grantId = await pending();
	const expiry = (
		await admin.query("select expires_at from native_auth_grant where id=$1", [
			grantId,
		])
	).rows[0].expires_at;
	expect(await store.preview(grantId, owner.id, owner.browser.id)).toEqual({
		deviceLabel: "Test device",
		expiresAt: expiry,
		state: "pending",
	});
	expect(await store.approve(grantId, owner.id, owner.browser.id)).toBe(
		"approved",
	);
	expect(await store.preview(grantId, owner.id, owner.browser.id)).toEqual({
		deviceLabel: "Test device",
		expiresAt: expiry,
		state: "approved",
	});
	await successful(grantId);
	expect(await store.preview(grantId, owner.id, owner.browser.id)).toBeNull();
});

test("grant preview refuses unknown and expired metadata", async () => {
	const owner = await person();
	expect(
		await store.preview(
			randomBytes(32).toString("base64url"),
			owner.id,
			owner.browser.id,
		),
	).toBeNull();
	const grantId = await pending();
	await admin.query(
		"update native_auth_grant set expires_at=now()-interval '1 second' where id=$1",
		[grantId],
	);
	expect(await store.preview(grantId, owner.id, owner.browser.id)).toBeNull();
});

test("grant preview refuses another approved user and a revoked original approver even with a live replacement browser session", async () => {
	const f = await approved();
	const stranger = await person();
	expect(
		await store.preview(f.grantId, stranger.id, stranger.browser.id),
	).toBeNull();
	const replacement = await sessions.createSession(f.id);
	expect(await store.preview(f.grantId, f.id, replacement.id)).toMatchObject({
		state: "approved",
	});
	await sessions.deleteSession(f.browser.token);
	expect(await store.preview(f.grantId, f.id, replacement.id)).toBeNull();
});

test("grant preview requires a live current browser and user, refusing native and missing sessions", async () => {
	const f = await approved();
	const native = await successful(f.grantId);
	const grantId = await pending();
	expect(await store.preview(grantId, f.id, native.sessionId)).toBeNull();
	expect(await store.preview(grantId, f.id, randomUUID())).toBeNull();
	const deleted = await sessions.createSession(f.id);
	await sessions.deleteSession(deleted.token);
	expect(await store.preview(grantId, f.id, deleted.id)).toBeNull();
	const expired = await sessions.createSession(f.id);
	await admin.query(
		"update session set expires_at=now()-interval '1 second' where id=$1",
		[expired.id],
	);
	expect(await store.preview(grantId, f.id, expired.id)).toBeNull();
	expect(await store.preview(grantId, f.id, f.browser.id)).toMatchObject({
		state: "pending",
	});
	await admin.query('update "user" set deleted_at=now() where id=$1', [f.id]);
	expect(await store.preview(grantId, f.id, f.browser.id)).toBeNull();
});

test("grant preview GET uses real browser guards, validates the capability, and never caches metadata or refusals", async () => {
	const owner = await person();
	const grantId = await pending();
	const context = await auth.$context;
	const signed = `${owner.browser.token}.${await makeSignature(owner.browser.token, context.secret)}`;
	const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
	const routes = nativeAuthRoutes({
		pool: restricted,
		sessions,
		guards: makeGuards([origin], (headers) => auth.api.getSession({ headers })),
		rateLimit: async () => true,
		signZeroToken: async (session) =>
			(
				await auth.api.signJWT({
					body: { payload: nativeZeroPayload(session) },
				})
			).token,
	});
	const get = async (query: string, headers: Record<string, string>) => {
		const response = await routes.handle(
			new Request(`${origin}/api/native/grants/preview${query}`, { headers }),
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
		return response;
	};
	const query = `?grantId=${grantId}`;
	const preview = await get(query, { cookie });
	expect(preview.status).toBe(200);
	const expiry = (
		await admin.query("select expires_at from native_auth_grant where id=$1", [
			grantId,
		])
	).rows[0].expires_at as Date;
	expect(await preview.json()).toEqual({
		deviceLabel: "Test device",
		expiresAt: expiry.toISOString(),
		state: "pending",
	});
	const unknown = await get(
		`?grantId=${randomBytes(32).toString("base64url")}`,
		{ cookie },
	);
	expect(unknown.status).toBe(404);
	expect(await unknown.json()).toEqual({ code: "invalid-grant" });
	for (const malformed of ["", "?grantId=short", `${query}&grantId=${grantId}`])
		expect((await get(malformed, { cookie })).status).toBe(400);
	expect((await get(query, {})).status).toBe(401);
	const orphan = await sessions.createSession(owner.id);
	expect(
		(await get(query, { authorization: `Bearer ${orphan.token}` })).status,
	).toBe(401);
	expect(
		(await get(query, { cookie, origin: "https://foreign.example" })).status,
	).toBe(403);
	expect(
		(
			await get(query, {
				cookie,
				authorization: `Bearer ${owner.browser.token}`,
			})
		).status,
	).toBe(400);
	expect(await store.approve(grantId, owner.id, owner.browser.id)).toBe(
		"approved",
	);
	expect(await (await get(query, { cookie })).json()).toEqual({
		deviceLabel: "Test device",
		expiresAt: expiry.toISOString(),
		state: "approved",
	});
	await successful(grantId);
	expect((await get(query, { cookie })).status).toBe(404);
});
