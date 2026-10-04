import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import { hashPAT } from "../../src/security/field-encryption.ts";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import {
	personalAccessTokenRoutes,
	publicApiRoutes,
} from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
	withPersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = `api_test_${randomUUID().replaceAll("-", "")}`;
runtime.on("connect", (client) => {
	void client.query(`set role "${role}"`);
});
const app = publicApiRoutes(runtime, async () => true);
let token: string;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema public to "${role}"`,
	);
	const identity = await runtime.query(
		"select rolsuper, rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(identity.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
	const policy = await runtime.query(
		"select relrowsecurity, relforcerowsecurity from pg_class where oid='personal_access_token'::regclass",
	);
	expect(policy.rows[0]).toEqual({
		relrowsecurity: true,
		relforcerowsecurity: true,
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email,email_verified) values
		('api-alice','Alice','alice@api.test',true), ('api-bob','Bob','bob@api.test',true), ('api-viewer','Alex','viewer@api.test',true)`);
	await admin.query(
		`insert into workspace (id,name,owner_id,kind) values ('api-private','Private','api-alice','personal'), ('api-shared','Shared','api-alice','shared'), ('api-outside','Other','api-bob','personal')`,
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values ('api-own','api-alice','api-private','owner'), ('api-shared-own','api-alice','api-shared','owner'), ('api-view','api-viewer','api-shared','viewer'), ('api-other','api-bob','api-outside','owner')`,
	);
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,sort_key) values ('api-list-a','api-private','api-alice','Private tasks','a0'), ('api-list-b','api-shared','api-alice','Shared tasks','a0'), ('api-list-z','api-outside','api-bob','Outsider tasks','a0')`,
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key) values ('api-task-a','api-list-a','A','a0'), ('api-task-b','api-list-a','B','a1'), ('api-task-c','api-list-b','C','a0'), ('api-task-z','api-list-z','Hidden','a0')`,
	);
	await admin.query(
		`insert into user_pref (id,timezone,timezone_chosen,locale) values ('api-alice','Europe/Berlin',true,'ro')`,
	);
	token = (
		await createPersonalAccessToken(runtime, "api-alice", { name: "agent" })
	).token;
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});

function request(path: string, secret: string | null = token) {
	return app.handle(
		new Request(`http://localhost${path}`, {
			headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
		}),
	);
}

test("stores only token hashes and cannot list or change another user's token", async () => {
	const stored = await withUserContext(runtime, "api-alice", (client) =>
		client.query("select token_hash from personal_access_token"),
	);
	expect(stored.rows).toEqual([{ token_hash: hashPAT(token) }]);
	expect(
		JSON.stringify(await listPersonalAccessTokens(runtime, "api-alice")),
	).not.toContain(token);
	expect(await listPersonalAccessTokens(runtime, "api-bob")).toEqual([]);
	const [metadata] = await listPersonalAccessTokens(runtime, "api-alice");
	await expect(
		revokePersonalAccessToken(runtime, "api-bob", metadata.id),
	).rejects.toMatchObject({ status: 404 });
	await expect(
		withUserContext(runtime, "api-bob", (client) =>
			client.query(
				"insert into personal_access_token (id,user_id,name,token_hash,hint,access,expires_at) values ($1,'api-alice','forged','forged','nope','write',now()+interval '1 day')",
				[randomUUID()],
			),
		),
	).rejects.toThrow();
});

test("returns stable pages and never returns outsider tasks, including direct-ID probes", async () => {
	const first = await (await request("/api/v1/tasks?limit=2")).json();
	expect(first.data.map((task: { id: string }) => task.id)).toEqual([
		"api-task-a",
		"api-task-b",
	]);
	const second = await (
		await request(`/api/v1/tasks?limit=2&cursor=${first.nextCursor}`)
	).json();
	expect(second.data.map((task: { id: string }) => task.id)).toEqual([
		"api-task-c",
	]);
	expect(second.nextCursor).toBeNull();
	expect((await request("/api/v1/tasks/api-task-z")).status).toBe(404);
	expect((await request("/api/v1/tasks/api-task-missing")).status).toBe(404);
	expect(
		(await (await request("/api/v1/tasks?workspaceId=api-outside")).json())
			.data,
	).toEqual([]);
});

