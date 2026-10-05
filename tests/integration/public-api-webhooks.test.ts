import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test as vitestTest } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import { WEBHOOK_PREFIX } from "../../src/domain/public-api-webhook.ts";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import type { Guards } from "../../src/server/guards.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_PUBLIC_API_WEBHOOK_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const poolLimits = {
	connectionTimeoutMillis: 5_000,
	query_timeout: 15_000,
	statement_timeout: 15_000,
};
const admin = new Pool({ connectionString: databaseURL, ...poolLimits });
const prefix = `whk_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`;
const password = randomBytes(32).toString("hex");
const connection = new URL(databaseURL);
connection.username = role;
connection.password = password;
const runtime = new Pool({
	connectionString: connection.toString(),
	application_name: role,
	...poolLimits,
});

// Lifecycle state: allocation flags are set before the statement that could
// leave state behind, and every allocated ID is tracked before it is created.
let roleCreated = false;
let roleOid: string | null = null;
let schemaGranted = false;
let tablesGranted = false;
let ready = false;
const causes: unknown[] = [];
const users: string[] = [];
const workspaces: string[] = [];
const memberships: string[] = [];
const lists: string[] = [];
const tasks: string[] = [];
const hooks: string[] = [];
const tokens: string[] = [];
const track = (set: string[], label: string) => {
	const id =
		set === hooks
			? randomUUID()
			: `${prefix}_${label}_${randomUUID().slice(0, 8)}`;
	set.push(id);
	return id;
};
async function preserveCause(body: () => Promise<void>) {
	try {
		await body();
	} catch (error) {
		causes.push(error);
		throw error;
	}
}
const test = (name: string, body: () => Promise<void>) =>
	vitestTest(name, () => preserveCause(body), 20_000);

const collected: unknown[][] = [];
const app = publicApiRoutes(runtime, async () => true);
const eventApp = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		collected.push(events);
	},
);
const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");
// Raw secrets never reach an assertion message: compare, then report a label.
const noLeak = (text: string, ...secrets: string[]) =>
	expect({ leaked: secrets.some((secret) => text.includes(secret)) }).toEqual({
		leaked: false,
	});
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

type CallInit = {
	method?: string;
	token?: string;
	body?: unknown;
	contentType?: string;
	headers?: Record<string, string>;
};
const call = (path: string, init: CallInit = {}, target = app) =>
	target.handle(
		new Request(`http://localhost${path}`, {
			method: init.method ?? "GET",
			headers: {
				...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
				...(init.body !== undefined
					? { "content-type": init.contentType ?? "application/json" }
					: {}),
				...init.headers,
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);

type Scope = {
	user: string;
	workspace: string;
	seat: string;
	list: string;
	otherList: string;
	pat: string;
};
type Hook = { id: string; secret: string };

async function addUser(name: string) {
	const id = track(users, "user");
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[id, name, `${id}@example.test`],
	);
	return id;
}
async function addSeat(workspace: string, user: string, seatRole: string) {
	const id = track(memberships, "seat");
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,$4)",
		[id, user, workspace, seatRole],
	);
	return id;
}
async function addPat(user: string) {
	const pat = await createPersonalAccessToken(runtime, user, {
		name: "write",
		access: "write",
		expiresInDays: 30,
	});
	tokens.push(pat.id);
	return pat.token;
}
async function scope(): Promise<Scope> {
	const user = await addUser("Owner");
	const workspace = track(workspaces, "workspace");
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Shared',$2,'shared')",
		[workspace, user],
	);
	const seat = await addSeat(workspace, user, "owner");
	const list = track(lists, "list");
	const otherList = track(lists, "other_list");
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$3,$4,'Inbox','a0'),($2,$3,$4,'Other','a1')",
		[list, otherList, workspace, user],
	);
	return { user, workspace, seat, list, otherList, pat: await addPat(user) };
}
async function createHook(s: Scope, listId = s.list, token = s.pat) {
	const response = await call("/api/v1/webhooks", {
		method: "POST",
		token,
		body: { name: "Inbound", listId },
	});
	expect(response.status).toBe(201);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const hook = (await response.json()).data as Hook;
	hooks.push(hook.id);
	return hook;
}
async function deliverTo(
	target: typeof app,
	hook: Hook,
	body: unknown = { deliveryId: randomUUID(), title: "From webhook" },
	id = hook.id,
) {
	const response = await call(
		`/api/v1/webhooks/${id}/deliveries`,
		{ method: "POST", token: hook.secret, body },
		target,
	);
	const json = response.status < 300 ? await response.json() : null;
	if (json?.data?.id) tasks.push(json.data.id);
	return {
		status: response.status,
		data: json?.data,
		message: response.status >= 400 ? await response.text() : "",
	};
}
const deliver = (hook: Hook, body?: unknown, id?: string) =>
	deliverTo(app, hook, body, id);
