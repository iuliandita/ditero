import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import { withProducerTaskActivation } from "../../src/server/notifications/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const cutoff = "2026-09-20T12:00:00Z";
const later = "2026-09-21T12:00:00Z";

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_activation_test') then create role ditero_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query("grant usage on schema public to ditero_activation_test");
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	for (const id of ["owner", "member", "viewer", "outsider"]) {
		await admin.query(
			'insert into "user" (id,name,email,email_verified,created_at,updated_at) values ($1,$1,$2,false,now(),now())',
			[id, `${id}@example.test`],
		);
	}
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('space','Shared','owner','shared')",
	);
	for (const [id, role] of [
		["owner", "owner"],
		["member", "member"],
		["viewer", "viewer"],
	]) {
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,'space',$3)",
			[`membership-${id}`, id, role],
		);
	}
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ('list','space','owner','Shared','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('task','list','Imported','a0')",
	);
	await admin.query(
		`insert into task_notification_activation
		 (task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,
		  completion_mode,owning_source_id,owning_owner_user_id,owning_job_id,
		  readiness_ordinal,expected_relationship_digest,expected_relationship_count,
		  expected_relationship_bytes,expected_relationships)
		 values ('task','active',1,$1,$1,'import','source','owner','job',0,repeat('a',64),0,2,'{}')`,
		[cutoff],
	);
	await admin.query(
		"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff) values ('task','member',true,1,$1)",
		[cutoff],
	);
});

afterAll(async () => {
	await runtime.end();
	await admin.end();
});

