import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
const zero = zeroNodePg(schema, runtime);
const hookId = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
	await admin.query(
		"create role membership_cleanup_test nosuperuser nobypassrls",
	);
	await admin.query("grant usage on schema public to membership_cleanup_test");
	await admin.query(
		"grant select,insert,update,delete on all tables in schema public to membership_cleanup_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role membership_cleanup_test");
	});
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email) values
		('owner','Owner','owner@example.test'), ('departing','Departing','departing@example.test'),
		('other','Other','other@example.test'), ('child','Child','child@managed.invalid')`);
	await admin.query(`insert into workspace(id,name,owner_id,kind) values
		('ws','Shared','owner','shared'), ('elsewhere','Elsewhere','owner','shared')`);
	await admin.query(`insert into membership(id,user_id,workspace_id,role) values
		('mo','owner','ws','owner'),('md','departing','ws','member'),('mx','other','ws','member'),
		('eo','owner','elsewhere','owner'),('ed','departing','elsewhere','member')`);
	await admin.query(`insert into list(id,workspace_id,owner_id,title,sort_key) values
		('list','ws','owner','List','a0'),('outside','elsewhere','owner','Outside','a0')`);
	await admin.query(`insert into task(id,list_id,title,sort_key) values
		('task','list','Task','a0'),('outside-task','outside','Outside','a0')`);
	await admin.query(
		`insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,expires_at)
		values ($1,'departing','list','ws','Hook',$2,'test',now()+interval '1 day')`,
		[hookId, "a".repeat(64)],
	);
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query("drop owned by membership_cleanup_test");
	await admin.query("drop role membership_cleanup_test");
	await admin.end();
});
async function remove(
	actor = "owner",
	id = "md",
	leave = false,
	rollback = false,
) {
	return zero.transaction((tx) =>
		withZeroUserContext(tx, actor, async () => {
			const mutator = leave
				? mutators.membership.leave
				: mutators.membership.remove;
			await mutator.fn({ tx, ctx: { id: actor }, args: { id } });
			if (rollback) throw new Error("rollback cleanup");
		}),
	);
}
async function outbox(
	id: string,
	taskId = "task",
	recipient = "departing",
	status = "queued",
	state: string | null = null,
) {
	await admin.query(
		`insert into notification_outbox
		(id,reminder_state_id,recipient_user_id,channel_kind,payload,idempotency_key,status,next_attempt_at,claimed_by,claimed_at)
		values ($1,$2,$3,'email',$4::jsonb,$1,$5::outbox_status,now()+interval '1 hour',
		case when $5='sending' then 'worker' end,case when $5='sending' then now() end)`,
		[
			id,
			state,
			recipient,
			JSON.stringify(state ? { kind: "reminder" } : { kind: "assign", taskId }),
			status,
		],
	);
}

test.each([
	false,
	true,
])("removal terminates workspace outbox and deferred reminders, retaining unrelated rows (leave=%s)", async (leave) => {
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({ rolsuper: false, rolbypassrls: false });
	await admin.query(`insert into reminder_state(id,task_id,occurrence_at,recipient_user_id,status,deferred_until)
		values ('reminder','task',now(),'departing','deferred',now()+interval '1 hour')`);
	await outbox("queued");
	await outbox("leased", "task", "departing", "sending");
	await outbox("reminder-queued", "task", "departing", "queued", "reminder");
	await outbox("sent", "task", "departing", "sent");
	await outbox("other-member", "task", "other");
	await outbox("other-workspace", "outside-task");
	await remove(leave ? "departing" : "owner", "md", leave);
	const rows = (
		await admin.query(
			"select id,status,claimed_by,claimed_at from notification_outbox order by id",
		)
	).rows;
	for (const id of ["queued", "leased", "reminder-queued"])
		expect.soft(rows.find((row) => row.id === id)).toMatchObject({
			status: "abandoned",
			claimed_by: null,
			claimed_at: null,
		});
	expect(rows.find((row) => row.id === "sent").status).toBe("sent");
	for (const id of ["other-member", "other-workspace"])
		expect(rows.find((row) => row.id === id).status).toBe("queued");
	expect(
		(
			await admin.query(
				"select status,deferred_until from reminder_state where id='reminder'",
			)
		).rows[0],
	).toEqual({ status: "expired", deferred_until: null });
});

test.each([
	false,
	true,
])("removal permanently revokes webhooks across rejoining (leave=%s)", async (leave) => {
	await remove(leave ? "departing" : "owner", "md", leave);
	const revoked = (
		await admin.query("select revoked_at from inbound_webhook where id=$1", [
			hookId,
		])
	).rows[0].revoked_at;
	expect(revoked).toBeInstanceOf(Date);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('rejoined','departing','ws','member')",
	);
	expect(
		(
			await admin.query("select revoked_at from inbound_webhook where id=$1", [
				hookId,
			])
		).rows[0].revoked_at,
	).toEqual(revoked);
});

test("membership cleanup policies refuse ordinary members and changes to webhook bindings", async () => {
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("select set_config('ditero.user_id','other',true)");
		await client.query(
			"select set_config('ditero.activation_scope','membership-remove',true)",
		);
		expect(
			(
				await client.query(
					"update inbound_webhook set revoked_at=now() where id=$1 returning id",
					[hookId],
				)
			).rows,
		).toEqual([]);
		await client.query("select set_config('ditero.user_id','owner',true)");
		await client.query("select set_config('ditero.activation_scope','',true)");
		expect(
			(
				await client.query(
					"update inbound_webhook set revoked_at=now() where id=$1 returning id",
					[hookId],
				)
			).rows,
		).toEqual([]);
		await client.query(
			"select set_config('ditero.activation_scope','membership-remove',true)",
		);
		await expect(
			client.query(
				"update inbound_webhook set name='changed',revoked_at=now() where id=$1",
				[hookId],
			),
		).rejects.toThrow("webhook binding is immutable");
	} finally {
		await client.query("rollback");
		client.release();
	}
});

test.each([
	false,
	true,
])("guardian must remove managed memberships first (leave=%s)", async (leave) => {
	await admin.query(
		"insert into managed_account(id,user_id,guardian_id) values ('managed','child','departing')",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('child-seat','child','ws','viewer')",
	);
	await expect(
		remove(leave ? "departing" : "owner", "md", leave),
	).rejects.toThrow("managed accounts");
	expect(
		(await admin.query("select id from membership where id='md'")).rows,
	).toHaveLength(1);
	await remove("owner", "child-seat");
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('child-other','child','elsewhere','viewer')",
	);
	await remove(leave ? "departing" : "owner", "md", leave);
	expect(
		(await admin.query("select id from membership where id='md'")).rows,
	).toEqual([]);
	expect(
		(await admin.query("select id from membership where id='child-other'"))
			.rows,
	).toHaveLength(1);
});

test("rollback preserves notification work and webhook capability with the membership", async () => {
	await outbox("queued");
	await expect(remove("owner", "md", false, true)).rejects.toThrow(
		"rollback cleanup",
	);
	expect(
		(
			await admin.query(
				"select status from notification_outbox where id='queued'",
			)
		).rows[0].status,
	).toBe("queued");
	expect(
		(
			await admin.query("select revoked_at from inbound_webhook where id=$1", [
				hookId,
			])
		).rows[0].revoked_at,
	).toBeNull();
	expect(
		(await admin.query("select id from membership where id='md'")).rows,
	).toHaveLength(1);
});