// Explicit, bounded: one retry of the same request after a temporary 503.
async function deliverRetry(hook: Hook, body: unknown) {
	const first = await deliver(hook, body);
	return first.status === 503 ? deliver(hook, body) : first;
}
const taskCount = async (listId: string) =>
	Number(
		(await admin.query("select count(*) from task where list_id=$1", [listId]))
			.rows[0].count,
	);
const receipts = async (user: string) =>
	Number(
		(
			await admin.query(
				"select count(*) from public_api_request where user_id=$1",
				[user],
			)
		).rows[0].count,
	);
async function patCreate(s: Scope, key: string, target = app) {
	const response = await target.handle(
		new Request("http://localhost/api/v1/tasks", {
			method: "POST",
			headers: {
				authorization: `Bearer ${s.pat}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			body: JSON.stringify({ listId: s.list, title: "Via PAT" }),
		}),
	);
	const json = response.status < 300 ? await response.json() : null;
	if (typeof json?.data?.id === "string") tasks.push(json.data.id);
	return response.status;
}
const state = (error: unknown) =>
	(error as { code?: string }).code ?? "unknown";
async function failure(work: Promise<unknown>) {
	try {
		await work;
	} catch (error) {
		return state(error);
	}
	return "none";
}
// Runtime-role transaction with explicit RLS context; always rolled back.
async function inContext<T>(
	userId: string | null,
	hash: string | null,
	run: (client: PoolClient) => Promise<T>,
) {
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query(
			"select set_config('ditero.user_id',$1,true),set_config('ditero.webhook_hash',$2,true)",
			[userId ?? "", hash ?? ""],
		);
		return await run(client);
	} finally {
		await client.query("rollback").catch(() => undefined);
		client.release();
	}
}
const visible = (client: PoolClient, id: string) =>
	client
		.query("select id from inbound_webhook where id=$1", [id])
		.then((r) => r.rowCount);
const insertHook = (
	client: PoolClient,
	s: Scope,
	owner: string,
	hash = sha256(randomBytes(32).toString("hex")),
) =>
	client.query(
		"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,'Probe',$5,'abcd',statement_timestamp(),statement_timestamp()+interval '1 day')",
		[track(hooks, "hook"), owner, s.list, s.workspace, hash],
	);

// Holds the user row lock on an exact runtime-role connection.
async function holdUser(userId: string) {
	const client = await runtime.connect();
	let open = false;
	try {
		await client.query("begin");
		open = true;
		await client.query("select set_config('ditero.user_id',$1,true)", [userId]);
		await client.query('select id from "user" where id=$1 for update', [
			userId,
		]);
		const pid = (await client.query("select pg_backend_pid() as pid")).rows[0]
			.pid as number;
		return {
			client,
			pid,
			async end(commit: boolean) {
				if (!open) return;
				open = false;
				try {
					await client.query(commit ? "commit" : "rollback");
				} finally {
					client.release();
				}
			},
		};
	} catch (error) {
		if (open) await client.query("rollback").catch(() => undefined);
		client.release();
		throw error;
	}
}
// Observable, bounded: some other runtime-role backend is blocked on a lock.
async function lockWaiter(holderPid: number, ms: number) {
	const end = Date.now() + ms;
	for (;;) {
		const waiting = await admin.query(
			"select count(*)::int as n from pg_stat_activity where application_name=$1 and pid<>$2 and wait_event_type='Lock'",
			[role, holderPid],
		);
		if (waiting.rows[0].n > 0) return true;
		if (Date.now() >= end) return false;
		await sleep(20);
	}
}

beforeAll(async () =>
	preserveCause(async () => {
		// Target guard, before anything is allocated.
		expect(
			(await admin.query("select current_database() as database")).rows[0]
				.database,
		).toBe(expectedDatabase);
		expect(
			(
				await admin.query(
					"select count(*)::int as count from drizzle.__drizzle_migrations",
				)
			).rows[0].count,
		).toBe(journal.entries.length);
		expect(
			(
				await admin.query(
					"select (rolsuper or rolcreaterole) as can_create_role,(rolsuper or rolbypassrls) as can_bypass_rls,(select count(*)::int from pg_roles where rolname=$1) as existing from pg_roles where rolname=current_user",
					[role],
				)
			).rows[0],
		).toEqual({ can_create_role: true, can_bypass_rls: true, existing: 0 });
		const statement = await admin.query<{ statement: string }>(
			"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
			[role, password],
		);
		roleCreated = true;
		await admin.query(statement.rows[0].statement);
		roleOid = (
			await admin.query<{ oid: string }>(
				"select oid::text as oid from pg_roles where rolname=$1",
				[role],
			)
		).rows[0].oid;
		schemaGranted = true;
		await admin.query(`grant usage on schema public to "${role}"`);
		tablesGranted = true;
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to "${role}"`,
		);
		expect(
			(
				await runtime.query(
					"select r.oid::text as oid,current_user,session_user,rolsuper,rolbypassrls,rolinherit,rolcanlogin,rolcreatedb,rolcreaterole,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned from pg_roles r where rolname=current_user",
				)
			).rows[0],
		).toEqual({
			oid: roleOid,
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
			rolinherit: false,
			rolcanlogin: true,
			rolcreatedb: false,
			rolcreaterole: false,
			memberships: 0,
			owned: 0,
		});
		expect(
			(
				await runtime.query(
					"select relrowsecurity,relforcerowsecurity from pg_class where oid='inbound_webhook'::regclass",
				)
			).rows[0],
		).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
		ready = true;
	}),
);

async function residue() {
	return (
		await admin.query(
			`select (select count(*)::int from "user" where id=any($1::text[])) users,
			(select count(*)::int from workspace where id=any($2::text[])) workspaces,
			(select count(*)::int from list where id=any($3::text[])) lists,
			(select count(*)::int from task where id=any($4::text[]) or list_id=any($3::text[])) tasks,
			(select count(*)::int from inbound_webhook where id=any($5::uuid[]) or user_id=any($1::text[])) hooks,
			(select count(*)::int from membership where id=any($6::text[]) or workspace_id=any($2::text[])) memberships,
			(select count(*)::int from personal_access_token where id=any($7::uuid[]) or user_id=any($1::text[])) tokens,
			(select count(*)::int from public_api_request where user_id=any($1::text[])) receipts`,
			[users, workspaces, lists, tasks, hooks, memberships, tokens],
		)
	).rows[0];
}

afterAll(async () => {
	const failures: unknown[] = [];
	// Each attempt is independent: one failure never skips the others.
	const step = async (operation: () => Promise<unknown>) => {
		try {
			await operation();
		} catch (error) {
			failures.push(error);
		}
	};
	await step(() =>
		Promise.race([
			runtime.end(),
			sleep(5_000).then(() => {
				throw new Error("Runtime pool did not close");
			}),
		]),
	);
	if (ready || users.length) {
		const owned = (sql: string, ids: string[], extra?: string[]) =>
			step(() => admin.query(sql, extra ? [ids, extra] : [ids]));
		// Exact allocated IDs only; no ownership-wide or global cleanup.
		await owned(
			"delete from public_api_request where user_id=any($1::text[])",
			users,
		);
		await owned("delete from task where id=any($1::text[])", tasks);
		await owned("delete from inbound_webhook where id=any($1::uuid[])", hooks);
		await owned(
			"delete from personal_access_token where id=any($1::uuid[])",
			tokens,
		);
		await owned("delete from list where id=any($1::text[])", lists);
		await owned("delete from membership where id=any($1::text[])", memberships);
		await owned("delete from workspace where id=any($1::text[])", workspaces);
		await owned('delete from "user" where id=any($1::text[])', users);
		await step(async () =>
			expect(await residue()).toEqual({
				users: 0,
				workspaces: 0,
				lists: 0,
				tasks: 0,
				hooks: 0,
				memberships: 0,
				tokens: 0,
				receipts: 0,
			}),
		);
	}
	if (roleCreated)
		await step(async () => {
			const found = await admin.query(
				"select oid::text as oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls from pg_roles where rolname=$1",
				[role],
			);
			if (found.rows.length === 0) return;
			// Identity check before touching a role this file did not prove it owns.
			expect(found.rows).toEqual([
				{
					oid: roleOid ?? found.rows[0].oid,
					rolname: role,
					rolcanlogin: true,
					rolsuper: false,
					rolcreatedb: false,
					rolcreaterole: false,
					rolinherit: false,
					rolbypassrls: false,
				},
			]);
			if (tablesGranted)
				await admin.query(
					`revoke select,insert,update,delete on all tables in schema public from "${role}"`,
				);
			if (schemaGranted)
				await admin.query(`revoke usage on schema public from "${role}"`);
			// Plain DROP ROLE refuses while any dependency remains.
			await admin.query(`drop role "${role}"`);
		});
	await step(async () =>
		expect(
			(
				await admin.query(
					"select (select count(*)::int from pg_roles where rolname=$1) roles,(select count(*)::int from pg_stat_activity where usename=$1) sessions",
					[role],
				)
			).rows[0],
		).toEqual({ roles: 0, sessions: 0 }),
	);
	await step(() =>
		Promise.race([
			admin.end(),
			sleep(5_000).then(() => {
				throw new Error("Admin pool did not close");
			}),
		]),
	);
	if (failures.length)
		throw new AggregateError([...causes, ...failures], "Harness cleanup", {
			cause: causes[0] ?? failures[0],
		});
});

test("RLS: owner and exact hash see a hook, everything else sees nothing", async () => {
	const s = await scope();
	const other = await addUser("Other");
	const hook = await createHook(s);
	const stored = await admin.query(
		"select secret_hash,hint from inbound_webhook where id=$1",
		[hook.id],
	);
	expect(stored.rows[0].secret_hash).toBe(sha256(hook.secret));
	noLeak(JSON.stringify(stored.rows), hook.secret);
	expect((await runtime.query("select id from inbound_webhook")).rowCount).toBe(
		0,
	);
	const seen = (userId: string | null, hash: string | null) =>
		inContext(userId, hash, (client) => visible(client, hook.id));
	expect(await seen(s.user, null)).toBe(1);
	expect(await seen(null, sha256(hook.secret))).toBe(1);
	expect(await seen(other, null)).toBe(0);
	expect(await seen(null, sha256(`${hook.secret}x`))).toBe(0);
	expect(await seen(null, null)).toBe(0);
	// The hash only authenticates reads; it never grants a write.
	expect(
		await inContext(
			null,
			sha256(hook.secret),
			async (client) =>
				(
					await client.query(
						"update inbound_webhook set revoked_at=statement_timestamp() where id=$1",
						[hook.id],
					)
				).rowCount,
		),
	).toBe(0);
});

test("DB guards: binding is immutable, revoke is once, inserts are scoped", async () => {
	const s = await scope();
	const other = await addUser("Other");
	const viewer = await addUser("Viewer");
	const viewerSeat = await addSeat(s.workspace, viewer, "viewer");
	expect(viewerSeat).toBeTruthy();
	const hook = await createHook(s);
	for (const [column, value] of [
		["name", "Renamed"],
		["list_id", s.otherList],
		["hint", "zzzz"],
		["expires_at", "2999-01-01T00:00:00Z"],
	] as const)
		expect(
			await inContext(s.user, null, (client) =>
				failure(
					client.query(`update inbound_webhook set ${column}=$2 where id=$1`, [
						hook.id,
						value,
					]),
				),
			),
		).toBe("23514");
	// Positive control: the first revocation is accepted, a second change is not.
	expect(
		await inContext(s.user, null, async (client) => {
			const first = await failure(
				client.query(
					"update inbound_webhook set revoked_at=statement_timestamp() where id=$1",
					[hook.id],
				),
			);
			const undo = await failure(
				client.query("update inbound_webhook set revoked_at=null where id=$1", [
					hook.id,
				]),
			);
			return { first, undo };
		}),
	).toEqual({ first: "none", undo: "23514" });
	expect(
		await inContext(s.user, null, (client) =>
			failure(insertHook(client, s, s.user)),
		),
	).toBe("none");
	expect(
		await inContext(s.user, null, (client) =>
			failure(insertHook(client, s, other)),
		),
	).toBe("42501");
	expect(
		await inContext(other, null, (client) =>
			failure(insertHook(client, s, other)),
		),
	).toBe("42501");
	expect(
		await inContext(viewer, null, (client) =>
			failure(insertHook(client, s, viewer)),
		),
	).toBe("42501");
});

test("management needs a write PAT, a writable role and a visible list", async () => {
	const s = await scope();
	const stranger = await addUser("Stranger");
	const strangerPat = await addPat(stranger);
	const hook = await createHook(s);
	const readPat = (
		await createPersonalAccessToken(runtime, s.user, {
			name: "read",
			access: "read",
			expiresInDays: 30,
		})
	).token;
	for (const token of [readPat, hook.secret, undefined]) {
		const response = await call("/api/v1/webhooks", {
			method: "POST",
			token,
			body: { name: "x", listId: s.list },
		});
		expect(response.status).toBe(token === readPat ? 403 : 401);
	}
	expect(
		(
			await call("/api/v1/webhooks", {
				method: "POST",
				token: strangerPat,
				body: { name: "x", listId: s.list },
			})
		).status,
	).toBe(404);
	const listing = await call("/api/v1/webhooks", { token: s.pat });
	noLeak(JSON.stringify(await listing.json()), hook.secret);
	await admin.query("update membership set role='viewer' where id=$1", [
		s.seat,
	]);
	expect(
		(
			await call("/api/v1/webhooks", {
				method: "POST",
				token: s.pat,
				body: { name: "x", listId: s.list },
			})
		).status,
	).toBe(403);
});

test("revoke is idempotent, owner-only and permanent", async () => {
	const s = await scope();
	const stranger = await addUser("Stranger");
	const strangerPat = await addPat(stranger);
	const hook = await createHook(s);
	const revoke = (token: string) =>
		call(`/api/v1/webhooks/${hook.id}`, { method: "DELETE", token });
	// Positive control first: the hook delivers until it is revoked.
	expect((await deliver(hook)).status).toBe(201);
	expect((await revoke(strangerPat)).status).toBe(404);
	expect((await deliver(hook)).status).toBe(201);
	expect((await revoke(s.pat)).status).toBe(200);
	expect((await revoke(s.pat)).status).toBe(200);
	expect((await deliver(hook)).status).toBe(401);
	const stamps = await admin.query(
		"select revoked_at is not null as revoked from inbound_webhook where id=$1",
		[hook.id],
	);
	expect(stamps.rows[0].revoked).toBe(true);
});

test("delivery rejects other credentials, ids, content and fields", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const before = await taskCount(s.list);
	const path = `/api/v1/webhooks/${hook.id}/deliveries`;
	const good = { deliveryId: randomUUID(), title: "x" };
	const status = async (init: CallInit, p = path) =>
		(await call(p, { method: "POST", ...init })).status;
	expect(await status({ token: s.pat, body: good })).toBe(401);
	expect(await status({ body: good })).toBe(401);
	// A session cookie is not a webhook credential.
	expect(
		await status({
			body: good,
			headers: { cookie: "better-auth.session_token=not-a-real-session" },
		}),
	).toBe(401);
	expect(
		await status(
			{ token: hook.secret, body: good },
			`/api/v1/webhooks/${randomUUID()}/deliveries`,
		),
	).toBe(401);
	expect(
		await status({ token: hook.secret, body: good, contentType: "text/plain" }),
	).toBe(415);
	expect(
		await status({
			token: hook.secret,
			body: { ...good, title: "x".repeat(5000) },
		}),
	).toBe(413);
	for (const extra of [
		{ listId: s.otherList },
		{ assigneeIds: [s.user] },
		{ labelIds: [] },
		{ parentId: "p" },
	])
		expect(
			await status({ token: hook.secret, body: { ...good, ...extra } }),
		).toBe(400);
	expect(await taskCount(s.list)).toBe(before);
	// Positive controls: the same hook accepts the credential, in any route-ID case.
	expect((await deliver(hook, good)).status).toBe(201);
	expect(
		(
			await deliver(
				hook,
				{ deliveryId: randomUUID(), title: "Upper" },
				hook.id.toUpperCase(),
			)
		).status,
	).toBe(201);
	expect(await taskCount(s.list)).toBe(before + 2);
});

