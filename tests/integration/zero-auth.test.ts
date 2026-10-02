import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { makeSignature } from "better-auth/crypto";
import { createLocalJWKSet, type JWTPayload, jwtVerify } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { s256Challenge } from "../../src/server/native-auth/contracts.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import {
	nativeZeroPayload,
	ZERO_TOKEN_TTL_SECONDS,
	zeroAuthConfig,
} from "../../src/server/zero-auth.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const oldAuthURL = process.env.BETTER_AUTH_URL;
const admin = new Pool({ connectionString: databaseURL });
const suffix = randomBytes(8).toString("hex");
const role = `zero_auth_${suffix}`;
const password = randomBytes(32).toString("hex");
const upstream = `zero_auth_${suffix}`;
const users: string[] = [];
const spaces: string[] = [];
const grants: string[] = [];
let auth: typeof import("../../src/auth/auth.ts").auth;
let app: typeof import("../../src/server/index.ts").app;
let runtime: Pool;
let verify: ReturnType<
	typeof import("../../src/server/ctx.ts").createZeroVerifier
>;
let keys: ReturnType<typeof createLocalJWKSet>;
let origin: string;
let roleCreated = false;
const jwksServer = createServer(async (request, response) => {
	try {
		if (request.url !== "/api/auth/jwks") {
			response.writeHead(404);
			response.end();
			return;
		}
		const result = await auth.handler(new Request(`${origin}/api/auth/jwks`));
		response.writeHead(result.status, Object.fromEntries(result.headers));
		response.end(await result.text());
	} catch {
		response.writeHead(500);
		response.end();
	}
});

beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema public to "${role}"`,
	);
	await admin.query(`create schema "${upstream}"`);
	await admin.query(
		`create table "${upstream}".clients ("clientGroupID" text not null, "clientID" text not null, "lastMutationID" bigint not null, primary key ("clientGroupID", "clientID"))`,
	);
	await admin.query(
		`create table "${upstream}".mutations ("clientGroupID" text not null, "clientID" text not null, "mutationID" bigint not null, result json not null, primary key ("clientGroupID", "clientID", "mutationID"))`,
	);
	await admin.query(`grant usage on schema "${upstream}" to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema "${upstream}" to "${role}"`,
	);
	await new Promise<void>((resolve, reject) => {
		jwksServer.once("error", reject);
		jwksServer.listen(0, "127.0.0.1", resolve);
	});
	const address = jwksServer.address();
	if (!address || typeof address === "string")
		throw new Error("Missing JWKS address");
	if ([3000, 4848, 5175, 57990, 55438, 4858, 55441].includes(address.port))
		throw new Error("Reserved port selected");
	origin = `http://127.0.0.1:${address.port}`;
	const restrictedURL = new URL(databaseURL);
	restrictedURL.username = role;
	restrictedURL.password = password;
	process.env.DATABASE_URL = restrictedURL.toString();
	process.env.BETTER_AUTH_URL = origin;
	({ auth } = await import("../../src/auth/auth.ts"));
	({ app } = await import("../../src/server/index.ts"));
	({ pool: runtime } = await import("../../src/db/client.ts"));
	expect(
		(
			await runtime.query(
				"select rolsuper, rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	expect(
		(
			await runtime.query(
				"select relrowsecurity, relforcerowsecurity from pg_class where oid='user_device'::regclass",
			)
		).rows,
	).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
	const jwks = await auth.api.getJwks();
	keys = createLocalJWKSet(jwks);
	const { createZeroVerifier } = await import("../../src/server/ctx.ts");
	verify = createZeroVerifier({ pool: runtime, keys, ...zeroAuthConfig() });
});

