import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import type { CollectedEvent } from "../../src/server/notifications/events.ts";
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
const role = `api_write_test_${randomUUID().replaceAll("-", "")}`;
const runtime = new Pool({
	connectionString: databaseURL,
	application_name: role,
});
runtime.on("connect", (client) => {
	void client.query(`set role "${role}"`);
});
const flushed: CollectedEvent[][] = [];
const commitObservations: { tasks: number; receipts: number }[] = [];
let failFlush = false;
const app = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		for (const event of events) {
			const tasks = (
				await admin.query(
					"select count(*)::int as count from task where id=$1",
					[event.event.taskId],
				)
			).rows[0].count;
			const receipts = (
				await admin.query(
					"select count(*)::int as count from public_api_request where task_id=$1",
					[event.event.taskId],
				)
			).rows[0].count;
			commitObservations.push({ tasks, receipts });
		}
		flushed.push(events);
		if (failFlush) throw new Error("Simulated notification failure");
	},
);
let token: string;
const body = { listId: "write-list", title: "Buy coffee" };

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
	expect(
		(
			await runtime.query(
				"select relrowsecurity,relforcerowsecurity from pg_class where oid='public_api_request'::regclass",
			)
		).rows[0],
	).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	flushed.length = 0;
	commitObservations.length = 0;
	failFlush = false;
	await admin.query(
		`insert into "user" (id,name,email,email_verified) values ('write-alice','Alice','alice@write.test',true),('write-bob','Bob','bob@write.test',true),('write-viewer','Viewer','viewer@write.test',true),('write-outside','Other','other@write.test',true)`,
	);
	await admin.query(
		`insert into workspace (id,name,owner_id,kind) values ('write-workspace','Home','write-alice','shared'),('write-hidden','Other','write-outside','shared')`,
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values ('write-owner','write-alice','write-workspace','owner'),('write-member','write-bob','write-workspace','member'),('write-view','write-viewer','write-workspace','viewer'),('write-other','write-outside','write-hidden','owner')`,
	);
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,sort_key) values ('write-list','write-workspace','write-alice','Tasks','a0'),('write-hidden-list','write-hidden','write-outside','Hidden','a0')`,
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key) values ('write-existing','write-list','Existing','a0')`,
	);
	await admin.query(
		`insert into label (id,workspace_id,name,color) values ('write-label','write-workspace','Shopping','#000000'),('write-other-label','write-hidden','Hidden','#000000')`,
	);
	token = (
		await createPersonalAccessToken(runtime, "write-alice", {
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
	overrides: HeadersInit = {},
) {
	const headers = new Headers({
		authorization: `Bearer ${secret}`,
		"content-type": "application/json",
		...overrides,
	});
	if (key !== null) headers.set("idempotency-key", key);
	return app.handle(
		new Request("http://localhost/api/v1/tasks", {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		}),
	);
}

async function counts() {
	return (
		await admin.query(
			"select (select count(*)::int from task where id <> 'write-existing') as tasks,(select count(*)::int from task_assignee) as assignees,(select count(*)::int from task_label) as labels,(select count(*)::int from public_api_request) as receipts,(select count(*)::int from invite) as invites",
		)
	).rows[0];
}

test("creates an appended task with assignments and labels through a live non-bypass role", async () => {
	const response = await request({
		...body,
		notes: "Ground",
		dueAt: "2026-10-03T17:00:00+02:00",
		priority: 3,
		assigneeIds: ["write-bob"],
		labelIds: ["write-label"],
	});
	expect(response.status).toBe(201);
	const result = await response.json();
	expect(result).toMatchObject({
		version: 1,
		nextCursor: null,
		data: {
			title: "Buy coffee",
			notes: "Ground",
			dueAt: "2026-10-03T15:00:00.000Z",
			priority: 3,
			assigneeIds: ["write-bob"],
			labelIds: ["write-label"],
		},
	});
	expect(result.data.sortKey > "a0").toBe(true);
	expect(commitObservations).toEqual([{ tasks: 1, receipts: 1 }]);
	expect(await counts()).toEqual({
		tasks: 1,
		assignees: 1,
		labels: 1,
		receipts: 1,
		invites: 0,
	});
	expect(flushed.flat()).toMatchObject([
		{
			recipientUserId: "write-bob",
			event: {
				kind: "assign",
				taskId: result.data.id,
				actorUserId: "write-alice",
			},
		},
	]);
});

test("concurrent same-key requests create one task and one notification intent", async () => {
	const key = randomUUID();
	const responses = await Promise.all([
		request({ ...body, assigneeIds: ["write-bob"] }, key),
		request({ ...body, assigneeIds: ["write-bob"] }, key),
	]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 201,
	]);
	const results = await Promise.all(
		responses.map((response) => response.json()),
	);
	expect(results[0].data.id).toBe(results[1].data.id);
	expect((await counts()).tasks).toBe(1);
	expect((await counts()).receipts).toBe(1);
	expect(flushed.flat()).toHaveLength(1);
});

test("cross-account creation takes shared authority users in sorted order before actor locks", async () => {
	const bob = (
		await createPersonalAccessToken(runtime, "write-bob", {
			name: "writer",
			access: "write",
		})
	).token;
	const holder = await admin.connect();
	const pending: Promise<Response>[] = [];
	async function waitForBlockedRequests(count: number) {
		const deadline = Date.now() + 500;
		while (Date.now() < deadline) {
			const waiting = await admin.query<{ count: number }>(
				"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like 'select id from \"user\"%'",
				[role],
			);
			if (waiting.rows[0].count >= count) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(
			`Expected ${count} requests blocked at authority user locks`,
		);
	}
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"write-bob",
		]);
		pending.push(
			request({ ...body, assigneeIds: ["write-alice"] }, randomUUID(), bob),
		);
		await waitForBlockedRequests(1);
		pending.push(request({ ...body, assigneeIds: ["write-bob"] }));
		await waitForBlockedRequests(2);
		await holder.query("commit");
		const responses = await Promise.all(pending);
		expect(responses.map((response) => response.status)).toEqual([201, 201]);
		expect((await counts()).tasks).toBe(2);
		expect((await counts()).receipts).toBe(2);
		expect(flushed.flat()).toHaveLength(2);
	} finally {
		await holder.query("rollback");
		holder.release();
		await Promise.all(pending);
	}
});

test("late membership grants cannot expand a request that captured no creation authority", async () => {
	const bob = (
		await createPersonalAccessToken(runtime, "write-bob", {
			name: "writer",
			access: "write",
		})
	).token;
	await admin.query("delete from membership where id='write-member'");
	const holder = await admin.connect();
	const key = randomUUID();
	const input = { ...body, assigneeIds: ["write-alice"] };
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"write-bob",
		]);
		pending = request(input, key, bob);
		let blocked = false;
		const deadline = Date.now() + 500;
		while (Date.now() < deadline) {
			const waiting = await admin.query<{ count: number }>(
				"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like 'select id from \"user\" where id = $1 and deleted_at is null for update%'",
				[role],
			);
			if (waiting.rows[0].count === 1) {
				blocked = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(blocked).toBe(true);
		await holder.query(
			"insert into membership(id,user_id,workspace_id,role) values ('write-late','write-bob','write-workspace','member')",
		);
		await holder.query("commit");
		expect((await pending).status).toBe(404);
		expect(await counts()).toEqual({
			tasks: 0,
			assignees: 0,
			labels: 0,
			receipts: 0,
			invites: 0,
		});
		expect(flushed).toEqual([]);
		// A new attempt observes the committed grant and obtains the full lock set.
		expect((await request(input, key, bob)).status).toBe(201);
		expect((await counts()).tasks).toBe(1);
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});

test("receipt replay ignores removed original assignees and never reassigns them", async () => {
	const key = randomUUID();
	const input = { ...body, assigneeIds: ["write-bob"] };
	const original = await (await request(input, key)).json();
	await admin.query("delete from task_assignee where task_id=$1", [
		original.data.id,
	]);
	await admin.query("delete from membership where user_id='write-bob'");
	await admin.query('update "user" set deleted_at=now() where id=$1', [
		"write-bob",
	]);
	const response = await request(input, key);
	expect(response.status).toBe(200);
	expect((await response.json()).data.assigneeIds).toEqual([]);
	expect(flushed.flat()).toHaveLength(1);
});

test("receipt replay follows current authorized task after its original list was deleted", async () => {
	const key = randomUUID();
	const original = await (await request(body, key)).json();
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('write-current','write-alice','write-hidden','member')",
	);
	await admin.query("update task set list_id='write-hidden-list' where id=$1", [
		original.data.id,
	]);
	await admin.query("delete from task where id='write-existing'");
	await admin.query("delete from list where id='write-list'");
	await admin.query("delete from membership where id='write-owner'");
	const response = await request(body, key);
	expect(response.status).toBe(200);
	expect((await response.json()).data.listId).toBe("write-hidden-list");
});

test("canonical retry across tokens returns the current task without another notice", async () => {
	const key = randomUUID();
	const original = await (
		await request(
			{
				...body,
				dueAt: "2026-10-03T17:00:00+02:00",
				assigneeIds: ["write-viewer", "write-bob"],
			},
			key,
		)
	).json();
	await admin.query(
		"update task set title='Changed by another client' where id=$1",
		[original.data.id],
	);
	const other = (
		await createPersonalAccessToken(runtime, "write-alice", {
			name: "other writer",
			access: "write",
		})
	).token;
	const replay = await request(
		{
			...body,
			dueAt: "2026-10-03T15:00:00.000Z",
			assigneeIds: ["write-bob", "write-viewer"],
			labelIds: [],
			notes: null,
			priority: 0,
			dueAllDay: false,
		},
		key,
		other,
	);
	expect(replay.status).toBe(200);
	expect((await replay.json()).data.title).toBe("Changed by another client");
	expect(flushed.flat()).toHaveLength(2);
});

test("different payload key reuse conflicts and receipts remain account isolated", async () => {
	const key = randomUUID();
	expect((await request(body, key)).status).toBe(201);
	expect((await request({ ...body, title: "Different" }, key)).status).toBe(
		409,
	);
	const bob = (
		await createPersonalAccessToken(runtime, "write-bob", {
			name: "writer",
			access: "write",
		})
	).token;
	expect((await request(body, key, bob)).status).toBe(201);
	expect(
		(
			await withUserContext(runtime, "write-viewer", (client) =>
				client.query("select * from public_api_request"),
			)
		).rows,
	).toEqual([]);
	await expect(
		withUserContext(runtime, "write-viewer", (client) =>
			client.query(
				"insert into public_api_request(user_id,request_id,request_hash,task_id,created_at) values ('write-alice',$1,$2,'forged',now())",
				[randomUUID(), "a".repeat(64)],
			),
		),
	).rejects.toThrow();
});

test("deleted task receipt returns 410 and never recreates it", async () => {
	const key = randomUUID();
	const original = await (await request(body, key)).json();
	await admin.query("delete from task where id=$1", [original.data.id]);
	expect((await request(body, key)).status).toBe(410);
	expect(await counts()).toEqual({
		tasks: 0,
		assignees: 0,
		labels: 0,
		receipts: 1,
		invites: 0,
	});
});

test("revoked memberships and tokens cannot replay or probe receipts", async () => {
	const key = randomUUID();
	const original = await (await request(body, key)).json();
	await admin.query("delete from membership where id='write-owner'");
	expect((await request(body, key)).status).toBe(404);
	expect((await request(body)).status).toBe(404);
	await admin.query("delete from task where id=$1", [original.data.id]);
	expect((await request(body, key)).status).toBe(404);
	const [metadata] = await listPersonalAccessTokens(runtime, "write-alice");
	await revokePersonalAccessToken(runtime, "write-alice", metadata.id);
	expect((await request(body, key)).status).toBe(401);
});

test("existing owner, admin, and member roles create; viewers and outsiders cannot", async () => {
	const bob = (
		await createPersonalAccessToken(runtime, "write-bob", {
			name: "writer",
			access: "write",
		})
	).token;
	for (const memberRole of ["owner", "admin", "member"]) {
		await admin.query("update membership set role=$1 where id='write-member'", [
			memberRole,
		]);
		expect((await request(body, randomUUID(), bob)).status).toBe(201);
	}
	const viewer = (
		await createPersonalAccessToken(runtime, "write-viewer", {
			name: "writer",
			access: "write",
		})
	).token;
	expect((await request(body, randomUUID(), viewer)).status).toBe(403);
	expect((await request({ ...body, listId: "write-hidden-list" })).status).toBe(
		404,
	);
	const read = (
		await createPersonalAccessToken(runtime, "write-alice", { name: "read" })
	).token;
	expect((await request(body, randomUUID(), read)).status).toBe(403);
});

test.each([
	{ assigneeIds: ["write-bob", "write-outside"] },
	{ assigneeIds: ["missing"] },
	{ assigneeIds: ["write-bob"], labelIds: ["write-other-label"] },
])("invalid references roll back task, assignments, receipt, and notification intents %j", async (references) => {
	expect((await request({ ...body, ...references })).status).toBe(400);
	expect(await counts()).toEqual({
		tasks: 0,
		assignees: 0,
		labels: 0,
		receipts: 0,
		invites: 0,
	});
	expect(flushed).toEqual([]);
});

test("rejects missing keys, unknown fields, malformed dates, duplicate IDs, oversized and invalid UTF-8 bodies", async () => {
	for (const invalid of [
		{ ...body, unknown: true },
		{ ...body, dueAt: "tomorrow" },
		{ ...body, dueAllDay: true },
		{ ...body, priority: 4 },
		{ ...body, assigneeIds: ["write-bob", "write-bob"] },
	])
		expect((await request(invalid)).status).toBe(400);
	expect((await request(body, null)).status).toBe(400);
	expect((await request(body, "invalid")).status).toBe(400);
	expect(
		(await request(body, randomUUID(), token, { "content-type": "text/plain" }))
			.status,
	).toBe(415);
	expect((await request({ ...body, notes: "x".repeat(70_000) })).status).toBe(
		413,
	);
	const malformed = await app.handle(
		new Request("http://localhost/api/v1/tasks", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": randomUUID(),
			},
			body: new Uint8Array([123, 34, 255, 34, 58, 49, 125]),
		}),
	);
	expect(malformed.status).toBe(400);
	expect((await counts()).tasks).toBe(0);
});

test("notification enqueue failure cannot report a committed task as failed", async () => {
	const logger = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		failFlush = true;
		expect(
			(await request({ ...body, assigneeIds: ["write-bob"] })).status,
		).toBe(201);
		expect((await counts()).tasks).toBe(1);
		expect(logger).toHaveBeenCalledWith(
			"public API notification enqueue after commit failed",
		);
	} finally {
		logger.mockRestore();
	}
});

test("OpenAPI publishes the input contract and create/replay statuses", async () => {
	const response = await app.handle(
		new Request("http://localhost/api/v1/openapi.json"),
	);
	const operation = (await response.json()).paths["/api/v1/tasks"].post;
	expect(operation.parameters[0]).toMatchObject({
		name: "Idempotency-Key",
		required: true,
	});
	expect(
		operation.requestBody.content["application/json"].schema.required,
	).toEqual(["listId", "title"]);
	for (const status of ["200", "201", "409", "410", "413", "415"])
		expect(operation.responses[status]).toBeDefined();
});