test("replay: once, concurrent-safe, conflicts, no new receipts", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const second = await createHook(s);
	const deliveryId = randomUUID();
	const body = { deliveryId, title: "Once" };
	const before = await taskCount(s.list);
	const receiptsBefore = await receipts(s.user);
	// Two concurrent calls finish well inside the 1 s lock timeout.
	const pair = await Promise.all([
		deliverRetry(hook, body),
		deliverRetry(hook, body),
	]);
	expect(pair.map((r) => r.status).sort()).toEqual([200, 201]);
	expect(new Set(pair.map((r) => r.data.id)).size).toBe(1);
	expect(pair.map((r) => r.data.listId)).toEqual([s.list, s.list]);
	expect(await taskCount(s.list)).toBe(before + 1);
	expect(await receipts(s.user)).toBe(receiptsBefore + 1);
	expect((await deliver(hook, body)).status).toBe(200);
	expect(await receipts(s.user)).toBe(receiptsBefore + 1);
	expect((await deliver(hook, { ...body, title: "Changed" })).status).toBe(409);
	expect((await deliver(second, body)).status).toBe(409);
	expect(await taskCount(s.list)).toBe(before + 1);
	// The task-create endpoint cannot reuse the webhook's delivery ID, nor the reverse.
	expect(await patCreate(s, deliveryId)).toBe(409);
	const patKey = randomUUID();
	expect(await patCreate(s, patKey)).toBe(201);
	expect(
		(await deliver(hook, { deliveryId: patKey, title: "Via PAT" })).status,
	).toBe(409);
});

