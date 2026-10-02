import { randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { makeGuards } from "../../src/server/guards.ts";
import {
	type Sessions,
	s256Challenge,
} from "../../src/server/native-auth/contracts.ts";
import { nativeAuthRoutes } from "../../src/server/native-auth/routes.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import {
	browserZeroPayload,
	nativeZeroPayload,
	zeroAuthConfig,
} from "../../src/server/zero-auth.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const role = `native_app_${suffix}`;
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
let routes: ReturnType<typeof nativeAuthRoutes>;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on "user", session, user_device, native_auth_grant, native_session_link, workspace, membership to "${role}"`,
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
	routes = nativeAuthRoutes({
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
});

afterAll(async () => {
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
		throw new AggregateError(errors, "Native application cleanup failed");
});

// A real user, browser session, and native session minted through the actual
// grant flow, so authentication is never faked.
async function actor(label: string) {
	const id = `native-app-${randomUUID()}`;
	users.push(id);
	const name = `${label} ${suffix}`;
	const email = `${id}@example.test`;
	await admin.query(
		'insert into "user" (id, name, email, email_verified) values ($1, $2, $3, true)',
		[id, name, email],
	);
	const browser = await sessions.createSession(id);
	const grant = await store.create(s256Challenge(verifier), "App test device");
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

type Actor = Awaited<ReturnType<typeof actor>>;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function profile(headers: Record<string, string>, query = "") {
	return routes.handle(
		new Request(`${origin}/api/native/profile${query}`, { headers }),
	);
}

async function bootstrap(headers: Record<string, string>, body?: string) {
	return routes.handle(
		new Request(`${origin}/api/native/bootstrap`, {
			method: "POST",
			headers,
			body,
		}),
	);
}

// Every response, accepted or refused, is uncacheable and sets no cookie.
function expectPrivate(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	return response;
}

async function counts(userId: string) {
	const result = await admin.query<{
		workspaces: number;
		memberships: number;
		scopes: number;
	}>(
		`select
			(select count(*)::int from workspace where owner_id = $1) as workspaces,
			(select count(*)::int from membership where user_id = $1) as memberships,
			(select count(*)::int from workspace_access_scope where user_id = $1) as scopes`,
		[userId],
	);
	return result.rows[0];
}

test("profile returns only the caller's own public fields and refuses browser and orphan tokens", async () => {
	const alice = await actor("Alice");
	const bob = await actor("Bob");
	const response = expectPrivate(
		await profile(bearer(alice.token), `?userId=${bob.id}`),
		200,
	);
	const text = await response.text();
	expect(JSON.parse(text)).toEqual({
		id: alice.id,
		name: alice.name,
		email: alice.email,
	});
	for (const secret of [
		bob.id,
		bob.email,
		alice.token,
		alice.browser.token,
		alice.sessionId,
		alice.deviceId,
	])
		expect(text).not.toContain(secret);
	expect(await (await profile(bearer(bob.token))).json()).toEqual({
		id: bob.id,
		name: bob.name,
		email: bob.email,
	});

	const orphan = await sessions.createSession(alice.id);
	for (const token of [alice.browser.token, orphan.token, "not-a-session"]) {
		const refused = expectPrivate(await profile(bearer(token)), 401);
		expect(await refused.json()).toEqual({ code: "unauthorized" });
	}
	expectPrivate(await profile({}), 401);
});

test("bootstrap is idempotent, accepts only an empty request, and repairs a missing membership", async () => {
	const alice = await actor("Alice");
	const bob = await actor("Bob");
	expect(await counts(alice.id)).toEqual({
		workspaces: 0,
		memberships: 0,
		scopes: 0,
	});

	const first = expectPrivate(await bootstrap(bearer(alice.token)), 200);
	const { workspaceId } = (await first.json()) as { workspaceId: string };
	expect(workspaceId).toEqual(expect.any(String));
	const emptyObject = expectPrivate(
		await bootstrap(
			{ ...bearer(alice.token), "content-type": "application/json" },
			"{}",
		),
		200,
	);
	expect(await emptyObject.json()).toEqual({ workspaceId });
	const emptyBody = expectPrivate(
		await bootstrap({
			...bearer(alice.token),
			"content-type": "application/json",
			"content-length": "0",
		}),
		200,
	);
	expect(await emptyBody.json()).toEqual({ workspaceId });

	const owned = await admin.query(
		"select id, owner_id, kind from workspace where owner_id = $1",
		[alice.id],
	);
	expect(owned.rows).toEqual([
		{ id: workspaceId, owner_id: alice.id, kind: "personal" },
	]);
	const owner = await admin.query(
		`select m.role, s.workspace_id as scope_workspace
		from membership m join workspace_access_scope s on s.id = m.id
		where m.user_id = $1 and m.workspace_id = $2`,
		[alice.id, workspaceId],
	);
	expect(owner.rows).toEqual([{ role: "owner", scope_workspace: workspaceId }]);
	expect(await counts(alice.id)).toEqual({
		workspaces: 1,
		memberships: 1,
		scopes: 1,
	});

	// Canonical membership is authoritative: its delete takes the projection with
	// it, and bootstrap restores both without minting a second workspace.
	await admin.query("delete from membership where user_id = $1", [alice.id]);
	expect(await counts(alice.id)).toEqual({
		workspaces: 1,
		memberships: 0,
		scopes: 0,
	});
	const repaired = expectPrivate(await bootstrap(bearer(alice.token)), 200);
	expect(await repaired.json()).toEqual({ workspaceId });
	expect(await counts(alice.id)).toEqual({
		workspaces: 1,
		memberships: 1,
		scopes: 1,
	});

	const other = expectPrivate(await bootstrap(bearer(bob.token)), 200);
	const { workspaceId: bobSpace } = (await other.json()) as {
		workspaceId: string;
	};
	expect(bobSpace).not.toBe(workspaceId);
	expect(await counts(alice.id)).toEqual({
		workspaces: 1,
		memberships: 1,
		scopes: 1,
	});
});

test("browser credentials and caller-supplied input are refused without provisioning", async () => {
	const alice = await actor("Alice");
	const bob = await actor("Bob");
	const before = [await counts(alice.id), await counts(bob.id)];
	const jsonType = { "content-type": "application/json" };
	const json = { ...bearer(alice.token), ...jsonType };

	// Presence alone refuses, even with an empty value and a valid token.
	const ambientHeaders: Record<string, string>[] = [
		{ cookie: "browser=present" },
		{ cookie: "" },
		{ origin },
		{ origin: "" },
	];
	for (const ambient of ambientHeaders) {
		const headers = { ...bearer(alice.token), ...ambient };
		const refused = expectPrivate(await profile(headers), 400);
		expect(await refused.json()).toEqual({ code: "credentials-not-allowed" });
		expectPrivate(await bootstrap(headers), 400);
		expectPrivate(await bootstrap({ ...headers, ...jsonType }, "{}"), 400);
	}
	expectPrivate(
		await bootstrap({
			cookie: "browser=present",
			...bearer(alice.browser.token),
		}),
		400,
	);

	const text = { ...bearer(alice.token), "content-type": "text/plain" };
	const cases: Array<[Record<string, string>, string, number]> = [
		[json, JSON.stringify({ userId: bob.id }), 400],
		[
			{ ...json, "content-length": "0" },
			JSON.stringify({ userId: bob.id }),
			400,
		],
		[json, JSON.stringify({ accountId: bob.id }), 400],
		[json, JSON.stringify({ workspaceId: randomUUID() }), 400],
		[json, "[]", 400],
		[json, "null", 400],
		[json, "{", 400],
		[json, JSON.stringify({ pad: "x".repeat(5000) }), 413],
		[text, "{}", 415],
		[bearer(alice.token), "{}", 415],
	];
	for (const [headers, body, status] of cases) {
		const refused = expectPrivate(await bootstrap(headers, body), status);
		expect((await refused.json()) as { code: string }).toEqual({
			code: "invalid-request",
		});
	}

	// The browser and orphan tokens cannot provision either.
	expectPrivate(await bootstrap(bearer(alice.browser.token)), 401);
	expect([await counts(alice.id), await counts(bob.id)]).toEqual(before);
});

test("bootstrap refuses a concurrent account deletion without reprovisioning", async () => {
	const subject = await actor("Subject");
	const deletion = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await deletion.query("begin");
		const { rows } = await deletion.query<{ pid: number }>(
			"select pg_backend_pid() as pid",
		);
		await deletion.query('select id from "user" where id = $1 for update', [
			subject.id,
		]);
		pending = bootstrap(bearer(subject.token));
		// Observe the actual database wait before committing the tombstone.
		await expect
			.poll(
				async () => {
					const waiting = await admin.query(
						`select 1 from pg_stat_activity where usename = $1
						and $2::int = any(pg_blocking_pids(pid))`,
						[role, rows[0].pid],
					);
					return waiting.rowCount;
				},
				{ timeout: 4000, interval: 10 },
			)
			.toBe(1);
		await deletion.query('update "user" set deleted_at = now() where id = $1', [
			subject.id,
		]);
		await deletion.query("commit");
		const refused = expectPrivate(await pending, 401);
		expect(await refused.json()).toEqual({ code: "unauthorized" });
		expect(await counts(subject.id)).toEqual({
			workspaces: 0,
			memberships: 0,
			scopes: 0,
		});
	} finally {
		await deletion.query("rollback");
		deletion.release();
		await pending;
	}
});

test.each([
	"revoked-device",
	"expired-session",
	"deleted-user",
] as const)("a %s native session cannot read the profile or provision", async (change) => {
	const subject: Actor = await actor("Subject");
	if (change === "revoked-device")
		await admin.query(
			"update user_device set revoked_at = now() where id = $1",
			[subject.deviceId],
		);
	else if (change === "expired-session")
		await admin.query(
			"update session set expires_at = now() - interval '1 second' where id = $1",
			[subject.sessionId],
		);
	else
		await admin.query('update "user" set deleted_at = now() where id = $1', [
			subject.id,
		]);
	const refused = expectPrivate(await profile(bearer(subject.token)), 401);
	expect(await refused.json()).toEqual({ code: "unauthorized" });
	expectPrivate(await bootstrap(bearer(subject.token)), 401);
	expectPrivate(await revoke(bearer(subject.token)), 401);
	expect(await counts(subject.id)).toEqual({
		workspaces: 0,
		memberships: 0,
		scopes: 0,
	});
});

async function revoke(headers: Record<string, string>, body?: string) {
	return routes.handle(
		new Request(`${origin}/api/native/session/revoke`, {
			method: "POST",
			headers,
			body,
		}),
	);
}

test("native revocation removes only its own session and invalidates already issued Zero authority", async () => {
	const subject = await actor("Subject");
	const foreign = await actor("Foreign");
	const grant = await store.create(s256Challenge(verifier), "Other device");
	grants.push(grant.grantId);
	expect(
		await store.approve(grant.grantId, subject.id, subject.browser.id),
	).toBe("approved");
	const other = await store.exchange(grant.grantId, verifier);
	if (other.kind !== "ok") throw new Error(`Exchange failed: ${other.kind}`);
	const tokenFor = async (token: string) => {
		const response = expectPrivate(
			await routes.handle(
				new Request(`${origin}/api/native/token`, { headers: bearer(token) }),
			),
			200,
		);
		return ((await response.json()) as { token: string }).token;
	};
	const issued = await tokenFor(subject.token);
	const otherIssued = await tokenFor(other.token);
	const browserIssued = (
		await auth.api.signJWT({
			body: {
				payload: {
					sub: subject.id,
					iat: Math.floor(Date.now() / 1000),
					...browserZeroPayload({ session: subject.browser }),
				},
			},
		})
	).token;
	const jwks = await auth.handler(new Request(`${origin}/api/auth/jwks`));
	expect(jwks.status).toBe(200);
	const { createZeroVerifier } = await import("../../src/server/ctx.ts");
	const verify = createZeroVerifier({
		pool: restricted,
		keys: createLocalJWKSet(await jwks.json()),
		...zeroAuthConfig(),
	});
	for (const token of [issued, otherIssued, browserIssued])
		expect(await verify(`Bearer ${token}`)).toEqual({ id: subject.id });

	const response = expectPrivate(await revoke(bearer(subject.token)), 200);
	expect(await response.json()).toEqual({ revoked: true });
	expectPrivate(await profile(bearer(subject.token)), 401);
	expectPrivate(
		await routes.handle(
			new Request(`${origin}/api/native/token`, {
				headers: bearer(subject.token),
			}),
		),
		401,
	);
	expectPrivate(await revoke(bearer(subject.token)), 401);
	expect(await verify(`Bearer ${issued}`)).toBeUndefined();
	for (const token of [otherIssued, browserIssued])
		expect(await verify(`Bearer ${token}`)).toEqual({ id: subject.id });
	expectPrivate(await profile(bearer(other.token)), 200);
	expectPrivate(await profile(bearer(foreign.token)), 200);
	expect(
		(
			await admin.query("select id from session where id = $1", [
				subject.sessionId,
			])
		).rows,
	).toEqual([]);
	expect(
		(
			await admin.query(
				"select session_id from native_session_link where session_id = $1",
				[subject.sessionId],
			)
		).rows,
	).toEqual([]);
	expect(
		(
			await admin.query("select revoked_at from user_device where id = $1", [
				subject.deviceId,
			])
		).rows[0].revoked_at,
	).toBeInstanceOf(Date);
});

test("native revocation refuses ambient credentials and malformed input without affecting live sessions", async () => {
	const subject = await actor("Subject");
	const foreign = await actor("Foreign");
	const json = { ...bearer(subject.token), "content-type": "application/json" };
	const ambientHeaders: Record<string, string>[] = [
		{ cookie: "" },
		{ cookie: "browser=present" },
		{ origin: "" },
		{ origin },
	];
	for (const ambient of ambientHeaders)
		expectPrivate(await revoke({ ...bearer(subject.token), ...ambient }), 400);
	const cases: Array<[Record<string, string>, string, number]> = [
		[json, JSON.stringify({ sessionId: foreign.sessionId }), 400],
		[json, JSON.stringify({ deviceId: foreign.deviceId }), 400],
		[json, "null", 400],
		[json, "[]", 400],
		[json, "{", 400],
		[json, JSON.stringify({ pad: "x".repeat(5000) }), 413],
		[{ ...json, "content-type": "text/plain" }, "{}", 415],
		[bearer(subject.token), "{}", 415],
	];
	for (const [headers, body, status] of cases)
		expectPrivate(await revoke(headers, body), status);
	for (const token of [subject.browser.token, "not-a-session"])
		expectPrivate(await revoke(bearer(token)), 401);
	expectPrivate(await profile(bearer(subject.token)), 200);
	expectPrivate(await profile(bearer(foreign.token)), 200);
	const response = expectPrivate(await revoke(json, "{}"), 200);
	expect(await response.json()).toEqual({ revoked: true });
	expectPrivate(await profile(bearer(foreign.token)), 200);
});