afterAll(async () => {
	const errors: unknown[] = [];
	for (const cleanup of [
		async () => {
			await admin.query(
				"delete from native_auth_grant where id=any($1::text[])",
				[grants],
			);
			await admin.query(
				"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
				[spaces],
			);
			await admin.query("delete from list where workspace_id=any($1::text[])", [
				spaces,
			]);
			await admin.query(
				"delete from membership where workspace_id=any($1::text[])",
				[spaces],
			);
			await admin.query("delete from workspace where id=any($1::text[])", [
				spaces,
			]);
			await admin.query('delete from "user" where id=any($1::text[])', [users]);
		},
		async () => {
			if (runtime) await runtime.end();
		},
		async () => {
			if (jwksServer.listening)
				await new Promise<void>((resolve, reject) =>
					jwksServer.close((error) => (error ? reject(error) : resolve())),
				);
		},
		async () => {
			await admin.query(`drop schema if exists "${upstream}" cascade`);
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
	process.env.DATABASE_URL = databaseURL;
	if (oldAuthURL === undefined) delete process.env.BETTER_AUTH_URL;
	else process.env.BETTER_AUTH_URL = oldAuthURL;
	if (errors.length)
		throw new AggregateError(errors, "Zero auth fixture cleanup failed");
});

async function fixture() {
	const userId = `zero-${randomUUID()}`;
	users.push(userId);
	await admin.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[userId, "Zero Tester", `${userId}@example.test`],
	);
	const adapter = (await auth.$context).internalAdapter;
	const browser = await adapter.createSession(userId, false);
	const context = await auth.$context;
	const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${browser.token}.${await makeSignature(browser.token, context.secret)}`)}`;
	const store = new NativeGrantStore(runtime, {
		createSession: (id) => adapter.createSession(id, false),
		deleteSession: (token) => adapter.deleteSession(token),
	});
	const verifier = "z".repeat(43);
	const grant = await store.create(s256Challenge(verifier), "JWT test device");
	grants.push(grant.grantId);
	expect(await store.approve(grant.grantId, userId, browser.id)).toBe(
		"approved",
	);
	const native = await store.exchange(grant.grantId, verifier);
	if (native.kind !== "ok")
		throw new Error(`Native fixture exchange ${native.kind}`);
	const workspaceId = `space-${randomUUID()}`;
	const listId = `list-${randomUUID()}`;
	const taskId = `task-${randomUUID()}`;
	spaces.push(workspaceId);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ($1,'JWT scope',$2,'shared')",
		[workspaceId, userId],
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,'owner')",
		[randomUUID(), userId, workspaceId],
	);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ($1,$2,$3,'JWT tasks','tasks','a0')",
		[listId, workspaceId, userId],
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ($1,$2,'Original','a0')",
		[taskId, listId],
	);
	return { userId, browser, cookie, native, taskId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function nativeToken(f: Fixture) {
	const response = await app.handle(
		new Request(`${origin}/api/native/token`, {
			headers: { authorization: `Bearer ${f.native.token}` },
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return ((await response.json()) as { token: string }).token;
}
async function browserToken(f: Fixture) {
	const response = await auth.handler(
		new Request(`${origin}/api/auth/token`, { headers: { cookie: f.cookie } }),
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { token: string }).token;
}
async function request(
	endpoint: "query" | "mutate",
	token: string,
	f: Fixture,
) {
	const body =
		endpoint === "query"
			? ["transform", [{ id: randomUUID(), name: "tasks.mine", args: [{}] }]]
			: {
					clientGroupID: randomUUID(),
					mutations: [
						{
							type: "custom",
							id: 1,
							clientID: randomUUID(),
							name: "task.update",
							args: [{ id: f.taskId, title: "Authorized mutation" }],
							timestamp: Date.now(),
						},
					],
					pushVersion: 1,
					timestamp: Date.now(),
					requestID: randomUUID(),
				};
	return app.handle(
		new Request(
			`${origin}/api/zero/${endpoint}?schema=${upstream}&appID=ditero`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(body),
			},
		),
	);
}
async function assertRefused(token: string, f: Fixture) {
	const before = (
		await admin.query("select title from task where id=$1", [f.taskId])
	).rows;
	for (const endpoint of ["query", "mutate"] as const)
		expect((await request(endpoint, token, f)).status).toBe(401);
	expect(
		(await admin.query("select title from task where id=$1", [f.taskId])).rows,
	).toEqual(before);
}
async function signed(payload: JWTPayload) {
	return (await auth.api.signJWT({ body: { payload } })).token;
}
async function nativeClaims(f: Fixture) {
	const { lookupNativeSession } = await import(
		"../../src/server/native-auth/session.ts"
	);
	const session = await lookupNativeSession(runtime, f.native.token);
	if (!session) throw new Error("Native fixture missing");
	return nativeZeroPayload(session);
}

test.each([
	"browser",
	"native",
] as const)("actual %s JWT signs bounded claims and authorizes mounted query and committed mutation", async (kind) => {
	const f = await fixture();
	const token =
		kind === "browser" ? await browserToken(f) : await nativeToken(f);
	const { issuer, audience } = zeroAuthConfig();
	const { payload } = await jwtVerify(token, keys, {
		issuer,
		audience,
		algorithms: ["EdDSA"],
	});
	expect(payload).toMatchObject({
		sub: f.userId,
		sid: kind === "browser" ? f.browser.id : f.native.sessionId,
		authKind: kind,
	});
	if (kind === "native") expect(payload.did).toBe(f.native.deviceId);
	else expect(payload).not.toHaveProperty("did");
	expect(payload).not.toHaveProperty("email");
	expect(payload).not.toHaveProperty("name");
	expect(typeof payload.iat).toBe("number");
	expect(typeof payload.exp).toBe("number");
	expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeGreaterThan(0);
	expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(
		ZERO_TOKEN_TTL_SECONDS,
	);
	expect(await verify(`Bearer ${token}`)).toEqual({ id: f.userId });
	expect(await verify(`bearer ${token}`)).toEqual({ id: f.userId });
	const query = await request("query", token, f);
	expect(query.status).toBe(200);
	const transformed = (await query.json()) as {
		kind: string;
		queries: { ast?: unknown; error?: unknown }[];
	};
	expect(transformed.kind).toBe("QueryResponse");
	expect(transformed.queries).toHaveLength(1);
	expect(transformed.queries[0]).toHaveProperty("ast");
	expect(transformed.queries[0]).not.toHaveProperty("error");
	const mutation = await request("mutate", token, f);
	expect(mutation.status).toBe(200);
	expect(
		(await admin.query("select title from task where id=$1", [f.taskId])).rows,
	).toEqual([{ title: "Authorized mutation" }]);
});

test.each([
	"device",
	"session-deleted",
	"session-expired",
	"link",
	"user",
] as const)("an already issued native JWT loses both ingress paths after %s revocation", async (change) => {
	const f = await fixture();
	const token = await nativeToken(f);
	expect(await verify(`Bearer ${token}`)).toEqual({ id: f.userId });
	if (change === "device")
		await admin.query("update user_device set revoked_at=now() where id=$1", [
			f.native.deviceId,
		]);
	else if (change === "session-deleted")
		await admin.query("delete from session where id=$1", [f.native.sessionId]);
	else if (change === "session-expired")
		await admin.query(
			"update session set expires_at=now()-interval '1 second' where id=$1",
			[f.native.sessionId],
		);
	else if (change === "link")
		await admin.query("delete from native_session_link where session_id=$1", [
			f.native.sessionId,
		]);
	else
		await admin.query('update "user" set deleted_at=now() where id=$1', [
			f.userId,
		]);
	expect(await verify(`Bearer ${token}`)).toBeUndefined();
	await assertRefused(token, f);
});

test("an already issued browser JWT is refused after its live session is deleted", async () => {
	const f = await fixture();
	const token = await browserToken(f);
	expect(await verify(`Bearer ${token}`)).toEqual({ id: f.userId });
	await admin.query("delete from session where id=$1", [f.browser.id]);
	await assertRefused(token, f);
});

test.each([
	"legacy",
	"missing-sid",
	"empty-sid",
	"wrong-user",
	"wrong-session",
	"wrong-device",
	"missing-device",
	"native-as-browser",
	"browser-with-device",
	"issuer",
	"audience",
	"expired",
	"overlong",
] as const)("actual signed %s claims cannot bypass live binding or token constraints", async (change) => {
	const f = await fixture();
	const payload: JWTPayload = await nativeClaims(f);
	if (change === "legacy") {
		delete payload.sid;
		delete payload.did;
		delete payload.authKind;
	} else if (change === "missing-sid") delete payload.sid;
	else if (change === "empty-sid") payload.sid = "";
	else if (change === "wrong-user") payload.sub = (await fixture()).userId;
	else if (change === "wrong-session") payload.sid = f.browser.id;
	else if (change === "wrong-device") {
		const adapter = (await auth.$context).internalAdapter;
		const otherStore = new NativeGrantStore(runtime, {
			createSession: (id) => adapter.createSession(id, false),
			deleteSession: (token) => adapter.deleteSession(token),
		});
		const grant = await otherStore.create(
			s256Challenge("z".repeat(43)),
			"Second valid device",
		);
		grants.push(grant.grantId);
		expect(
			await otherStore.approve(grant.grantId, f.userId, f.browser.id),
		).toBe("approved");
		const other = await otherStore.exchange(grant.grantId, "z".repeat(43));
		if (other.kind !== "ok")
			throw new Error("Second native device fixture failed");
		payload.did = other.deviceId;
	} else if (change === "missing-device") delete payload.did;
	else if (change === "native-as-browser") {
		payload.authKind = "browser";
		delete payload.did;
	} else if (change === "browser-with-device") {
		payload.authKind = "browser";
		payload.sid = f.browser.id;
	} else if (change === "issuer") payload.iss = "https://foreign.example";
	else if (change === "audience") payload.aud = "other-application";
	else if (change === "expired") {
		payload.iat = Math.floor(Date.now() / 1000) - 60;
		payload.exp = Math.floor(Date.now() / 1000) - 1;
	} else payload.exp = (payload.iat ?? 0) + ZERO_TOKEN_TTL_SECONDS + 1;
	const token = await signed(payload);
	expect(await verify(`Bearer ${token}`)).toBeUndefined();
	await assertRefused(token, f);
});

test("native token endpoint refuses browser and mixed credentials and caps expiry to the live session", async () => {
	const f = await fixture();
	const rejectedHeaders: Record<string, string>[] = [
		{ authorization: `Bearer ${f.browser.token}` },
		{ cookie: f.cookie },
		{ authorization: `Bearer ${f.native.token}`, cookie: f.cookie },
		{ authorization: `Bearer ${f.native.token}`, origin },
	];
	for (const headers of rejectedHeaders) {
		const response = await app.handle(
			new Request(`${origin}/api/native/token`, { headers }),
		);
		expect(response.status).toBe(
			headers.cookie !== undefined || headers.origin !== undefined ? 400 : 401,
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
	}
	const expiry = new Date(Date.now() + 45_000);
	await admin.query("update session set expires_at=$1 where id=$2", [
		expiry,
		f.native.sessionId,
	]);
	const token = await nativeToken(f);
	const { issuer, audience } = zeroAuthConfig();
	const { payload } = await jwtVerify(token, keys, { issuer, audience });
	expect(payload.exp).toBe(Math.floor(expiry.getTime() / 1000));
	expect(await verify(`Bearer ${token}`)).toEqual({ id: f.userId });
});
