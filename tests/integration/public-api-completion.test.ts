import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `api_complete_test_${randomUUID().replaceAll("-", "")}`;
const runtime = new Pool({
	connectionString: databaseURL,
	application_name: role,
});
runtime.on("connect", (client) => {
	void client.query(`set role "${role}"`);
});
const app = publicApiRoutes(runtime, async () => true);
let token: string;
const taskId = "complete-task";
const body = { listId: "complete-list", expectedDueAt: null };
beforeAll(async () => {
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({ rolsuper: false, rolbypassrls: false });
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user" (id,name,email,email_verified) values ('complete-alice','Alice','alice@complete.test',true),('complete-viewer','Viewer','viewer@complete.test',true)`,
	);
	await admin.query(
		`insert into workspace (id,name,owner_id,kind) values ('complete-workspace','Home','complete-alice','shared')`,
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values ('complete-owner','complete-alice','complete-workspace','owner'),('complete-view','complete-viewer','complete-workspace','viewer')`,
	);
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,sort_key) values ('complete-list','complete-workspace','complete-alice','Tasks','a0')`,
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key) values ('complete-task','complete-list','Task','a0')`,
	);
	token = (
		await createPersonalAccessToken(runtime, "complete-alice", {
			name: "writer",
			access: "write",
		})
	).token;
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
function request(
	input: unknown = body,
	key: string | null = randomUUID(),
	secret = token,
	suffix = "",
) {
	const headers = new Headers({
		authorization: `Bearer ${secret}`,
		"content-type": "application/json",
	});
	if (key !== null) headers.set("idempotency-key", key);
	return app.handle(
		new Request(`http://localhost/api/v1/tasks/${taskId}/complete${suffix}`, {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		}),
	);
}
async function counts() {
	return (
		await admin.query(
			"select (select count(*)::int from task_completion_event) as history,(select count(*)::int from karma_event) as karma,(select count(*)::int from public_api_request) as receipts",
		)
	).rows[0];
}
test("completion commits native history, karma and owner receipt once", async () => {
	const key = randomUUID();
	const response = await request(body, key);
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({
		data: { id: taskId, done: true },
	});
	expect(await counts()).toEqual({ history: 1, karma: 1, receipts: 1 });
	expect((await request(body, key)).status).toBe(200);
	expect(await counts()).toEqual({ history: 1, karma: 1, receipts: 1 });
	expect((await request()).status).toBe(200);
	expect(await counts()).toEqual({ history: 1, karma: 1, receipts: 2 });
});
test("recurring replay cannot advance another occurrence and stale observations refuse", async () => {
	const due = "2026-10-04T12:00:00.000Z";
	await admin.query(
		"update task set due_at=$1,rrule='FREQ=DAILY' where id=$2",
		[due, taskId],
	);
	const input = { ...body, expectedDueAt: due };
	const key = randomUUID();
	expect((await request(input, key)).status).toBe(200);
	const next = (
		await admin.query("select due_at from task where id=$1", [taskId])
	).rows[0].due_at.toISOString();
	expect(next).not.toBe(due);
	expect((await request(input, key)).status).toBe(200);
	expect((await request(input)).status).toBe(409);
	expect(await counts()).toEqual({ history: 1, karma: 1, receipts: 1 });
	expect((await request({ ...body, expectedDueAt: next })).status).toBe(200);
	expect(await counts()).toEqual({ history: 2, karma: 2, receipts: 2 });
});
test("write authority never follows a read token or viewer membership", async () => {
	const read = (
		await createPersonalAccessToken(runtime, "complete-alice", {
			name: "read",
			access: "read",
		})
	).token;
	const viewer = (
		await createPersonalAccessToken(runtime, "complete-viewer", {
			name: "viewer",
			access: "write",
		})
	).token;
	expect((await request(body, randomUUID(), read)).status).toBe(403);
	expect((await request(body, randomUUID(), viewer)).status).toBe(403);
	await admin.query("delete from membership where user_id='complete-alice'");
	expect((await request()).status).toBe(404);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
});
test("habits require their occurrence workflow", async () => {
	await admin.query("update list set kind='habits' where id=$1", [body.listId]);
	expect((await request()).status).toBe(400);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
});
test.each([
	{},
	{ listId: body.listId },
	{ ...body, expectedDueAt: "tomorrow" },
	{ ...body, done: true },
	{ ...body, listId: "" },
	{ ...body, expectedDueAt: 4 },
])("strict observed completion refuses invalid input %j", async (input) => {
	expect((await request(input)).status).toBe(400);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
});
test("keys bind operation and canonical due instant", async () => {
	const key = randomUUID();
	expect((await request(body, key)).status).toBe(200);
	expect(
		(await request({ ...body, expectedDueAt: "2026-10-04T12:00:00Z" }, key))
			.status,
	).toBe(409);
	const created = await app.handle(
		new Request("http://localhost/api/v1/tasks", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			body: JSON.stringify({ listId: body.listId, title: "Other" }),
		}),
	);
	expect(created.status).toBe(409);
	expect(await counts()).toEqual({ history: 1, karma: 1, receipts: 1 });
});
test("retained receipt cannot resurrect a deleted task or disclose revoked content", async () => {
	const key = randomUUID();
	expect((await request(body, key)).status).toBe(200);
	await admin.query("delete from task where id=$1", [taskId]);
	expect((await request(body, key)).status).toBe(410);
	await admin.query("delete from membership where user_id='complete-alice'");
	expect((await request(body, key)).status).toBe(404);
	expect(
		(await admin.query("select count(*)::int as count from task")).rows[0]
			.count,
	).toBe(0);
});
test("list moves and changed due instants refuse before effects", async () => {
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ('complete-moved','complete-workspace','complete-alice','Moved','a1')",
	);
	await admin.query("update task set list_id='complete-moved' where id=$1", [
		taskId,
	]);
	expect((await request()).status).toBe(409);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
});
test("missing keys, query parameters and invalid credentials refuse", async () => {
	expect((await request(body, null)).status).toBe(400);
	expect((await request(body, randomUUID(), token, "?extra=1")).status).toBe(
		400,
	);
	expect(
		(await request(body, randomUUID(), `ditero_pat_${"a".repeat(43)}`)).status,
	).toBe(401);
	const [metadata] = await listPersonalAccessTokens(runtime, "complete-alice");
	await revokePersonalAccessToken(runtime, "complete-alice", metadata.id);
	expect((await request()).status).toBe(401);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
});

