import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	ProducerAuthorityChanged,
	withProducerAuthority,
} from "../../src/server/notifications/producer-authority.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL, max: 1 });
const db = drizzle(runtime, { schema: tables });
const occurrence = new Date("2026-02-01T10:00:00.000Z");
const before = new Date("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_producer_authority_test') then create role ditero_producer_authority_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_producer_authority_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_producer_authority_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_producer_authority_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('owner', 'Owner', 'owner@example.test', false, now(), now()),
			('member', 'Member', 'member@example.test', false, now(), now()),
			('fallback', 'Fallback', 'fallback@example.test', false, now(), now()),
			('other', 'Other', 'other@example.test', false, now(), now())`,
	);
	await admin.query(
		"insert into workspace (id, name, owner_id, kind) values ('space', 'Shared', 'owner', 'shared')",
	);
	await admin.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ('seat-owner', 'owner', 'space', 'owner'), ('seat-member', 'member', 'space', 'member'),
		 ('seat-fallback', 'fallback', 'space', 'member')`,
	);
	await admin.query(
		"insert into list (id, workspace_id, owner_id, title, sort_key) values ('list', 'space', 'owner', 'List', 'a0')",
	);
	await admin.query(
		`insert into task (id, list_id, title, sort_key, repeat_every_min, max_repeats) values
		 ('guarded', 'list', 'Guarded', 'a0', 1, 1), ('native', 'list', 'Native', 'a1', 1, 1)`,
	);
	await admin.query(
		`insert into task_assignee (id, task_id, user_id) values
		 ('guarded:member', 'guarded', 'member'), ('native:member', 'native', 'member')`,
	);
	await admin.query(
		"insert into task_notification_activation (task_id, status, generation) values ('guarded', 'pending', 1)",
	);
	await admin.query(
		"insert into task_notification_recipient (task_id, user_id, active, generation) values ('guarded', 'member', false, 1)",
	);
});

afterAll(async () => {
	await runtime.end();
	await admin.end();
});

async function activate(cutoff: Date = before) {
	await admin.query(
		`update task_notification_activation set status = 'active', completion_mode = 'import',
		 import_occurrence_cutoff = $1, recipient_generation_cutoff = $1 where task_id = 'guarded'`,
		[cutoff],
	);
	await admin.query(
		"update task_notification_recipient set active = true, cutoff = $1 where task_id = 'guarded' and user_id = 'member'",
		[cutoff],
	);
}

test("restricted runtime skips pending and admits native with scope cleared", async () => {
	await db.transaction(async (tx) => {
		const role = await tx.execute<{ role: string; rolbypassrls: boolean }>(
			sql`select current_user as role, rolbypassrls from pg_roles where rolname = current_user`,
		);
		expect(role.rows[0]).toEqual({
			role: "ditero_producer_authority_test",
			rolbypassrls: false,
		});
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async () => "sent",
			),
		).toEqual({ kind: "skip" });
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "native",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async (authority, sameTx) => {
					expect(sameTx).toBe(tx);
					expect(authority.lookup.kind).toBe("native");
					expect(authority.recipientKind).toBe("base");
					return "sent";
				},
			),
		).toEqual({ kind: "eligible", value: "sent" });
		expect(
			(
				await tx.execute<{ scope: string }>(
					sql`select current_setting('ditero.activation_scope', true) as scope`,
				)
			).rows[0]?.scope,
		).toBe("");
	});
});

test("guarded base honors the global occurrence cutoff", async () => {
	await activate(new Date("2026-03-01T00:00:00.000Z"));
	await db.transaction(async (tx) => {
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async () => "sent",
			),
		).toEqual({ kind: "skip" });
	});
});

test("guarded base honors its recipient cutoff", async () => {
	await activate();
	await db.transaction(async (tx) => {
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async (authority) => {
					expect(authority.recipientEvidence).toMatchObject({
						active: true,
						generation: 1,
					});
					return "sent";
				},
			),
		).toEqual({ kind: "eligible", value: "sent" });
	});
	await admin.query(
		"update task_notification_recipient set cutoff = '2026-03-01T00:00:00Z' where task_id = 'guarded' and user_id = 'member'",
	);
	await db.transaction(async (tx) => {
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async () => "sent",
			),
		).toEqual({ kind: "skip" });
	});
});

test("guarded fallback needs a current escalated base origin and current preference target", async () => {
	await activate();
	await admin.query(
		"insert into user_pref (id, escalation_defaults) values ('member', '{\"fallbackUserId\":\"fallback\"}'::jsonb)",
	);
	await admin.query(
		"insert into reminder_state (id, task_id, occurrence_at, recipient_user_id, status, fire_count) values ('origin', 'guarded', $1, 'member', 'escalated', 1), ('sibling', 'guarded', $1, 'fallback', 'pending', 1)",
		[occurrence],
	);
	await db.transaction(async (tx) => {
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "fallback",
					occurrenceAt: occurrence,
					reminderStateId: "sibling",
				},
				async (authority) => {
					expect(authority.recipientKind).toBe("fallback");
					expect(authority.originReminderState?.id).toBe("origin");
					return "sent";
				},
			),
		).toEqual({ kind: "eligible", value: "sent" });
	});
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
	);
	await db.transaction(async (tx) => {
		expect(
			await withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "guarded",
					recipientUserId: "fallback",
					occurrenceAt: occurrence,
					reminderStateId: "sibling",
				},
				async () => "sent",
			),
		).toEqual({ kind: "skip" });
	});
});

test("removed recipient membership cannot receive a native or guarded task", async () => {
	await activate();
	await admin.query("delete from membership where id = 'seat-member'");
	for (const taskId of ["native", "guarded"]) {
		await db.transaction(async (tx) => {
			expect(
				await withProducerAuthority(
					tx,
					{
						kind: "reminder",
						taskId,
						recipientUserId: "member",
						occurrenceAt: occurrence,
					},
					async () => "sent",
				),
			).toEqual({ kind: "skip" });
		});
	}
});

test("changed preference target and changed membership signal fresh-transaction retry", async () => {
	await admin.query(
		"insert into user_pref (id, escalation_defaults) values ('member', '{\"fallbackUserId\":\"fallback\"}'::jsonb)",
	);
	await expect(
		db.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "native",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async () => "sent",
				{
					onAfterDiscovery: async () => {
						await admin.query(
							"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
						);
					},
				},
			),
		),
	).rejects.toBeInstanceOf(ProducerAuthorityChanged);
	await expect(
		db.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: "native",
					recipientUserId: "member",
					occurrenceAt: occurrence,
				},
				async () => "sent",
				{
					onAfterDiscovery: async () => {
						await admin.query(
							"delete from membership where id = 'seat-member'",
						);
					},
				},
			),
		),
	).rejects.toBeInstanceOf(ProducerAuthorityChanged);
});