test("viewers read only their memberships and revoked membership disappears immediately", async () => {
	const viewer = (
		await createPersonalAccessToken(runtime, "api-viewer", { name: "viewer" })
	).token;
	expect(
		(await (await request("/api/v1/tasks", viewer)).json()).data.map(
			(row: { id: string }) => row.id,
		),
	).toEqual(["api-task-c"]);
	await admin.query("delete from membership where id='api-view'");
	expect((await (await request("/api/v1/tasks", viewer)).json()).data).toEqual(
		[],
	);
});

test("profile exposes explicit timezone choice; people discovery excludes unrelated accounts", async () => {
	expect((await (await request("/api/v1/me")).json()).data).toMatchObject({
		id: "api-alice",
		timezone: "Europe/Berlin",
		timezoneChosen: true,
		locale: "ro",
		tokenAccess: "read",
	});
	expect(
		(await (await request("/api/v1/people")).json()).data.map(
			(row: { id: string }) => row.id,
		),
	).toEqual(["api-alice", "api-viewer"]);
	expect(
		(
			await (await request("/api/v1/people?workspaceId=api-private")).json()
		).data.map((row: { id: string }) => row.id),
	).toEqual(["api-alice"]);
});

test("saved surfaces preserve personal scope and shared membership without leaking account fields", async () => {
	const filter = { op: "and", conditions: [] };
	const display = {
		layout: "list",
		groupBy: "none",
		sort: { field: "sortKey", dir: "asc" },
		workspaceScope: { mode: "all" },
	};
	for (const [id, owner, scope, workspace] of [
		["api-personal", "api-alice", "personal", null],
		["api-team", "api-alice", "workspace", "api-shared"],
		["api-hidden", "api-viewer", "personal", null],
	] as const) {
		await admin.query(
			"insert into view (id,owner_id,scope,workspace_id,name,sort_key,filter,display) values ($1,$2,$3,$4,$1,'a0',$5,$6)",
			[
				id,
				owner,
				scope,
				workspace,
				JSON.stringify(filter),
				JSON.stringify(display),
			],
		);
		await admin.query(
			"insert into dashboard (id,owner_id,scope,workspace_id,name,sort_key,panels) values ($1,$2,$3,$4,$1,'a0','[]')",
			[id, owner, scope, workspace],
		);
	}
	for (const resource of ["views", "dashboards"] as const) {
		const response = await request(`/api/v1/${resource}`);
		expect(response.status).toBe(200);
		expect(
			(await response.json()).data.map((row: { id: string }) => row.id),
		).toEqual(["api-personal", "api-team"]);
		expect((await request(`/api/v1/${resource}/api-hidden`)).status).toBe(404);
	}
	for (const resource of ["workspaces", "lists", "people", "labels"] as const) {
		const response = await request(`/api/v1/${resource}`);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).not.toContain("@api.test");
		expect(body).not.toContain("api-outside");
	}
	const schema = await request("/api/v1/openapi.json", null);
	const paths = (await schema.json()).paths;
	expect(Object.keys(paths)).toHaveLength(28);
	expect(
		paths["/api/v1/lists/{id}/observation"].get.responses["200"],
	).toBeDefined();
	expect(paths["/api/v1/lists/{id}"].patch.requestBody.required).toBe(true);
	expect(
		paths["/api/v1/tasks/{id}/relationships"].patch.requestBody.required,
	).toBe(true);
	expect(
		paths["/api/v1/tasks/{id}/observation"].get.responses["200"],
	).toBeDefined();
	expect(paths["/api/v1/tasks/{id}"].patch.requestBody.required).toBe(true);
	expect(
		paths["/api/v1/tasks/{id}/deletion-observation"].get.responses["200"],
	).toBeDefined();
	expect(paths["/api/v1/tasks/{id}"].delete.requestBody.required).toBe(true);
	expect(paths["/api/v1/dashboards"].get.responses["200"]).toBeDefined();
	expect(
		paths["/api/v1/lists/{id}/deletion-observation"].get.responses["200"],
	).toBeDefined();
	expect(paths["/api/v1/lists/{id}"].delete.responses["200"]).toBeDefined();
	expect(
		paths["/api/v1/folders/{id}/observation"].get.responses["200"],
	).toBeDefined();
	expect(paths["/api/v1/folders/{id}"].delete.requestBody.required).toBe(true);
});