test("one delivery ID raced across two hooks creates exactly one task", async () => {
	const s = await scope();
	const first = await createHook(s);
	const second = await createHook(s);
	const body = { deliveryId: randomUUID(), title: "Race" };
	const before = await taskCount(s.list);
	const results = await Promise.all([
		deliverRetry(first, body),
		deliverRetry(second, body),
	]);
	expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
	expect(await taskCount(s.list)).toBe(before + 1);
});

test("replays are refused after demotion, list move, deletion, removal and account deletion", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const body = { deliveryId: randomUUID(), title: "Gone soon" };
	const created = await deliver(hook, body);
	expect(created.status).toBe(201);
	expect((await deliver(hook, body)).status).toBe(200);

	await admin.query("update membership set role='viewer' where id=$1", [
		s.seat,
	]);
	expect((await deliver(hook, body)).status).toBe(403);
	await admin.query("update membership set role='owner' where id=$1", [s.seat]);
	expect((await deliver(hook, body)).status).toBe(200);

	// A moved task is gone for this webhook; the response never names where it went.
	await admin.query("update task set list_id=$2 where id=$1", [
		created.data.id,
		s.otherList,
	]);
	const moved = await deliver(hook, body);
	expect(moved.status).toBe(410);
	expect(moved.message).not.toContain(s.otherList);
	await admin.query("update task set list_id=$2 where id=$1", [
		created.data.id,
		s.list,
	]);
	expect((await deliver(hook, body)).status).toBe(200);
	await admin.query("delete from task where id=$1", [created.data.id]);
	expect((await deliver(hook, body)).status).toBe(410);

	// Membership removal: 404 for the hook owner's lost seat.
	await admin.query("delete from membership where id=$1", [s.seat]);
	expect((await deliver(hook, body)).status).toBe(404);
	await addSeat(s.workspace, s.user, "owner");

	// Deleting the list cascades the hook away.
	await admin.query("delete from task where list_id=$1", [s.list]);
	await admin.query("delete from list where id=$1", [s.list]);
	expect((await deliver(hook, body)).status).toBe(401);
});

