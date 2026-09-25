import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import { withProducerTaskActivation } from "../../src/server/notifications/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({
	connectionString: databaseURL,
	application_name: "account-activation-deletion-test",
});
const deletedUser = "account-activation-delete";
const owner = "account-activation-owner";
const cutoff = new Date("2026-09-20T10:00:00.000Z");
const suppressed = new Date("2026-09-19T10:00:00.000Z");
const guards: Guards = {
	foreignOrigin: () => false,
	guardedPost:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: deletedUser } } as Session),
	guardedGet:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: deletedUser } } as Session),
};
const app = new Elysia().use(accountDeletionRoutes(runtime, guards));

async function removeAccount() {
	return app.handle(
		new Request("http://localhost/api/account/delete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ acknowledgeKeyLoss: true }),
		}),
	);
}

async function waitForAccountBlockedBy(blockerPid: number): Promise<number> {
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) {
		const result = await admin.query<{ pid: number }>(
			`select pid from pg_stat_activity
			where application_name = 'account-activation-deletion-test'
			and wait_event_type = 'Lock'
			and $1::int = any(pg_blocking_pids(pid))`,
			[blockerPid],
		);
		if (result.rows[0]) return result.rows[0].pid;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Account deletion did not wait on expected lock");
}

async function waitForPidBlockedBy(pid: number, blockerPid: number) {
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) {
		const result = await admin.query<{ blockers: number[] }>(
			"select pg_blocking_pids($1) as blockers",
			[pid],
		);
		if (result.rows[0]?.blockers.includes(blockerPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Producer did not wait on account deletion lock");
}

async function seed() {
	await admin.query(
		`insert into "user" (id,name,email,email_verified) values
		($1,'Deleted','delete@example.test',false),
		($2,'Owner','owner@example.test',false)`,
		[deletedUser, owner],
	);
	await admin.query(
		`insert into workspace (id,name,owner_id,kind) values
		('shared','Shared',$2,'shared'),
		('orphan','Orphan',$2,'shared'),
		('personal','Personal',$1,'personal')`,
		[deletedUser, owner],
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values
		('shared-deleted',$1,'shared','member'),
		('shared-owner',$2,'shared','owner'),
		('orphan-owner',$2,'orphan','owner'),
		('personal-deleted',$1,'personal','owner')`,
		[deletedUser, owner],
	);
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values
		('','shared',$1,'Empty ID list','tasks','0'),
		('owned','shared',$1,'Owned','tasks','a'),
		('other','shared',$2,'Other','tasks','b'),
		('orphan-list','orphan',$2,'Orphan','tasks','c'),
		('personal-list','personal',$1,'Private','tasks','d')`,
		[deletedUser, owner],
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key,fallback_user_id) values
		('','','Empty ID task','0',null),
		('assigned','other','Assigned','a',null),
		('fallback','other','Fallback','b',$1),
		('list-owned','owned','List owned','c',null),
		('source-owned','orphan-list','Source owned','d',null),
		('expected-only','orphan-list','Expected only','e',null),
		('expected-owner','orphan-list','Expected owner','e1',null),
		('expected-fallback','orphan-list','Expected fallback','e2',null),
		('unaffected','other','Unaffected','f',null),
		('native','other','Native','g',null),
		('private','personal-list','Private','h',null)`,
		[deletedUser],
	);
	await admin.query(
		`insert into task_assignee (id,task_id,user_id) values
		('','',$1),
		('assigned-deleted','assigned',$1),
		('native-deleted','native',$1),
		('unaffected-owner','unaffected',$2)`,
		[deletedUser, owner],
	);
	await admin.query(
		`insert into import_source
		(id,owner_user_id,label,format,schema_version,source_user_id)
		values ('deleted-source',$1,'Source','ditero',1,'source-user')`,
		[deletedUser],
	);
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,
		completion_mode,owning_source_id,owning_owner_user_id,manual_review_digest)
		select id,'active',7,$1,$1,'manual','deleted-source',$2,repeat('a',64)
		from task where id in ('','assigned','fallback','list-owned','unaffected','private')`,
		[cutoff, deletedUser],
	);
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,owning_source_id,owning_owner_user_id)
		values ('source-owned','pending',8,'deleted-source',$1)`,
		[deletedUser],
	);
	for (const [taskId, location] of [
		["expected-only", "assignee"],
		["expected-owner", "owner"],
		["expected-fallback", "fallback"],
	] as const) {
		const seat = { userId: deletedUser, membershipId: "missing-seat" };
		const expected = {
			version: 1,
			workspaceId: "orphan",
			assignees: location === "assignee" ? [seat] : [],
			ownerFallback: location === "owner" ? seat : null,
			escalationFallback: location === "fallback" ? seat : null,
		};
		await admin.query(
			`insert into task_notification_activation
		(task_id,status,generation,owning_owner_user_id,expected_relationships,
		expected_relationship_digest,expected_relationship_count,expected_relationship_bytes)
		values ($1,'pending',3,$2,$3::jsonb,repeat('b',64),1,
		octet_length($3::jsonb::text))`,
			[taskId, owner, JSON.stringify(expected)],
		);
	}
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('',$1,true,7,$3,$4),
		('assigned',$1,true,7,$3,$4),
		('assigned',$2,false,6,$3,null),
		('fallback',$2,true,7,$3,$4),
		('list-owned',$1,true,7,$3,$4),
		('source-owned',$2,true,8,$3,$4),
		('expected-only',$2,true,3,$3,$4),
		('expected-owner',$2,true,3,$3,$4),
		('expected-fallback',$2,true,3,$3,$4),
		('unaffected',$2,true,7,$3,$4),
		('private',$1,true,7,$3,$4)`,
		[deletedUser, owner, cutoff, suppressed],
	);
}

