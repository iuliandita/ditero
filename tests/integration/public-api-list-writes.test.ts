import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import { apiListCreationAckSchema } from "../../src/domain/public-api-list-create.ts";
import {
	canonicalApiTaskCreate,
	parseApiTaskCreate,
} from "../../src/domain/public-api-writes.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `list_write_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`;
const password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const alice = `${prefix}_alice`;
const bob = `${prefix}_bob`;
const outsider = `${prefix}_outsider`;
const workspace = `${prefix}_workspace`;
const hidden = `${prefix}_hidden`;
const taskList = `${prefix}_tasks`;
const task = `${prefix}_task`;
const body = { workspaceId: workspace, title: "Groceries", kind: "shopping" };
let token: string;
let tokenId: string;
let bobToken: string;
let createdRole = false;

async function cleanupData() {
	await admin.query(
		"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
		[[workspace, hidden]],
	);
	await admin.query("delete from list where workspace_id=any($1::text[])", [
		[workspace, hidden],
	]);
	await admin.query(
		"delete from membership where workspace_id=any($1::text[])",
		[[workspace, hidden]],
	);
	await admin.query("delete from workspace where id=any($1::text[])", [
		[workspace, hidden],
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [
		[alice, bob, outsider],
	]);
}

beforeAll(async () => {
	const statement = await admin.query<{ statement: string }>(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls', $1::text, $2::text) as statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	createdRole = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	const identity = await runtime.query(
		"select current_user,session_user,rolsuper,rolbypassrls,rolcanlogin,(select count(*)::int from pg_auth_members where member=r.oid) as memberships from pg_roles r where rolname=current_user",
	);
	expect(identity.rows[0]).toEqual({
		current_user: role,
		session_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolcanlogin: true,
		memberships: 0,
	});
	expect(
		(
			await runtime.query(
				"select relrowsecurity,relforcerowsecurity from pg_class where oid='public_api_request'::regclass",
			)
		).rows[0],
	).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
});

beforeEach(async () => {
	await cleanupData();
	for (const id of [alice, bob, outsider])
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
			[id, `${id}@example.test`],
		);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Home',$2,'shared'),($3,'Other',$4,'shared')",
		[workspace, alice, hidden, outsider],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner'),($4,$5,$3,'member'),($6,$7,$8,'owner')",
		[
			`${prefix}_owner`,
			alice,
			workspace,
			`${prefix}_member`,
			bob,
			`${prefix}_other`,
			outsider,
			hidden,
		],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[taskList, workspace, alice],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Task','a0')",
		[task, taskList],
	);
	const pat = await createPersonalAccessToken(runtime, alice, {
		name: "list writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
	bobToken = (
		await createPersonalAccessToken(runtime, bob, {
			name: "list writer",
			access: "write",
		})
	).token;
});

afterAll(async () => {
	try {
		await cleanupData();
	} finally {
		await runtime.end();
		try {
			if (createdRole) {
				await admin.query(`drop owned by "${role}"`);
				await admin.query(`drop role "${role}"`);
			}
			expect(
				(
					await admin.query(
						"select count(*)::int as count from pg_roles where rolname=$1",
						[role],
					)
				).rows[0].count,
			).toBe(0);
			expect(
				(
					await admin.query(
						"select count(*)::int as count from pg_stat_activity where usename=$1",
						[role],
					)
				).rows[0].count,
			).toBe(0);
		} finally {
			await admin.end();
		}
	}
});

function send(
	path: string,
	method: string,
	input?: unknown,
	key: string = randomUUID(),
	secret = token,
) {
	return app.handle(
		new Request(`http://localhost/api/v1/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
		}),
	);
}
const request = (
	input: unknown = body,
	key: string = randomUUID(),
	secret = token,
) => send("lists", "POST", input, key, secret);
async function snapshot(response: Response) {
	const envelope = await response.json();
	expect(envelope).toMatchObject({ version: 1, nextCursor: null });
	return apiListCreationAckSchema.parse(envelope.data).snapshot;
}
async function counts() {
	return (
		await admin.query(
			"select (select count(*)::int from list where workspace_id=$1 and id<>$2) as lists,(select count(*)::int from public_api_request where user_id=any($3::text[])) as receipts",
			[workspace, taskList, [alice, bob]],
		)
	).rows[0];
}

test("creates all five list kinds with server-owned defaults and no implicit content or access", async () => {
	for (const kind of ["tasks", "shopping", "checklist", "project", "habits"]) {
		const response = await request({ ...body, title: " Groceries ", kind });
		expect(response.status).toBe(201);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const row = await snapshot(response);
		expect(row).toMatchObject({
			workspaceId: workspace,
			ownerId: alice,
			title: "Groceries",
			kind,
			icon: null,
			folderId: null,
			completedDisplay: "sink",
		});
		expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(row.sortKey > "a0").toBe(true);
	}
	expect(await counts()).toEqual({ lists: 5, receipts: 5 });
	expect(
		(
			await admin.query(
				"select count(*)::int as count from task where list_id in(select id from list where workspace_id=$1)",
				[workspace],
			)
		).rows[0].count,
	).toBe(1);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from membership where workspace_id=$1",
				[workspace],
			)
		).rows[0].count,
	).toBe(2);
});

test("same-key concurrency and normalized retry return one identical original snapshot", async () => {
	const key = randomUUID();
	const responses = await Promise.all([
		request({ ...body, title: " Groceries " }, key),
		request({ ...body, icon: null }, key),
	]);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
	const rows = await Promise.all(responses.map(snapshot));
	expect(rows[0]).toEqual(rows[1]);
	expect(await counts()).toEqual({ lists: 1, receipts: 1 });
	expect((await request({ ...body, icon: "cart" }, key)).status).toBe(409);
	expect((await request({ ...body, title: "Different" }, key)).status).toBe(
		409,
	);
});

test("different accounts serialize API append positions and may reuse a request UUID", async () => {
	const key = randomUUID();
	const responses = await Promise.all([
		request(body, key),
		request(body, key, bobToken),
	]);
	expect(responses.map((r) => r.status)).toEqual([201, 201]);
	const rows = await Promise.all(responses.map(snapshot));
	expect(new Set(rows.map((r) => r.id)).size).toBe(2);
	expect(new Set(rows.map((r) => r.sortKey)).size).toBe(2);
	expect(rows.map((r) => r.ownerId).sort()).toEqual([alice, bob].sort());
	expect(await counts()).toEqual({ lists: 2, receipts: 2 });
});

test("a committed response lost on the wire can be retried without duplicate creation", async () => {
	const key = randomUUID();
	let committed = false;
	const server = createServer(async (_incoming, outgoing) => {
		const response = await request(body, key);
		expect(response.status).toBe(201);
		await response.arrayBuffer();
		committed = true;
		outgoing.destroy();
	});
	try {
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Expected loopback listener");
		await expect(
			fetch(`http://127.0.0.1:${address.port}`, { method: "POST" }),
		).rejects.toThrow();
		expect(committed).toBe(true);
		expect((await request(body, key)).status).toBe(200);
		expect(await counts()).toEqual({ lists: 1, receipts: 1 });
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("replay preserves the original snapshot after edits, deletion and recreation in another workspace", async () => {
	const key = randomUUID();
	const original = await snapshot(await request(body, key));
	await admin.query("update list set title='Edited',icon='star' where id=$1", [
		original.id,
	]);
	expect(await snapshot(await request(body, key))).toEqual(original);
	await admin.query("delete from list where id=$1", [original.id]);
	const deleted = await request(body, key);
	expect(deleted.status).toBe(200);
	expect(await snapshot(deleted)).toEqual(original);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Replacement','a0')",
		[original.id, hidden, outsider],
	);
	expect(await snapshot(await request(body, key))).toEqual(original);
	expect((await send(`lists/${original.id}`, "GET")).status).toBe(404);
	expect(
		(
			await admin.query("select title,workspace_id from list where id=$1", [
				original.id,
			])
		).rows[0],
	).toEqual({ title: "Replacement", workspace_id: hidden });
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[alice, workspace],
	);
	expect((await request(body, key)).status).toBe(404);
});

test("current writable original-workspace authority and live write PAT are required on fresh requests and replay", async () => {
	const key = randomUUID();
	expect((await request(body, key, bobToken)).status).toBe(201);
	for (const writable of ["owner", "admin", "member"]) {
		await admin.query(
			"update membership set role=$1 where user_id=$2 and workspace_id=$3",
			[writable, bob, workspace],
		);
		expect((await request(body, key, bobToken)).status).toBe(200);
	}
	await admin.query(
		"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
		[bob, workspace],
	);
	expect((await request(body, key, bobToken)).status).toBe(403);
	expect((await request(body, randomUUID(), bobToken)).status).toBe(403);
	expect((await request({ ...body, workspaceId: hidden })).status).toBe(404);
	const read = (
		await createPersonalAccessToken(runtime, alice, { name: "reader" })
	).token;
	expect((await request(body, randomUUID(), read)).status).toBe(403);
	const aliceKey = randomUUID();
	expect((await request(body, aliceKey)).status).toBe(201);
	await revokePersonalAccessToken(runtime, alice, tokenId);
	expect((await request(body, aliceKey)).status).toBe(401);
	expect((await request()).status).toBe(401);
});

test.each([
	"create",
	"complete",
	"update",
	"delete",
])("list and task %s share account-wide request keys in both directions", async (operation) => {
	async function taskRequest(key: string) {
		if (operation === "create")
			return send("tasks", "POST", { listId: taskList, title: "Created" }, key);
		if (operation === "complete")
			return send(
				`tasks/${task}/complete`,
				"POST",
				{ listId: taskList, expectedDueAt: null },
				key,
			);
		const observation = await (
			await send(
				`tasks/${task}/${operation === "delete" ? "deletion-observation" : "observation"}`,
				"GET",
			)
		).json();
		if (operation === "update")
			return send(
				`tasks/${task}`,
				"PATCH",
				{
					listId: taskList,
					expectedState: observation.data.stateToken,
					patch: { title: "Changed" },
				},
				key,
			);
		return send(
			`tasks/${task}`,
			"DELETE",
			{
				listId: taskList,
				expectedState: observation.data.stateToken,
				expectedChildrenState: observation.data.childrenState,
				cascadeChildren: false,
			},
			key,
		);
	}
	const listKey = randomUUID();
	expect((await request(body, listKey)).status).toBe(201);
	expect((await taskRequest(listKey)).status).toBe(409);
	const taskKey = randomUUID();
	expect((await taskRequest(taskKey)).status).toBe(
		operation === "create" ? 201 : 200,
	);
	expect((await request(body, taskKey)).status).toBe(409);
	expect((await counts()).lists).toBe(1);
	const receipts = await admin.query(
		"select resource_kind from public_api_request where user_id=$1 order by resource_kind",
		[alice],
	);
	expect(receipts.rows.map((r) => r.resource_kind)).toEqual(["list", "task"]);
});

test("strict route bounds reject invalid inputs without storing lists or receipts", async () => {
	for (const input of [
		{ ...body, ownerId: alice },
		{ ...body, kind: "unknown" },
		{ ...body, icon: "x".repeat(129) },
		{ ...body, title: "bad\u0000title" },
	])
		expect((await request(input)).status).toBe(400);
	expect((await request(body, "not-a-uuid")).status).toBe(400);
	expect((await send("lists?limit=1", "POST", body)).status).toBe(400);
	expect((await request({ ...body, extra: "x".repeat(4096) })).status).toBe(
		413,
	);
	for (const [bytes, type, status] of [
		[new Uint8Array([123, 255, 125]), "application/json", 400],
		[JSON.stringify(body), "text/plain", 415],
	] as const) {
		const response = await app.handle(
			new Request("http://localhost/api/v1/lists", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": type,
					"idempotency-key": randomUUID(),
				},
				body: bytes,
			}),
		);
		expect(response.status).toBe(status);
	}
	expect(await counts()).toEqual({ lists: 0, receipts: 0 });
});