test("account deletion removes the account's webhooks and nothing else", async () => {
	const s = await scope();
	const deleter = await addUser("Leaver");
	await addSeat(s.workspace, deleter, "member");
	const deleterPat = await addPat(deleter);
	const mine = await createHook(s, s.list, deleterPat);
	const kept = await createHook(s);
	const body = { deliveryId: randomUUID(), title: "Before deletion" };
	expect((await deliver(mine, body)).status).toBe(201);
	expect(await receipts(deleter)).toBe(1);
	const guards: Guards = {
		foreignOrigin: () => false,
		guardedPost:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: deleter } } as never),
		guardedGet:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: deleter } } as never),
	};
	const response = await new Elysia()
		.use(accountDeletionRoutes(runtime, guards))
		.handle(
			new Request("http://localhost/api/account/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ acknowledgeKeyLoss: true }),
			}),
		);
	expect(response.status).toBe(200);
	const after = await admin.query(
		"select (select count(*)::int from inbound_webhook where user_id=$1) mine,(select count(*)::int from inbound_webhook where user_id=$2) kept",
		[deleter, s.user],
	);
	expect(after.rows[0]).toEqual({ mine: 0, kept: 1 });
	expect(await receipts(deleter)).toBe(0);
	expect((await deliver(mine, body)).status).toBe(401);
	expect((await deliver(kept)).status).toBe(201);
});