beforeAll(async () => {
	await admin.query(`do $$ begin
		if not exists (select from pg_roles where rolname='ditero_account_activation_test') then
		create role ditero_account_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if; end $$`);
	await admin.query(
		"grant usage on schema public to ditero_account_activation_test",
	);
	await admin.query(
		"grant select,insert,update,delete on all tables in schema public to ditero_account_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_account_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

test("account deletion blocks affected guards and retains recovery evidence", async () => {
	await seed();
	const result = await removeAccount();
	expect(result.status, await result.clone().text()).toBe(200);
	const guards = await admin.query(`select task_id,status,generation,
		import_occurrence_cutoff,recipient_generation_cutoff,completion_mode,
		owning_source_id,owning_owner_user_id,manual_review_digest,blocked_reason,
		expected_relationships from task_notification_activation order by task_id`);
	expect(guards.rows.map((row) => [row.task_id, row.status])).toEqual([
		["", "blocked"],
		["assigned", "blocked"],
		["expected-fallback", "blocked"],
		["expected-only", "blocked"],
		["expected-owner", "blocked"],
		["fallback", "blocked"],
		["list-owned", "blocked"],
		["source-owned", "blocked"],
		["unaffected", "active"],
	]);
	for (const row of guards.rows.filter((row) => row.task_id !== "unaffected")) {
		expect(row.completion_mode).toBeNull();
		expect(row.blocked_reason).toMatch(/Account deletion/);
	}
	const assigned = guards.rows.find((row) => row.task_id === "assigned");
	expect(assigned).toMatchObject({
		generation: 7,
		import_occurrence_cutoff: cutoff,
		recipient_generation_cutoff: cutoff,
		owning_source_id: "deleted-source",
		owning_owner_user_id: deletedUser,
		manual_review_digest: "a".repeat(64),
	});
	expect(
		guards.rows.find((row) => row.task_id === "expected-only")
			?.expected_relationships,
	).toMatchObject({ assignees: [{ userId: deletedUser }] });
	const recipients =
		await admin.query(`select task_id,user_id,active,generation,cutoff,
		overdue_suppressed_due_at from task_notification_recipient order by task_id,user_id`);
	for (const row of recipients.rows.filter(
		(row) => row.task_id !== "unaffected",
	))
		expect(row.active).toBe(false);
	expect(
		recipients.rows.find((row) => row.task_id === "unaffected")?.active,
	).toBe(true);
	expect(
		recipients.rows.find(
			(row) => row.task_id === "assigned" && row.user_id === deletedUser,
		),
	).toMatchObject({
		generation: 7,
		cutoff,
		overdue_suppressed_due_at: suppressed,
	});
	expect(
		(await admin.query("select 1 from import_source where id='deleted-source'"))
			.rowCount,
	).toBe(0);
	expect(
		(await admin.query("select 1 from task where id='private'")).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select 1 from task_assignee where task_id in ('assigned','native')",
			)
		).rowCount,
	).toBe(0);
	expect(
		(await admin.query("select fallback_user_id from task where id='fallback'"))
			.rows[0].fallback_user_id,
	).toBeNull();
	expect(
		(await admin.query("select owner_id from list where id='owned'")).rows[0]
			.owner_id,
	).toBe(owner);
	expect(
		(
			await admin.query(
				"select 1 from task_notification_activation where task_id='native'",
			)
		).rowCount,
	).toBe(0);
});

test("producer authority lock wins first and account deletion waits", async () => {
	await seed();
	const producer = await runtime.connect();
	let held = false;
	try {
		await producer.query("begin");
		held = true;
		await producer.query("select set_config('ditero.user_id',$1,true)", [
			owner,
		]);
		await producer.query(
			`select id from "user" where id=any($1::text[]) order by id for update`,
			[[deletedUser, owner]],
		);
		await producer.query(
			"select id from workspace where id='shared' for share",
		);
		await producer.query(
			"select id from membership where workspace_id='shared' order by id for share",
		);
		await producer.query("select id from list where id='other' for share");
		await withProducerTaskActivation(producer, "assigned", async (lookup) => {
			expect(lookup.kind).toBe("guarded");
		});
		const producerPid = (
			await producer.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		const deletion = removeAccount();
		const settled = deletion.then(
			(response) => response,
			(error: unknown) => error,
		);
		await waitForAccountBlockedBy(producerPid);
		await producer.query("commit");
		held = false;
		const response = await settled;
		expect(response).toBeInstanceOf(Response);
		if (!(response instanceof Response)) throw response;
		expect(response.status, await response.clone().text()).toBe(200);
		expect(
			(
				await admin.query(
					"select status from task_notification_activation where task_id='assigned'",
				)
			).rows[0].status,
		).toBe("blocked");
	} finally {
		if (held) await producer.query("rollback");
		producer.release();
	}
}, 20_000);

test("account deletion authority lock wins first and producer waits", async () => {
	await seed();
	const blocker = await admin.connect();
	const producer = await runtime.connect();
	let blockerHeld = false;
	let producerHeld = false;
	try {
		await blocker.query("begin");
		blockerHeld = true;
		await blocker.query(
			"select task_id from task_notification_activation where task_id='assigned' for update",
		);
		const blockerPid = (
			await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		const deletion = removeAccount();
		const deletionSettled = deletion.then(
			(response) => response,
			(error: unknown) => error,
		);
		const deletionPid = await waitForAccountBlockedBy(blockerPid);
		await producer.query("begin");
		producerHeld = true;
		await producer.query("select set_config('ditero.user_id',$1,true)", [
			owner,
		]);
		const producerPid = (
			await producer.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		const lock = producer.query(
			`select id from "user" where id=any($1::text[]) order by id for update`,
			[[deletedUser, owner]],
		);
		const lockSettled = lock.then(
			() => "acquired" as const,
			(error: unknown) => error,
		);
		await waitForPidBlockedBy(producerPid, deletionPid);
		await blocker.query("commit");
		blockerHeld = false;
		const [response, acquired] = await Promise.all([
			deletionSettled,
			lockSettled,
		]);
		expect(acquired).toBe("acquired");
		expect(response).toBeInstanceOf(Response);
		if (!(response instanceof Response)) throw response;
		expect(response.status, await response.clone().text()).toBe(200);
		await producer.query(
			"select id from workspace where id='shared' for share",
		);
		await producer.query("select id from list where id='other' for share");
		await withProducerTaskActivation(producer, "assigned", async (lookup) => {
			expect(lookup.kind).toBe("guarded");
			if (lookup.kind === "guarded") expect(lookup.status).toBe("blocked");
		});
		await producer.query("commit");
		producerHeld = false;
	} finally {
		if (blockerHeld) await blocker.query("rollback");
		if (producerHeld) await producer.query("rollback");
		blocker.release();
		producer.release();
	}
}, 20_000);
