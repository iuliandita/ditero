import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	hashAckToken,
	redeemAckCapability,
} from "../../src/server/notifications/capability.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString, max: 5 });
const runtime = new Pool({ connectionString, max: 3 });
const db = drizzle(runtime, { schema: tables });
const due = new Date("2026-08-01T09:00:00Z");
const token = "ack-activation-test-token";

beforeAll(async () => {
	await admin.query(`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_ack_activation_test') then
		create role ditero_ack_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`);
	await admin.query(
		"grant usage on schema public to ditero_ack_activation_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_ack_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_ack_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		values ('ack-user','User','ack@example.test',false,now(),now())`);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('ack-space','Space','ack-user','shared')",
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ('ack-seat','ack-user','ack-space','owner')",
	);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('ack-list','ack-space','ack-user','List','tasks','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,due_at) values ('ack-task','ack-list','Task','a0',$1)",
		[due],
	);
	await admin.query(
		"insert into reminder_state (id,task_id,occurrence_at,recipient_user_id,status,fire_count) values ('ack-reminder','ack-task',$1,'ack-user','pending',1)",
		[due],
	);
	await admin.query(
		"insert into ack_capability (id,token_hash,reminder_state_id,recipient_user_id,action,expires_at) values ('ack-cap',$1,'ack-reminder','ack-user','complete',now()+interval '1 day')",
		[hashAckToken(token)],
	);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

async function guard(status: "pending" | "blocked" | "active") {
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
		values ('ack-task',$1,1,$2,$2,$3)`,
		[
			status,
			status === "active" ? due : null,
			status === "active" ? "import" : null,
		],
	);
}

async function result() {
	return (
		await admin.query(`select t.done, r.status, c.consumed_at,
		(select count(*)::int from karma_event) as awards
		from task t join reminder_state r on r.task_id=t.id
		join ack_capability c on c.reminder_state_id=r.id where t.id='ack-task'`)
	).rows[0];
}

for (const status of ["pending", "blocked"] as const) {
	test(`${status} refuses capability without consumption, completion or Karma`, async () => {
		await guard(status);
		expect(await redeemAckCapability(db, token, "capability")).toBeNull();
		expect(await result()).toEqual({
			done: false,
			status: "pending",
			consumed_at: null,
			awards: 0,
		});
	});
}

for (const status of ["native", "active"] as const) {
	test(`${status} completion works under the restricted runtime role`, async () => {
		if (status === "active") await guard(status);
		const role = (
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0];
		expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
		expect(await redeemAckCapability(db, token, "capability")).toBe("ack-user");
		expect(await result()).toMatchObject({
			done: true,
			status: "acked",
			awards: 1,
		});
		const history = (
			await admin.query(`select actor_user_id,origin,action,
			before_done,after_done from task_completion_event where task_id='ack-task'`)
		).rows;
		expect(history).toEqual([
			{
				actor_user_id: "ack-user",
				origin: "capability_recipient",
				action: "complete",
				before_done: false,
				after_done: true,
			},
		]);
	});
}

test("history append failure rolls back capability consumption and completion", async () => {
	await admin.query(
		"revoke insert on task_completion_event from ditero_ack_activation_test",
	);
	try {
		await expect(
			redeemAckCapability(db, token, "capability"),
		).rejects.toThrow();
		expect(await result()).toEqual({
			done: false,
			status: "pending",
			consumed_at: null,
			awards: 0,
		});
		expect(
			(
				await admin.query(
					"select count(*)::int as count from task_completion_event where task_id='ack-task'",
				)
			).rows[0].count,
		).toBe(0);
	} finally {
		await admin.query(
			"grant insert on task_completion_event to ditero_ack_activation_test",
		);
	}
});

test("viewer ack remains content-free on an active imported task", async () => {
	await guard("active");
	await admin.query("update membership set role='viewer' where id='ack-seat'");
	expect(await redeemAckCapability(db, token, "capability")).toBe("ack-user");
	expect(await result()).toMatchObject({
		done: false,
		status: "acked",
		awards: 0,
	});
});

test("wrong sender still burns a token even while the task is pending", async () => {
	await guard("pending");
	expect(
		await redeemAckCapability(db, token, "capability", Date.now(), {
			allowedRecipients: ["other"],
		}),
	).toBeNull();
	expect((await result()).consumed_at).not.toBeNull();
	expect((await result()).done).toBe(false);
});

test("automatic recurrence advancement retains overdue suppression", async () => {
	await guard("active");
	await admin.query("update task set rrule='FREQ=DAILY' where id='ack-task'");
	await admin.query(
		"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at) values ('ack-task','ack-user',true,1,$1,$1)",
		[due],
	);
	expect(
		await redeemAckCapability(db, token, "capability", due.getTime()),
	).toBe("ack-user");
	const row = (
		await admin.query(
			"select overdue_suppressed_due_at from task_notification_recipient where task_id='ack-task'",
		)
	).rows[0];
	expect(row.overdue_suppressed_due_at).toEqual(due);
	expect(
		(await admin.query("select due_at from task where id='ack-task'")).rows[0]
			.due_at,
	).toEqual(new Date("2026-08-02T09:00:00Z"));
});

async function blockedBy(pid: number): Promise<number> {
	const until = Date.now() + 4_000;
	while (Date.now() < until) {
		const rows = (
			await admin.query<{ pid: number }>(
				"select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))",
				[pid],
			)
		).rows;
		if (rows[0]) return rows[0].pid;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`No transaction blocked by ${pid}`);
}

test("an earlier task writer fences acknowledgement before token consumption", async () => {
	const writer = await admin.connect();
	let redeem: Promise<string | null> | undefined;
	try {
		await writer.query("begin");
		const pid = (await writer.query("select pg_backend_pid() as pid")).rows[0]
			.pid;
		await writer.query("select id from task where id='ack-task' for update");
		await writer.query(
			"insert into task_notification_activation (task_id,status,generation) values ('ack-task','pending',1)",
		);
		redeem = redeemAckCapability(db, token, "capability");
		expect(await blockedBy(pid)).toBeGreaterThan(0);
		await writer.query("commit");
		expect(await redeem).toBeNull();
		expect(await result()).toEqual({
			done: false,
			status: "pending",
			consumed_at: null,
			awards: 0,
		});
	} finally {
		await writer.query("rollback");
		writer.release();
		await redeem;
	}
});

test("acknowledgement holds the task lock through capability consumption", async () => {
	const tokenHolder = await admin.connect();
	const writer = await admin.connect();
	let redeem: Promise<string | null> | undefined;
	let writing: Promise<unknown> | undefined;
	try {
		await tokenHolder.query("begin");
		const holderPid = (
			await tokenHolder.query("select pg_backend_pid() as pid")
		).rows[0].pid;
		await tokenHolder.query(
			"select id from ack_capability where id='ack-cap' for update",
		);
		redeem = redeemAckCapability(db, token, "capability");
		const ackPid = await blockedBy(holderPid);
		await writer.query("begin");
		const writerPid = (await writer.query("select pg_backend_pid() as pid"))
			.rows[0].pid;
		writing = writer.query(
			"select id from task where id='ack-task' for update",
		);
		expect(await blockedBy(ackPid)).toBe(writerPid);
		await tokenHolder.query("commit");
		expect(await redeem).toBe("ack-user");
		await writing;
		await writer.query("commit");
		expect((await result()).done).toBe(true);
	} finally {
		await tokenHolder.query("rollback");
		await redeem;
		await writing;
		await writer.query("rollback");
		tokenHolder.release();
		writer.release();
	}
});