test("expiry: a fixed expired hook and a hook that expires after a receipt both refuse", async () => {
	const s = await scope();
	const fixed = {
		id: track(hooks, "hook"),
		secret: `${WEBHOOK_PREFIX}${randomBytes(32).toString("base64url")}`,
	};
	await admin.query(
		"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,'Expired',$5,'abcd','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z')",
		[fixed.id, s.user, s.list, s.workspace, sha256(fixed.secret)],
	);
	const before = await taskCount(s.list);
	expect((await deliver(fixed)).status).toBe(401);
	expect(await taskCount(s.list)).toBe(before);
	expect(await receipts(s.user)).toBe(0);

	const brief = {
		id: track(hooks, "hook"),
		secret: `${WEBHOOK_PREFIX}${randomBytes(32).toString("base64url")}`,
	};
	await admin.query(
		"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,'Brief',$5,'abcd',statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1500 milliseconds')",
		[brief.id, s.user, s.list, s.workspace, sha256(brief.secret)],
	);
	const body = { deliveryId: randomUUID(), title: "Before expiry" };
	expect((await deliver(brief, body)).status).toBe(201);
	expect(await receipts(s.user)).toBe(1);
	// Bounded wait on the database clock, no guessed sleep length.
	const deadline = Date.now() + 5_000;
	for (;;) {
		const expired = await admin.query(
			"select statement_timestamp()>expires_at as expired from inbound_webhook where id=$1",
			[brief.id],
		);
		if (expired.rows[0].expired) break;
		if (Date.now() >= deadline) throw new Error("Hook did not expire in time");
		await sleep(50);
	}
	expect((await deliver(brief, body)).status).toBe(401);
	expect(await receipts(s.user)).toBe(1);
	expect(await taskCount(s.list)).toBe(before + 1);
});

