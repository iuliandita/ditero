import { readFile } from "node:fs/promises";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { createManagedAccount } from "../../src/auth/managed-account.ts";
import * as tables from "../../src/db/schema.ts";
import {
	claimBatch,
	completeDelivery,
} from "../../src/server/notifications/worker.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
const zero = zeroNodePg(schema, runtime);
const db = drizzle(admin, { schema: tables });
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
		('administrator','Administrator','administrator@example.test'),
		('other','Other','other@example.test'), ('child','Child','child@managed.invalid')`);
	await admin.query(`insert into workspace(id,name,owner_id,kind) values
		('ws','Shared','owner','shared'), ('elsewhere','Elsewhere','owner','shared')`);
	await admin.query(`insert into membership(id,user_id,workspace_id,role) values
		('ma','administrator','ws','admin'),('mo','owner','ws','owner'),('md','departing','ws','member'),('mx','other','ws','member'),
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
	optimistic = false,
) {
	return zero.transaction((tx) =>
		withZeroUserContext(tx, actor, async () => {
			const mutator = leave
				? mutators.membership.leave
				: mutators.membership.remove;
			const clientTx = optimistic
				? new Proxy(tx, {
						get(target, property) {
							if (property === "location") return "client";
							const value = Reflect.get(target, property);
							return typeof value === "function" ? value.bind(target) : value;
						},
					})
				: tx;
			await mutator.fn({ tx: clientTx, ctx: { id: actor }, args: { id } });
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
	["owner", false],
	["administrator", false],
	["departing", true],
] as const)("removal terminates workspace notices and reminders (%s, leave=%s)", async (actor, leave) => {
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({ rolsuper: false, rolbypassrls: false });
	await admin.query(`insert into reminder_state(id,task_id,occurrence_at,recipient_user_id,status,deferred_until)
		values ('reminder','task',now(),'departing','deferred',now()+interval '1 hour'),
		('escalated','task',now()+interval '1 minute','departing','escalated',null)`);
	await outbox("queued");
	await outbox("workspace");
	await outbox("outside-workspace");
	await admin.query(`update notification_outbox set payload=jsonb_build_object('kind','key-request','workspaceId',
		case when id='workspace' then 'ws' else 'elsewhere' end) where id in ('workspace','outside-workspace')`);
	await outbox("leased", "task", "departing", "sending");
	await outbox("reminder-queued", "task", "departing", "queued", "reminder");
	await outbox("sent", "task", "departing", "sent");
	await outbox("other-member", "task", "other");
	await outbox("other-workspace", "outside-task");
	await remove(actor, "md", leave);
	const rows = (
		await admin.query(
			"select id,status,claimed_by,claimed_at from notification_outbox order by id",
		)
	).rows;
	for (const id of ["queued", "leased", "reminder-queued", "workspace"])
		expect.soft(rows.find((row) => row.id === id)).toMatchObject({
			status: "abandoned",
			claimed_by: null,
			claimed_at: null,
		});
	expect(rows.find((row) => row.id === "sent").status).toBe("sent");
	for (const id of ["other-member", "other-workspace", "outside-workspace"])
		expect(rows.find((row) => row.id === id).status).toBe("queued");
	expect(
		(
			await admin.query(
				"select id,status,next_attempt_at,deferred_until from reminder_state order by id",
			)
		).rows,
	).toEqual(
		["escalated", "reminder"].map((id) => ({
			id,
			status: "expired",
			next_attempt_at: null,
			deferred_until: null,
		})),
	);
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
		await client.query(
			"select set_config('ditero.removal_target','other',true)",
		);
		expect
			.soft(
				(
					await client.query("select id from inbound_webhook where id=$1", [
						hookId,
					])
				).rows,
			)
			.toEqual([]);
		expect(
			(
				await client.query(
					"update inbound_webhook set revoked_at=now() where id=$1 returning id",
					[hookId],
				)
			).rows,
		).toEqual([]);
		await client.query(
			"select set_config('ditero.removal_target','departing',true)",
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
	for (const optimistic of [true, false]) {
		await expect
			.soft(
				remove(leave ? "departing" : "owner", "md", leave, false, optimistic),
			)
			.rejects.toThrow('[names:["Child"]] [code:guardian_has_managed_members]');
	}
	for (const actor of ["owner", "administrator", "other"]) {
		const markers = await zero.transaction((tx) =>
			withZeroUserContext(tx, actor, () =>
				tx.run(
					queries.managedAccounts.mine.fn({
						ctx: { id: actor },
						args: undefined,
					}),
				),
			),
		);
		expect(markers.map((row) => row.id)).toEqual(
			actor === "other" ? [] : ["managed"],
		);
	}
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

test("upgrade permanently revokes only webhooks without a workspace membership", async () => {
	await admin.query(
		`insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,expires_at)
		values ('00000000-0000-4000-8000-000000000002','other','list','ws','Active',$1,'test',now()+interval '1 day')`,
		["b".repeat(64)],
	);
	await admin.query("delete from membership where id='md'");
	await admin.query(
		await readFile(
			new URL(
				"../../drizzle/0096_revoke_departed_webhooks.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const rows = (
		await admin.query("select id,revoked_at from inbound_webhook order by id")
	).rows;
	expect(rows[0].revoked_at).toBeInstanceOf(Date);
	expect(rows[1].revoked_at).toBeNull();
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('rejoined','departing','ws','member')",
	);
	expect(
		(
			await admin.query("select revoked_at from inbound_webhook where id=$1", [
				hookId,
			])
		).rows[0].revoked_at,
	).toEqual(rows[0].revoked_at);
});

test("worker claims skip an ongoing removal and late completion cannot restore abandoned work", async () => {
	await outbox("leased");
	await admin.query("update notification_outbox set next_attempt_at=now()");
	const [leased] = await claimBatch(db, 1, "worker");
	expect(leased?.id).toBe("leased");
	await outbox("queued");
	await admin.query(
		"update notification_outbox set next_attempt_at=now() where id='queued'",
	);
	await zero.transaction((tx) =>
		withZeroUserContext(tx, "owner", async () => {
			await mutators.membership.remove.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: "md" },
			});
			expect(await claimBatch(db, 10, "racing-worker")).toEqual([]);
		}),
	);
	expect(await claimBatch(db, 10, "racing-worker")).toEqual([]);
	expect(
		(await completeDelivery(db, leased, { ok: true, status: 200 }, "worker"))
			.applied,
	).toBe(false);
	expect(
		(await admin.query("select distinct status from notification_outbox")).rows,
	).toEqual([{ status: "abandoned" }]);
});

test.each([
	"creation",
	"removal",
] as const)("managed provisioning and guardian removal serialize (%s wins)", async (winner) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reached!: () => void;
	const barrier = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const api = new Proxy(auth.api, {
		get(target, key, receiver) {
			if (key !== "signUpEmail") return Reflect.get(target, key, receiver);
			return async (input: Parameters<typeof auth.api.signUpEmail>[0]) => {
				const result = await auth.api.signUpEmail(input);
				if (winner === "removal") {
					reached();
					await held;
				}
				return result;
			};
		},
	});
	type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
	const guardedDb = new Proxy(db, {
		get(target, key) {
			if (key === "transaction")
				return (fn: (tx: Tx) => Promise<unknown>) =>
					target.transaction((tx) =>
						fn(
							new Proxy(tx, {
								get(target, key) {
									if (key === "insert")
										return (table: Parameters<Tx["insert"]>[0]) => {
											if (
												table !== tables.managedAccount ||
												winner !== "creation"
											)
												return target.insert(table);
											return {
												values: async (
													values: typeof tables.managedAccount.$inferInsert,
												) => {
													reached();
													await held;
													return target
														.insert(tables.managedAccount)
														.values(values);
												},
											};
										};
									const value = Reflect.get(target, key);
									return typeof value === "function"
										? value.bind(target)
										: value;
								},
							}),
						),
					);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const creation = createManagedAccount(
		{
			guardianId: "departing",
			workspaceId: "ws",
			displayName: "New child",
			password: "managed-review-password",
		},
		guardedDb,
		{ api },
		{},
	);
	// Attach rejection handlers before releasing either competing operation.
	const created = creation.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
	let removal: Promise<unknown> | undefined;
	try {
		await Promise.race([
			barrier,
			creation.then(() => {
				throw new Error("provisioning barrier bypassed");
			}),
		]);
		if (winner === "removal") {
			await remove();
			release();
			const result = await created;
			expect(result).toMatchObject({ ok: false, error: { status: 403 } });
			expect(
				(
					await admin.query(
						"select id from managed_account where guardian_id='departing'",
					)
				).rows,
			).toEqual([]);
		} else {
			removal = remove().then(
				() => "removed",
				(error: unknown) => error,
			);
			await vi.waitFor(
				async () => {
					expect(
						(
							await admin.query(
								"select pid from pg_stat_activity where datname=current_database() and cardinality(pg_blocking_pids(pid))>0 and query like '%select id,deleted_at from%'",
							)
						).rows,
					).toHaveLength(1);
				},
				{ timeout: 5000 },
			);
			release();
			expect((await created).ok).toBe(true);
			expect(await removal).toMatchObject({
				code: "guardian_has_managed_members",
			});
			expect(
				(await admin.query("select id from membership where id='md'")).rows,
			).toHaveLength(1);
		}
	} finally {
		release();
		await created;
		if (removal) await removal;
	}
}, 30000);