test("restricted receipts enforce owner RLS, deny snapshot updates and reject invalid union shapes", async () => {
	const original = await snapshot(await request());
	expect(
		(
			await withUserContext(runtime, bob, (client) =>
				client.query("select * from public_api_request"),
			)
		).rows,
	).toEqual([]);
	await expect(
		withUserContext(runtime, bob, (client) =>
			client.query(
				"insert into public_api_request(user_id,request_id,request_hash,task_id) values($1,$2,'hash','task')",
				[alice, randomUUID()],
			),
		),
	).rejects.toThrow();
	const update = await withUserContext(runtime, alice, (client) =>
		client.query(
			"update public_api_request set list_snapshot='{}'::jsonb where list_id=$1",
			[original.id],
		),
	);
	expect(update.rowCount).toBe(0);
	for (const [kind, taskId, listId, data] of [
		["unknown", task, null, null],
		["task", null, null, null],
		["task", task, original.id, null],
		["list", task, original.id, original],
		["list", null, original.id, null],
		["list", null, original.id, {}],
		["list", null, original.id, { id: "wrong" }],
		["list", null, original.id, "null"],
	]) {
		await expect(
			withUserContext(runtime, alice, (client) =>
				client.query(
					"insert into public_api_request(user_id,request_id,request_hash,resource_kind,task_id,list_id,list_snapshot) values($1,$2,'hash',$3,$4,$5,$6::jsonb)",
					[
						alice,
						randomUUID(),
						kind,
						taskId,
						listId,
						data === "null"
							? "null"
							: data === null
								? null
								: JSON.stringify(data),
					],
				),
			),
		).rejects.toThrow();
	}
	await admin.query("delete from list where id=$1", [original.id]);
	expect((await counts()).receipts).toBe(1);
});