test("a revocation committed while a delivery waits on the user lock wins", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const before = await taskCount(s.list);
	const held = await holdUser(s.user);
	const pending = deliver(hook);
	try {
		// The delivery already read the hook as valid; it is now blocked on the user row.
		expect(await lockWaiter(held.pid, 700)).toBe(true);
		await held.client.query(
			"update inbound_webhook set revoked_at=statement_timestamp() where id=$1",
			[hook.id],
		);
		await held.end(true);
	} finally {
		await held.end(false);
	}
	expect((await pending).status).toBe(401);
	expect(await taskCount(s.list)).toBe(before);
});

test("a revoke that cannot take the user lock returns a temporary 503 and succeeds on retry", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const held = await holdUser(s.user);
	let blocked: number;
	try {
		blocked = (
			await call(`/api/v1/webhooks/${hook.id}`, {
				method: "DELETE",
				token: s.pat,
			})
		).status;
	} finally {
		await held.end(false);
	}
	expect(blocked).toBe(503);
	expect(
		(
			await call(`/api/v1/webhooks/${hook.id}`, {
				method: "DELETE",
				token: s.pat,
			})
		).status,
	).toBe(200);
});

test("events: delivery matches task create, and a replay emits nothing", async () => {
	const s = await scope();
	const hook = await createHook(s);
	const shape = (events: unknown[]) =>
		events.map((event) =>
			Object.keys(event as object)
				.filter((key) => key !== "stamp")
				.sort()
				.join(","),
		);
	collected.length = 0;
	expect(await patCreate(s, randomUUID(), eventApp)).toBe(201);
	const viaPat = collected.flat();
	collected.length = 0;
	const body = { deliveryId: randomUUID(), title: "Events" };
	expect((await deliverTo(eventApp, hook, body)).status).toBe(201);
	expect(shape(collected.flat())).toEqual(shape(viaPat));
	const afterCreate = collected.length;
	expect((await deliverTo(eventApp, hook, body)).status).toBe(200);
	expect(collected.length).toBe(afterCreate);
});

test("the active webhook cap is 20 per account under serial creation", async () => {
	const s = await scope();
	const statuses: number[] = [];
	for (let index = 0; index < 22; index++) {
		const response = await call("/api/v1/webhooks", {
			method: "POST",
			token: s.pat,
			body: { name: "cap", listId: s.list },
		});
		if (response.status === 201) hooks.push((await response.json()).data.id);
		statuses.push(response.status);
	}
	expect(statuses.filter((status) => status === 201)).toHaveLength(20);
	expect(statuses.filter((status) => status === 409)).toHaveLength(2);
});