test("unknown, revoked, expired and deleted-account credentials all fail uniformly", async () => {
	for (const secret of [null, `ditero_pat_${"a".repeat(43)}`])
		expect((await request("/api/v1/me", secret)).status).toBe(401);
	const [metadata] = await listPersonalAccessTokens(runtime, "api-alice");
	await revokePersonalAccessToken(runtime, "api-alice", metadata.id);
	await revokePersonalAccessToken(runtime, "api-alice", metadata.id);
	expect((await request("/api/v1/me")).status).toBe(401);
	const fresh = (
		await createPersonalAccessToken(runtime, "api-alice", { name: "expiring" })
	).token;
	await admin.query(
		"update personal_access_token set created_at=now()-interval '2 days', expires_at=now()-interval '1 day' where token_hash=$1",
		[hashPAT(fresh)],
	);
	expect((await request("/api/v1/me", fresh)).status).toBe(401);
	const active = (
		await createPersonalAccessToken(runtime, "api-alice", { name: "deleted" })
	).token;
	await admin.query('update "user" set deleted_at=now() where id=$1', [
		"api-alice",
	]);
	expect((await request("/api/v1/me", active)).status).toBe(401);
});

test("read tokens cannot cross write ceiling; maximum lifetime is accepted", async () => {
	await expect(
		withPersonalAccessToken(runtime, token, "write", async () => true),
	).rejects.toMatchObject({ status: 403 });
	const writer = (
		await createPersonalAccessToken(runtime, "api-alice", {
			name: "writer",
			access: "write",
			expiresInDays: 365,
		})
	).token;
	expect(
		await withPersonalAccessToken(
			runtime,
			writer,
			"write",
			async (_client, actor) => actor.access,
		),
	).toBe("write");
});

test("account deletion removes token metadata and hashes in the deletion transaction", async () => {
	const secret = (
		await createPersonalAccessToken(runtime, "api-viewer", {
			name: "private integration name",
		})
	).token;
	const guards = makeGuards(
		["http://localhost"],
		async () => ({ user: { id: "api-viewer" } }) as Session,
	);
	const deletion = accountDeletionRoutes(runtime, guards);
	const response = await deletion.handle(
		new Request("http://localhost/api/account/delete", {
			method: "POST",
			headers: {
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({ acknowledgeKeyLoss: true }),
		}),
	);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ deleted: true });
	expect(
		(
			await admin.query(
				"select count(*)::int as count from personal_access_token where user_id='api-viewer'",
			)
		).rows[0].count,
	).toBe(0);
	expect((await request("/api/v1/me", secret)).status).toBe(401);
});

test("concurrent creation cannot exceed the active token limit", async () => {
	for (let index = 0; index < 18; index++)
		await createPersonalAccessToken(runtime, "api-alice", {
			name: `token-${index}`,
		});
	const results = await Promise.allSettled([
		createPersonalAccessToken(runtime, "api-alice", { name: "last-a" }),
		createPersonalAccessToken(runtime, "api-alice", { name: "last-b" }),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === "rejected")).toHaveLength(
		1,
	);
	expect(await listPersonalAccessTokens(runtime, "api-alice")).toHaveLength(20);
});

test("token management is same-origin session-only and returns a secret once", async () => {
	const session = { user: { id: "api-alice" } } as Session;
	const guards = makeGuards(["http://localhost"], async (headers) =>
		headers.get("cookie") === "test-session" ? session : null,
	);
	const management = new Elysia().use(
		personalAccessTokenRoutes(runtime, guards, async () => true),
	);
	const body = JSON.stringify({ name: "created in settings" });
	const foreign = await management.handle(
		new Request("http://localhost/api/personal-access-tokens", {
			method: "POST",
			headers: {
				origin: "https://foreign.invalid",
				cookie: "test-session",
				"content-type": "application/json",
			},
			body,
		}),
	);
	expect(foreign.status).toBe(403);
	const response = await management.handle(
		new Request("http://localhost/api/personal-access-tokens", {
			method: "POST",
			headers: {
				origin: "http://localhost",
				cookie: "test-session",
				"content-type": "application/json",
			},
			body,
		}),
	);
	expect(response.status).toBe(201);
	expect((await response.json()).data.token).toMatch(
		/^ditero_pat_[A-Za-z0-9_-]{43}$/,
	);
	const bearerOnly = await management.handle(
		new Request("http://localhost/api/personal-access-tokens", {
			headers: { authorization: `Bearer ${token}` },
		}),
	);
	expect(bearerOnly.status).toBe(401);
});
