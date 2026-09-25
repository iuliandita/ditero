import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	ActivationTransitionConflict,
	publishManualTaskRecipients,
	reconcileActiveTaskRecipients,
} from "../../src/zero/task-activation-transition.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString });
const digest = "a".repeat(64);
const original = new Date("2026-08-01T00:00:00Z");
const due = new Date("2026-07-01T00:00:00Z");

beforeAll(async () => {
	await pool.query(`do $$ begin if not exists (select from pg_roles where rolname='ditero_manual_publication_test') then
		create role ditero_manual_publication_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`);
	await pool.query(
		"grant usage on schema public to ditero_manual_publication_test",
	);
	await pool.query(
		"grant select,insert,update,delete on all tables in schema public to ditero_manual_publication_test",
	);
});

beforeEach(async () => {
	await resetAuthFixture(pool);
	await pool.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		select id,id,id||'@example.test',false,now(),now() from unnest(array['owner','returning','new']) as id`);
	await pool.query(
		"insert into workspace (id,name,owner_id,kind) values ('space','Space','owner','shared')",
	);
	await pool.query(`insert into membership (id,user_id,workspace_id,role)
		select id||'-seat',id,'space','owner'::role from unnest(array['owner','returning','new']) as id`);
	await pool.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('list','space','owner','List','tasks','a0')",
	);
	await pool.query(
		"insert into task (id,list_id,title,sort_key,due_at) values ('task','list','Task','a0',$1)",
		[due],
	);
	await pool.query(
		"insert into task_notification_activation (task_id,status,generation) values ('task','pending',1)",
	);
});

afterAll(async () => {
	await resetAuthFixture(pool);
	await pool.end();
});

async function locked<T>(
	run: (
		query: (sql: string, args: unknown[]) => Promise<Record<string, unknown>[]>,
		client: PoolClient,
	) => Promise<T>,
	userId = "owner",
) {
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query("set local role ditero_manual_publication_test");
		await client.query("select set_config('ditero.user_id',$1,true)", [userId]);
		await client.query('select id from "user" order by id for update');
		await client.query("select id from workspace order by id for share");
		await client.query("select id from membership order by id for share");
		await client.query("select id from list order by id for share");
		await client.query("select id from task where id='task' for update");
		const result = await run(
			async (sql, args) => (await client.query(sql, args)).rows,
			client,
		);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

function authority(rows = 0) {
	return {
		userIds: ["new", "owner", "returning"],
		workspaceIds: ["space"],
		evidence: { rows, bytes: 0 },
	};
}

test("first manual publication activates the owner and initializes immutable cutoff", async () => {
	await locked((query) =>
		publishManualTaskRecipients(query, "task", authority(), 1, digest),
	);
	const guard = (
		await pool.query(
			"select * from task_notification_activation where task_id='task'",
		)
	).rows[0];
	expect(guard).toMatchObject({
		status: "active",
		generation: 2,
		completion_mode: "manual",
		manual_review_digest: digest,
	});
	expect(guard.import_occurrence_cutoff).toEqual(
		guard.recipient_generation_cutoff,
	);
	const row = (
		await pool.query(
			"select * from task_notification_recipient where task_id='task'",
		)
	).rows[0];
	expect(row).toMatchObject({
		user_id: "owner",
		active: true,
		generation: 2,
		overdue_suppressed_due_at: due,
	});
	expect(row.cutoff).toEqual(guard.recipient_generation_cutoff);
});

test("blocked publication retains returning suppression and deactivates displaced owner", async () => {
	await pool.query(
		"update task_notification_activation set status='blocked',import_occurrence_cutoff=$1,recipient_generation_cutoff=$1 where task_id='task'",
		[original],
	);
	await pool.query(
		"insert into task_assignee (id,task_id,user_id) values ('pair-r','task','returning'),('pair-n','task','new')",
	);
	await pool.query(
		`insert into task_notification_recipient (task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','owner',true,1,$1,$2),('task','returning',false,1,$1,null)`,
		[original, due],
	);
	await locked((query) =>
		publishManualTaskRecipients(query, "task", authority(), 1, digest),
	);
	const rows = (
		await pool.query(
			"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient order by user_id",
		)
	).rows;
	expect(rows).toEqual([
		{
			user_id: "new",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: due,
		},
		{
			user_id: "owner",
			active: false,
			generation: 1,
			overdue_suppressed_due_at: due,
		},
		{
			user_id: "returning",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: null,
		},
	]);
	expect(
		(
			await pool.query(
				"select import_occurrence_cutoff from task_notification_activation",
			)
		).rows[0].import_occurrence_cutoff,
	).toEqual(original);
});

test("stale generation rejects before recipient writes", async () => {
	await expect(
		locked((query) =>
			publishManualTaskRecipients(query, "task", authority(), 2, digest),
		),
	).rejects.toBeInstanceOf(ActivationTransitionConflict);
	expect(
		(await pool.query("select * from task_notification_recipient")).rows,
	).toEqual([]);
	expect(
		(
			await pool.query(
				"select status,generation from task_notification_activation",
			)
		).rows,
	).toEqual([{ status: "pending", generation: 1 }]);
});

test("ordinary later recipient transition clears the manual confirmation receipt", async () => {
	await locked((query) =>
		publishManualTaskRecipients(query, "task", authority(), 1, digest),
	);
	await locked(async (query, client) => {
		await client.query(
			"insert into task_assignee (id,task_id,user_id) values ('pair-new','task','new')",
		);
		await reconcileActiveTaskRecipients(query, "task", authority());
	});
	expect(
		(
			await pool.query(
				"select generation,manual_review_digest from task_notification_activation",
			)
		).rows,
	).toEqual([{ generation: 3, manual_review_digest: null }]);
});

test("prospective new recipients are included in the aggregate evidence limit", async () => {
	await expect(
		locked((query) =>
			publishManualTaskRecipients(query, "task", authority(50_000), 1, digest),
		),
	).rejects.toThrow("exceeds import limit");
	expect(
		(await pool.query("select * from task_notification_recipient")).rows,
	).toEqual([]);
});

test("an RLS-hidden guard cannot be published as a native task", async () => {
	await expect(
		locked(
			(query) =>
				publishManualTaskRecipients(query, "task", authority(), 1, digest),
			"unknown",
		),
	).rejects.toBeInstanceOf(ActivationTransitionConflict);
	expect(
		(await pool.query("select status from task_notification_activation")).rows,
	).toEqual([{ status: "pending" }]);
});