test("receipt failure rolls back completion, history and karma", async () => {
	await admin.query(
		"create function api_complete_reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture receipt failure'; end $$",
	);
	await admin.query(
		"create trigger api_complete_reject before insert on public_api_request for each row execute function api_complete_reject_receipt()",
	);
	try {
		expect((await request()).status).toBe(500);
		expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
		expect(
			(await admin.query("select done from task where id=$1", [taskId])).rows[0]
				.done,
		).toBe(false);
	} finally {
		await admin.query("drop trigger api_complete_reject on public_api_request");
		await admin.query("drop function api_complete_reject_receipt()");
	}
});
test("a membership granted after failed discovery cannot expand this request", async () => {
	const secret = (
		await createPersonalAccessToken(runtime, "complete-viewer", {
			name: "writer",
			access: "write",
		})
	).token;
	await admin.query("delete from membership where user_id='complete-viewer'");
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"complete-viewer",
		]);
		pending = request(body, randomUUID(), secret);
		let blocked = false;
		const deadline = Date.now() + 700;
		while (Date.now() < deadline) {
			const result = await admin.query(
				"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like 'select id from \"user\" where id = $1 and deleted_at is null for update%'",
				[role],
			);
			if (result.rows[0].count === 1) {
				blocked = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(blocked).toBe(true);
		await holder.query(
			"insert into membership(id,user_id,workspace_id,role) values ('complete-late','complete-viewer','complete-workspace','member')",
		);
		await holder.query("commit");
		expect((await pending).status).toBe(404);
		expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
		expect((await request(body, randomUUID(), secret)).status).toBe(200);
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test.each([
	"pending",
	"blocked",
])("activation %s refuses as expected state without effects", async (status) => {
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,$2,1)",
		[taskId, status],
	);
	const response = await request();
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "activation-pending" });
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
	expect(
		(await admin.query("select done from task where id=$1", [taskId])).rows[0]
			.done,
	).toBe(false);
});