async function waitForRuntimeLock(queryPrefix: string) {
	const deadline = Date.now() + 750;
	while (Date.now() < deadline) {
		const waiting = await admin.query<{ count: number }>(
			"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2",
			[role, `${queryPrefix}%`],
		);
		if (waiting.rows[0].count === 1) return;
	}
	throw new Error("Expected the runtime request at its held authority lock");
}

test("membership removal committed while a request waits on workspace authority prevents creation", async () => {
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query("select id from workspace where id=$1 for update", [
			workspace,
		]);
		pending = request(body, randomUUID(), bobToken);
		await waitForRuntimeLock("select id from workspace");
		await holder.query(
			"delete from membership where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(404);
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test("pre-union task receipts inserted with old columns retain default kind and task replay", async () => {
	const input = { listId: taskList, title: "Existing request" };
	const key = randomUUID();
	const hash = createHash("sha256")
		.update(canonicalApiTaskCreate(parseApiTaskCreate(input)))
		.digest("hex");
	await withUserContext(runtime, alice, (client) =>
		client.query(
			"insert into public_api_request(user_id,request_id,request_hash,task_id) values($1,$2,$3,$4)",
			[alice, key, hash, task],
		),
	);
	const replay = await send("tasks", "POST", input, key);
	expect(replay.status).toBe(200);
	expect((await replay.json()).data.id).toBe(task);
	expect(
		(
			await admin.query(
				"select resource_kind,list_id,list_snapshot from public_api_request where user_id=$1 and request_id=$2",
				[alice, key],
			)
		).rows[0],
	).toEqual({ resource_kind: "task", list_id: null, list_snapshot: null });
	expect((await request(body, key)).status).toBe(409);
	expect(await counts()).toEqual({ lists: 0, receipts: 1 });
});

test("a malformed stored snapshot fails closed and a deleted account cannot replay", async () => {
	const key = randomUUID();
	const original = await snapshot(await request(body, key));
	await admin.query(
		"update public_api_request set list_snapshot=$1::jsonb where user_id=$2 and request_id=$3",
		[JSON.stringify({ ...original, title: 123 }), alice, key],
	);
	const refused = await request(body, key);
	expect(refused.status).toBe(500);
	expect(await refused.json()).toMatchObject({ code: "internal-error" });
	await admin.query('update "user" set deleted_at=now() where id=$1', [alice]);
	expect((await request(body, key)).status).toBe(401);
	expect((await counts()).lists).toBe(1);
});

test("membership downgrade committed at a held authority lock refuses the pending creation", async () => {
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query(
			"select id from membership where user_id=$1 and workspace_id=$2 for update",
			[bob, workspace],
		);
		pending = request(body, randomUUID(), bobToken);
		await waitForRuntimeLock("select role from membership");
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
		await holder.query(
			"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(403);
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test("PAT revocation committed before the held actor lock releases refuses a pending authenticated request", async () => {
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [alice]);
		pending = request();
		await waitForRuntimeLock(
			'select id from "user" where id = $1 and deleted_at is null for update',
		);
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
		await holder.query(
			"update personal_access_token set revoked_at=statement_timestamp() where id=$1",
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test("expired PAT cannot replay a committed list acknowledgement or create another list", async () => {
	const key = randomUUID();
	expect((await request(body, key)).status).toBe(201);
	await admin.query(
		"update personal_access_token set created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' where id=$1",
		[tokenId],
	);
	expect((await request(body, key)).status).toBe(401);
	expect((await request()).status).toBe(401);
	expect(await counts()).toEqual({ lists: 1, receipts: 1 });
});

test("receipt insertion failure after a proven native list insert rolls the whole transaction back", async () => {
	const key = randomUUID();
	const sequence = `${prefix}_insert_proof`;
	const trigger = `${prefix}_receipt_failure`;
	const fn = `${prefix}_receipt_failure_fn`;
	let sequenceCreated = false;
	let functionCreated = false;
	let triggerCreated = false;
	try {
		await admin.query(`create sequence "${sequence}"`);
		sequenceCreated = true;
		await admin.query(`grant usage on sequence "${sequence}" to "${role}"`);
		await admin.query(`create function "${fn}"() returns trigger language plpgsql as $fixture$
		begin
			if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then
				if new.resource_kind<>'list' or not exists (
					select 1 from list where id=new.list_id and owner_id=new.user_id and workspace_id=TG_ARGV[2]
				) then raise exception 'fixture-list-not-inserted'; end if;
				perform nextval(TG_ARGV[3]::regclass);
				raise exception 'fixture-receipt-insertion-failed';
			end if;
			return new;
		end $fixture$`);
		functionCreated = true;
		const statement = await admin.query<{ statement: string }>(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)', $1::text,$2::text,$3::text,$4::text,$5::text,$6::text) as statement",
			[trigger, fn, alice, key, workspace, sequence],
		);
		await admin.query(statement.rows[0].statement);
		triggerCreated = true;
		expect(
			(await admin.query(`select is_called from "${sequence}"`)).rows[0]
				.is_called,
		).toBe(false);
		const failed = await request(body, key);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({ code: "internal-error" });
		// Sequence advancement survives rollback and occurs only after the trigger sees the inserted list.
		expect(
			(await admin.query(`select last_value::int,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: 1, is_called: true });
		expect(await counts()).toEqual({ lists: 0, receipts: 0 });
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		triggerCreated = false;
		expect((await request(body, key)).status).toBe(201);
		expect(await counts()).toEqual({ lists: 1, receipts: 1 });
	} finally {
		if (triggerCreated)
			await admin.query(`drop trigger "${trigger}" on public_api_request`);
		if (functionCreated) await admin.query(`drop function "${fn}"()`);
		if (sequenceCreated) await admin.query(`drop sequence "${sequence}"`);
	}
});