async function withScope<T>(
	scope: string,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("select set_config('ditero.activation_scope',$1,true)", [
			scope,
		]);
		const result = await callback(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

test("FORCE RLS exposes evidence to live members and only exact service scopes", async () => {
	for (const table of [
		"task_notification_activation",
		"task_notification_recipient",
	]) {
		expect((await runtime.query(`select * from ${table}`)).rows).toEqual([]);
		for (const userId of ["owner", "member", "viewer"]) {
			await withUserContext(runtime, userId, async (client) => {
				expect((await client.query(`select * from ${table}`)).rowCount).toBe(1);
			});
		}
		await withUserContext(runtime, "outsider", async (client) => {
			expect((await client.query(`select * from ${table}`)).rows).toEqual([]);
		});
		for (const scope of ["producer", "invite", "ack", "account-delete"]) {
			await withScope(scope, async (client) => {
				expect((await client.query(`select * from ${table}`)).rowCount).toBe(1);
			});
		}
		await withScope("producer-typo", async (client) => {
			expect((await client.query(`select * from ${table}`)).rows).toEqual([]);
		});
	}
	await admin.query("delete from membership where user_id = 'viewer'");
	await withUserContext(runtime, "viewer", async (client) => {
		expect(
			(await client.query("select * from task_notification_activation")).rows,
		).toEqual([]);
	});
});

test("a deleted account with retained membership loses evidence access", async () => {
	await admin.query(
		"update \"user\" set deleted_at = now() where id = 'member'",
	);
	await withUserContext(runtime, "member", async (client) => {
		for (const table of [
			"task_notification_activation",
			"task_notification_recipient",
		]) {
			expect((await client.query(`select * from ${table}`)).rows).toEqual([]);
			expect(
				(
					await client.query(
						`update ${table} set updated_at = now() where task_id = 'task'`,
					)
				).rowCount,
			).toBe(0);
		}
	});
});

test("authoritative producer lookup distinguishes native and pending inside BEGIN", async () => {
	await withScope("", async (client) => {
		expect(
			(
				await client.query(
					"select current_setting('ditero.user_id',true) as user_id",
				)
			).rows[0].user_id,
		).toBeFalsy();
		await withProducerTaskActivation(client, "task", async (lookup) => {
			expect(lookup).toMatchObject({
				kind: "guarded",
				status: "active",
				generation: 1,
			});
		});
		expect(
			(
				await client.query(
					"select current_setting('ditero.activation_scope',true) as scope",
				)
			).rows[0].scope,
		).toBe("");
	});
	await admin.query(
		"update task_notification_activation set status = 'pending', completion_mode = null where task_id = 'task'",
	);
	await withScope("", async (client) => {
		expect(
			(
				await client.query(
					"select current_setting('ditero.user_id',true) as user_id",
				)
			).rows[0].user_id,
		).toBeFalsy();
		await withProducerTaskActivation(client, "task", async (lookup) => {
			expect(lookup).toMatchObject({ kind: "guarded", status: "pending" });
		});
	});
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('native','list','Native','a1')",
	);
	await withScope("", async (client) => {
		expect(
			(
				await client.query(
					"select current_setting('ditero.user_id',true) as user_id",
				)
			).rows[0].user_id,
		).toBeFalsy();
		await withProducerTaskActivation(client, "native", async (lookup) => {
			expect(lookup).toEqual({ kind: "native", taskId: "native" });
		});
	});
	await expect(
		withProducerTaskActivation(
			runtime as unknown as PoolClient,
			"task",
			async () => {},
		),
	).rejects.toThrow(/transaction/);
});

test("member writes require empty service scope and writable membership", async () => {
	await withUserContext(runtime, "member", async (client) => {
		expect(
			(
				await client.query(
					"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff) values ('task','owner',true,1,$1)",
					[cutoff],
				)
			).rowCount,
		).toBe(1);
		expect(
			(
				await client.query(
					"update task_notification_activation set updated_at = now() where task_id = 'task'",
				)
			).rowCount,
		).toBe(1);
	});
	await expect(
		withUserContext(runtime, "viewer", (client) =>
			client.query(
				"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff) values ('task','viewer',true,1,$1)",
				[cutoff],
			),
		),
	).rejects.toThrow(/row-level security/i);
	for (const userId of ["viewer", "outsider"]) {
		await withUserContext(runtime, userId, async (client) => {
			expect(
				(
					await client.query(
						"update task_notification_activation set updated_at = now() where task_id = 'task'",
					)
				).rowCount,
			).toBe(0);
		});
	}
	await withUserContext(runtime, "member", async (client) => {
		await client.query(
			"select set_config('ditero.activation_scope','producer',true)",
		);
		expect(
			(
				await client.query(
					"update task_notification_recipient set updated_at = now() where task_id = 'task'",
				)
			).rowCount,
		).toBe(0);
	});
	await expect(
		withScope("producer", (client) =>
			client.query(
				"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff) values ('task','outsider',true,1,$1)",
				[cutoff],
			),
		),
	).rejects.toThrow(/row-level security/i);
	await withScope("producer", async (client) => {
		expect(
			(
				await client.query(
					"delete from task_notification_activation where task_id = 'task'",
				)
			).rowCount,
		).toBe(0);
	});
});

test("account deletion scope can only block and deactivate", async () => {
	await withScope("account-delete", async (client) => {
		expect(
			(
				await client.query(
					"update task_notification_activation set status = 'blocked', completion_mode = null, blocked_reason = 'account-deleted' where task_id = 'task'",
				)
			).rowCount,
		).toBe(1);
		expect(
			(
				await client.query(
					"update task_notification_recipient set active = false where task_id = 'task'",
				)
			).rowCount,
		).toBe(1);
	});
	await expect(
		withScope("account-delete", (client) =>
			client.query(
				"update task_notification_activation set generation = 2 where task_id = 'task'",
			),
		),
	).rejects.toThrow(/account deletion may only block/i);
	await expect(
		withScope("account-delete", (client) =>
			client.query(
				"update task_notification_recipient set generation = 2 where task_id = 'task'",
			),
		),
	).rejects.toThrow(/account deletion may only deactivate/i);
});

test("cutoffs and generation cannot regress and active rows need valid state", async () => {
	for (const query of [
		"update task_notification_activation set generation = 0 where task_id = 'task'",
		"update task_notification_activation set generation = 2, import_occurrence_cutoff = '2026-09-19' where task_id = 'task'",
		"update task_notification_activation set recipient_generation_cutoff = '2026-09-19' where task_id = 'task'",
		"update task_notification_activation set recipient_generation_cutoff = null where task_id = 'task'",
		"update task_notification_activation set readiness_ordinal = -1 where task_id = 'task'",
		"update task_notification_activation set status = 'bad' where task_id = 'task'",
		"update task_notification_activation set completion_mode = null where task_id = 'task'",
		"update task_notification_activation set blocked_reason = repeat('x',129) where task_id = 'task'",
		"update task_notification_activation set expected_relationship_count = 50001 where task_id = 'task'",
		"update task_notification_activation set expected_relationship_bytes = 3 where task_id = 'task'",
		"update task_notification_recipient set generation = 0 where task_id = 'task'",
		"update task_notification_recipient set cutoff = '2026-09-19' where task_id = 'task'",
		"update task_notification_recipient set cutoff = null where task_id = 'task'",
	]) {
		await expect(admin.query(query)).rejects.toThrow();
	}
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('other','list','Other','a1')",
	);
	await expect(
		admin.query(
			"insert into task_notification_activation (task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode) values ('other','active',1,$1,$2,'import')",
			[later, cutoff],
		),
	).rejects.toThrow(/task_notification_activation_cutoff_order/);
	await expect(
		admin.query(
			"insert into task_notification_recipient (task_id,user_id,active,generation) values ('other','owner',true,1)",
		),
	).rejects.toThrow(/task_notification_recipient_active_cutoff/);
	await admin.query(
		"update task_notification_activation set generation = 2, recipient_generation_cutoff = $1 where task_id = 'task'",
		[later],
	);
	await admin.query(
		"update task_notification_recipient set generation = 2, cutoff = $1 where task_id = 'task'",
		[later],
	);
	await expect(
		admin.query(
			"update task_notification_activation set generation = 1 where task_id = 'task'",
		),
	).rejects.toThrow(/cannot move backwards/i);
	await expect(
		admin.query(
			"update task_notification_recipient set generation = 1 where task_id = 'task'",
		),
	).rejects.toThrow(/cannot move backwards/i);
});

test("source and account cleanup retain evidence until the task is deleted", async () => {
	await admin.query(
		"insert into import_source (id,owner_user_id,label,format,schema_version,source_user_id) values ('source','owner','Source','ditero',1,'owner')",
	);
	await admin.query("delete from import_source where id = 'source'");
	await admin.query(
		"update \"user\" set deleted_at = now(), email = 'deleted@example.invalid' where id = 'owner'",
	);
	expect(
		(
			await admin.query(
				"select owning_source_id,owning_owner_user_id,owning_job_id from task_notification_activation where task_id = 'task'",
			)
		).rows[0],
	).toEqual({
		owning_source_id: "source",
		owning_owner_user_id: "owner",
		owning_job_id: "job",
	});
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task_notification_recipient",
			)
		).rows[0].n,
	).toBe(1);
	await admin.query("delete from task where id = 'task'");
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task_notification_activation",
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task_notification_recipient",
			)
		).rows[0].n,
	).toBe(0);
});
