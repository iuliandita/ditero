import { randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `api_update_${randomUUID().replaceAll("-", "")}`;
const runtime = new Pool({
	connectionString: databaseURL,
	options: `-c role=${role}`,
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const zdb = zeroNodePg(schema, runtime);
let token: string;
let initial: string;
const taskId = "task";
const due = "2026-10-04T10:00:00.123Z";
const input = (patch: Record<string, unknown> = { title: "New" }) => ({
	listId: "list",
	expectedState: initial,
	patch,
});

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
		`insert into "user"(id,name,email,email_verified) values('owner','Owner','owner@update.test',true),('member','Member','member@update.test',true),('viewer','Viewer','viewer@update.test',true)`,
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('workspace','Shared','owner','shared')",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('owner-seat','owner','workspace','owner'),('member-seat','member','workspace','member'),('viewer-seat','viewer','workspace','viewer')",
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values('list','workspace','owner','Tasks','a0'),('moved','workspace','owner','Moved','a1')",
	);
	await admin.query(
		"insert into task(id,list_id,title,notes,due_at,priority,sort_key,created_at) values('task','list','Old','Keep',$1,1,'a0','2026-10-03T10:00:00.123Z')",
		[due],
	);
	token = (
		await createPersonalAccessToken(runtime, "member", {
			name: "writer",
			access: "write",
		})
	).token;
	initial = (await observation()).data.stateToken;
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
function get(secret = token, path = `/api/v1/tasks/${taskId}/observation`) {
	return app.handle(
		new Request(`http://localhost${path}`, {
			headers: { authorization: `Bearer ${secret}` },
		}),
	);
}
async function observation(secret = token) {
	const response = await get(secret);
	expect(response.status).toBe(200);
	return response.json();
}
function patch(
	body: unknown = input(),
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
		new Request(`http://localhost/api/v1/tasks/${taskId}${suffix}`, {
			method: "PATCH",
			headers,
			body: JSON.stringify(body),
		}),
	);
}
async function counts() {
	return (
		await admin.query(
			"select (select count(*)::int from public_api_request) receipts,(select count(*)::int from task_completion_event) history,(select count(*)::int from karma_event) karma",
		)
	).rows[0];
}
const noEffects = async () => {
	expect(await counts()).toEqual({ receipts: 0, history: 0, karma: 0 });
	expect(
		(
			await admin.query(
				"select title,notes,due_at,priority,done from task where id='task'",
			)
		).rows[0],
	).toEqual({
		title: "Old",
		notes: "Keep",
		due_at: new Date(due),
		priority: 1,
		done: false,
	});
};

test("observation is read-scoped, canonical milliseconds, and leaves the task DTO unchanged", async () => {
	const read = (
		await createPersonalAccessToken(runtime, "member", {
			name: "read",
			access: "read",
		})
	).token;
	const viewer = (
		await createPersonalAccessToken(runtime, "viewer", {
			name: "read",
			access: "read",
		})
	).token;
	const result = await observation(read);
	expect(result).toMatchObject({
		version: 1,
		nextCursor: null,
		data: {
			stateToken: initial,
			snapshot: {
				version: 1,
				taskId,
				listId: "list",
				dueAt: due,
				title: "Old",
				notes: "Keep",
				priority: 1,
				done: false,
				rrule: null,
			},
		},
	});
	expect((await observation(viewer)).data.stateToken).toBe(initial);
	expect(
		(await (await get(token, "/api/v1/tasks/task")).json()).data,
	).not.toHaveProperty("stateToken");
	expect(
		(await get(token, "/api/v1/tasks/task/observation?extra=1")).status,
	).toBe(400);
	await admin.query("update task set created_at=null where id='task'");
	const legacy = (await observation()).data;
	expect(legacy.snapshot.createdAt).toBeNull();
	expect(legacy.stateToken).not.toBe(initial);
	expect(await counts()).toEqual({ receipts: 0, history: 0, karma: 0 });
});

test("scalar update uses native milliseconds, preserves omissions and clears explicit nulls", async () => {
	const first = await patch(
		input({
			title: " New ",
			dueAt: "2026-10-05T12:00:00.456+02:00",
			dueAllDay: true,
		}),
	);
	expect(first.status).toBe(200);
	expect(await first.json()).toMatchObject({
		data: {
			title: "New",
			notes: "Keep",
			dueAt: "2026-10-05T10:00:00.456Z",
			dueAllDay: true,
			priority: 1,
			done: false,
		},
	});
	const observed = (await observation()).data;
	expect(observed.stateToken).not.toBe(initial);
	expect(
		(
			await patch({
				...input({ notes: null, dueAt: null, dueAllDay: false }),
				expectedState: observed.stateToken,
			})
		).status,
	).toBe(200);
	expect(
		(await (await get(token, "/api/v1/tasks/task")).json()).data,
	).toMatchObject({
		title: "New",
		notes: null,
		dueAt: null,
		dueAllDay: false,
		priority: 1,
	});
	expect(await counts()).toEqual({ receipts: 2, history: 0, karma: 0 });
});

test("same-key replay does not overwrite a later edit and rejects changed or cross-operation payloads", async () => {
	const key = randomUUID();
	expect((await patch(input(), key)).status).toBe(200);
	await admin.query("update task set title='Later' where id='task'");
	const replay = await patch(input(), key);
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({ data: { title: "Later" } });
	expect((await patch(input({ title: "Different" }), key)).status).toBe(409);
	for (const [path, body] of [
		["/api/v1/tasks", { listId: "list", title: "Create" }],
		["/api/v1/tasks/task/complete", { listId: "list", expectedDueAt: due }],
	] as const) {
		const result = await app.handle(
			new Request(`http://localhost${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"idempotency-key": key,
				},
				body: JSON.stringify(body),
			}),
		);
		expect(result.status).toBe(409);
		expect(await result.json()).toMatchObject({ code: "idempotency-conflict" });
	}
	expect(await counts()).toEqual({ receipts: 1, history: 0, karma: 0 });
});

test("concurrent same-key updates commit once and different keys with stale observations refuse", async () => {
	const key = randomUUID();
	expect(
		(await Promise.all([patch(input(), key), patch(input(), key)])).map(
			(r) => r.status,
		),
	).toEqual([200, 200]);
	expect(await counts()).toEqual({ receipts: 1, history: 0, karma: 0 });
	initial = (await observation()).data.stateToken;
	const results = await Promise.all([
		patch(input({ title: "A" })),
		patch(input({ title: "B" })),
	]);
	expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(await counts()).toEqual({ receipts: 2, history: 0, karma: 0 });
});

test.each([
	"habits",
	"recurring",
] as const)("%s permits metadata only without advancing schedule", async (kind) => {
	if (kind === "habits")
		await admin.query("update list set kind='habits' where id='list'");
	else
		await admin.query(
			"update task set rrule='FREQ=DAILY',recurrence_anchor_at=$1,recurrence_consumed=2 where id='task'",
			[due],
		);
	initial = (await observation()).data.stateToken;
	for (const fields of [{ dueAt: due }, { dueAllDay: false }]) {
		const result = await patch(input(fields));
		expect(result.status).toBe(400);
		expect(await result.json()).toMatchObject({
			code: "recurrence-workflow-required",
		});
	}
	expect((await patch(input({ notes: null, priority: 2 }))).status).toBe(200);
	expect(
		(
			await admin.query(
				"select due_at,done,recurrence_consumed from task where id='task'",
			)
		).rows[0],
	).toEqual({
		due_at: new Date(due),
		done: false,
		recurrence_consumed: kind === "habits" ? null : 2,
	});
	expect(await counts()).toEqual({ receipts: 1, history: 0, karma: 0 });
});

test("effective all-day dates refuse clearing without resetting the flag", async () => {
	await admin.query("update task set due_all_day=true where id='task'");
	initial = (await observation()).data.stateToken;
	expect((await patch(input({ dueAt: null }))).status).toBe(400);
	expect((await patch(input({ dueAt: null, dueAllDay: false }))).status).toBe(
		200,
	);
});

test("current write authority is required for new writes and matching replays before stale-state errors", async () => {
	const key = randomUUID();
	expect((await patch(input(), key)).status).toBe(200);
	const read = (
		await createPersonalAccessToken(runtime, "member", {
			name: "read",
			access: "read",
		})
	).token;
	expect((await patch(input(), key, read)).status).toBe(403);
	await admin.query(
		"update membership set role='viewer' where id='member-seat'",
	);
	expect(
		(await patch({ ...input(), expectedState: "0".repeat(64) })).status,
	).toBe(403);
	expect((await patch(input(), key)).status).toBe(403);
	await admin.query("delete from membership where id='member-seat'");
	expect((await patch(input(), key)).status).toBe(404);
	expect(await counts()).toEqual({ receipts: 1, history: 0, karma: 0 });
});

test.each([
	"pending",
	"blocked",
] as const)("activation %s refuses before mutations and viewer scope takes precedence", async (status) => {
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values('task',$1,1)",
		[status],
	);
	const result = await patch();
	expect(result.status).toBe(409);
	expect(await result.json()).toMatchObject({ code: "activation-pending" });
	const viewer = (
		await createPersonalAccessToken(runtime, "viewer", {
			name: "writer",
			access: "write",
		})
	).token;
	expect((await patch(input(), randomUUID(), viewer)).status).toBe(403);
	await noEffects();
});

test.each([
	"done",
	"created_at",
	"recurrence",
] as const)("intervening %s state invalidates an old observation", async (field) => {
	if (field === "done")
		await admin.query(
			"update task set done=true,completed_at=now() where id='task'",
		);
	else if (field === "created_at")
		await admin.query(
			"update task set created_at=created_at+interval '1 second' where id='task'",
		);
	else await admin.query("update task set rrule='FREQ=DAILY' where id='task'");
	expect((await patch()).status).toBe(409);
	expect(await counts()).toEqual({ receipts: 0, history: 0, karma: 0 });
});

test("deleted replay returns 410 only in a visible writable origin and never recreates the task", async () => {
	const key = randomUUID();
	expect((await patch(input(), key)).status).toBe(200);
	await admin.query("delete from task where id='task'");
	expect((await patch(input(), key)).status).toBe(410);
	expect(
		(await admin.query("select id from task where id='task'")).rowCount,
	).toBe(0);
	await admin.query("delete from membership where id='member-seat'");
	expect((await patch(input(), key)).status).toBe(404);
});

test("receipt insertion failure rolls back the native scalar mutation", async () => {
	await admin.query(
		"create function update_reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture receipt failure'; end $$",
	);
	await admin.query(
		"create trigger update_reject before insert on public_api_request for each row execute function update_reject_receipt()",
	);
	try {
		expect(
			(await patch(input({ title: "Rollback", notes: null }))).status,
		).toBe(500);
		await noEffects();
	} finally {
		await admin.query(
			"drop trigger update_reject on public_api_request;drop function update_reject_receipt()",
		);
	}
});

test.each([
	{},
	{ patch: {} },
	{ patch: { done: true } },
	{ patch: { notes: "a".repeat(32769) } },
	{ patch: { priority: 4 } },
	JSON.parse('{"patch":{"constructor":{}}}'),
	JSON.parse('{"__proto__":{}}'),
])("strict malformed input %# leaves no effects", async (overrides) => {
	const body = Object.keys(overrides).length
		? { ...input(), ...overrides }
		: {};
	expect((await patch(body)).status).toBe(400);
	await noEffects();
});

test("wire bounds, UTF8, missing key and content type refuse before writes", async () => {
	expect((await patch(input(), null)).status).toBe(400);
	expect((await patch(input(), randomUUID(), token, "?extra=1")).status).toBe(
		400,
	);
	for (const [body, type, expected] of [
		[new Uint8Array([0xff]), "application/json", 400],
		["x".repeat(65537), "application/json", 413],
		[JSON.stringify(input()), "text/plain", 415],
	] as const) {
		const result = await app.handle(
			new Request("http://localhost/api/v1/tasks/task", {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": type,
					"idempotency-key": randomUUID(),
				},
				body,
			}),
		);
		expect(result.status).toBe(expected);
	}
	await noEffects();
});

async function blocked(query?: string) {
	await vi.waitFor(
		async () => {
			const result = await admin.query(
				"select count(*)::int count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and ($2::text is null or query like $2)",
				[role, query ?? null],
			);
			expect(result.rows[0].count).toBeGreaterThan(0);
		},
		{ timeout: 700, interval: 5 },
	);
}

test("a late membership grant cannot expand a request whose discovery failed", async () => {
	await admin.query("delete from membership where id='member-seat'");
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"member",
		]);
		pending = patch();
		await blocked(
			'select id from "user" where id = $1 and deleted_at is null for update%',
		);
		await holder.query(
			"insert into membership(id,user_id,workspace_id,role) values('member-seat','member','workspace','member')",
		);
		await holder.query("commit");
		expect((await pending).status).toBe(404);
		await noEffects();
		expect((await patch()).status).toBe(200);
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test.each([
	"revoked",
	"expired",
] as const)("%s token during authority-lock wait refuses at final PAT validation", async (kind) => {
	const [metadata] = await listPersonalAccessTokens(runtime, "member");
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"member",
		]);
		pending = patch();
		await blocked();
		await holder.query(
			kind === "revoked"
				? "update personal_access_token set revoked_at=now() where id=$1"
				: "update personal_access_token set created_at=now()-interval '2 days',expires_at=now()-interval '1 second' where id=$1",
			[metadata.id],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		await noEffects();
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test("actual Zero move during discovery refuses the stale update without following its new list", async () => {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const moving = zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", async () => {
			await mutators.task.move.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: taskId, listId: "moved", sortKey: "a0" },
			});
			started.resolve();
			await release.promise;
		}),
	);
	let pending: Promise<Response> | undefined;
	try {
		await started.promise;
		pending = patch();
		await blocked();
		release.resolve();
		await moving;
		expect((await pending).status).toBe(503);
		expect((await patch()).status).toBe(409);
		expect(
			(await admin.query("select list_id,title from task where id='task'"))
				.rows[0],
		).toEqual({ list_id: "moved", title: "Old" });
		expect(await counts()).toEqual({ receipts: 0, history: 0, karma: 0 });
	} finally {
		release.resolve();
		await Promise.allSettled([moving, pending]);
	}
});

test("a revoked token refuses even a matching completed receipt", async () => {
	const key = randomUUID();
	expect((await patch(input(), key)).status).toBe(200);
	const [metadata] = await listPersonalAccessTokens(runtime, "member");
	await revokePersonalAccessToken(runtime, "member", metadata.id);
	expect((await patch(input(), key)).status).toBe(401);
	expect(await counts()).toEqual({ receipts: 1, history: 0, karma: 0 });
});
