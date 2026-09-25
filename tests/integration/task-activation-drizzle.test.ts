import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	withDrizzleProducerActivationScan,
	withDrizzleProducerTaskActivation,
} from "../../src/server/notifications/task-activation-drizzle.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL, max: 1 });
const db = drizzle(runtime, { schema: tables });

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_activation_drizzle_test') then create role ditero_activation_drizzle_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_activation_drizzle_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_activation_drizzle_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_activation_drizzle_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('owner', 'Owner', 'owner@example.test', false, now(), now())`,
	);
	await admin.query(
		"insert into workspace (id, name, owner_id, kind) values ('space', 'Shared', 'owner', 'shared')",
	);
	await admin.query(
		"insert into membership (id, user_id, workspace_id, role) values ('seat', 'owner', 'space', 'owner')",
	);
	await admin.query(
		"insert into list (id, workspace_id, owner_id, title, sort_key) values ('list', 'space', 'owner', 'List', 'a0')",
	);
	await admin.query(
		"insert into task (id, list_id, title, sort_key) values ('guarded', 'list', 'Guarded', 'a0'), ('native', 'list', 'Native', 'a1')",
	);
	await admin.query(
		"insert into task_notification_activation (task_id, status, generation) values ('guarded', 'pending', 1)",
	);
	await admin.query(
		"insert into task_notification_recipient (task_id, user_id, active, generation) values ('guarded', 'owner', false, 1)",
	);
});

afterAll(async () => {
	try {
		await admin.query("delete from task where id in ('guarded', 'native')");
		await admin.query("delete from list where id = 'list'");
		await admin.query("delete from membership where id = 'seat'");
		await admin.query("delete from workspace where id = 'space'");
		await admin.query("delete from \"user\" where id = 'owner'");
	} finally {
		await runtime.end();
		await admin.end();
	}
});

test("producer scan sees protected rows and task lookup distinguishes pending from native", async () => {
	await db.transaction(async (tx) => {
		const identity = await tx.execute<{
			role: string;
			rolbypassrls: boolean;
		}>(
			sql`select current_user as role, rolbypassrls from pg_roles where rolname = current_user`,
		);
		expect(identity.rows[0]).toEqual({
			role: "ditero_activation_drizzle_test",
			rolbypassrls: false,
		});
		expect(
			(await tx.execute(sql`select task_id from task_notification_activation`))
				.rows,
		).toEqual([]);
		await withDrizzleProducerActivationScan(tx, async (scoped) => {
			expect(
				(
					await scoped.execute(
						sql`select task_id from task_notification_activation`,
					)
				).rows,
			).toMatchObject([{ task_id: "guarded" }]);
			expect(
				(
					await scoped.execute(
						sql`select task_id from task_notification_recipient`,
					)
				).rows,
			).toMatchObject([{ task_id: "guarded" }]);
		});
		expect(
			(
				await tx.execute<{ scope: string }>(
					sql`select current_setting('ditero.activation_scope', true) as scope`,
				)
			).rows[0]?.scope,
		).toBe("");
		await withDrizzleProducerTaskActivation(
			tx,
			"guarded",
			async (lookup, sameTx) => {
				expect(sameTx).toBe(tx);
				expect(lookup).toMatchObject({ kind: "guarded", status: "pending" });
			},
		);
		await withDrizzleProducerTaskActivation(tx, "native", async (lookup) => {
			expect(lookup).toEqual({ kind: "native", taskId: "native" });
		});
	});
});

test("failed callback aborts the transaction and the local scope does not leak", async () => {
	const failure = new Error("producer rejected");
	await expect(
		db.transaction((tx) =>
			withDrizzleProducerTaskActivation(tx, "guarded", async () => {
				throw failure;
			}),
		),
	).rejects.toBe(failure);
	await db.transaction(async (tx) => {
		const scope = await tx.execute<{ scope: string | null }>(
			sql`select current_setting('ditero.activation_scope', true) as scope`,
		);
		expect([null, ""]).toContain(scope.rows[0]?.scope);
	});
});

test("active guard cutoffs are UTC instants on the restricted Drizzle transaction", async () => {
	await admin.query(
		`update task_notification_activation set status = 'active', completion_mode = 'import',
		 import_occurrence_cutoff = '2026-02-01T10:00:00Z',
		 recipient_generation_cutoff = '2026-02-01T11:00:00+01' where task_id = 'guarded'`,
	);
	await db.transaction(async (tx) => {
		await withDrizzleProducerTaskActivation(
			tx,
			"guarded",
			async (lookup, sameTx) => {
				expect(sameTx).toBe(tx);
				expect(lookup).toMatchObject({
					kind: "guarded",
					status: "active",
					completionMode: "import",
				});
				if (lookup.kind !== "guarded")
					throw new Error("Expected guarded lookup");
				expect(lookup.importOccurrenceCutoff?.toISOString()).toBe(
					"2026-02-01T10:00:00.000Z",
				);
				expect(lookup.recipientGenerationCutoff?.toISOString()).toBe(
					"2026-02-01T10:00:00.000Z",
				);
			},
		);
	});
});

test("autocommit database execution cannot retain the producer scope", async () => {
	type Transaction = Parameters<typeof withDrizzleProducerActivationScan>[0];
	await expect(
		withDrizzleProducerActivationScan(
			db as unknown as Transaction,
			async () => {},
		),
	).rejects.toThrow(/transaction/);
});
