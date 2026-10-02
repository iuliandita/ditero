import { readFile } from "node:fs/promises";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString });
const zdb = zeroNodePg(schema, pool);

beforeEach(async () => {
	await resetAuthFixture(pool);
	await pool.query(`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		select id,id,id||'@example.test',false,now(),now() from unnest(array['owner','viewer','outsider']) as id`);
	await pool.query(`insert into workspace (id,name,owner_id,kind) values
		('visible','Visible','owner','shared'), ('foreign','Foreign','outsider','shared')`);
	await pool.query(`insert into membership (id,user_id,workspace_id,role) values
		('owner-seat','owner','visible','owner'), ('viewer-seat','viewer','visible','viewer'),
		('outsider-seat','outsider','foreign','owner')`);
	await pool.query(`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values
		('visible-list','visible','owner','List','tasks','a0'),
		('foreign-list','foreign','outsider','List','tasks','a0')`);
	for (const scope of ["visible", "foreign"]) {
		for (const status of ["native", "pending", "blocked", "active"]) {
			const id = `${scope}-${status}`;
			await pool.query(
				"insert into task (id,list_id,title,sort_key) values ($1,$2,$1,$1)",
				[id, `${scope}-list`],
			);
			if (status === "native") continue;
			await pool.query(
				`insert into task_notification_activation
				(task_id,status,generation,owning_source_id,owning_owner_user_id,owning_job_id,
				import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
				values ($1,$2,1,'private-source','private-owner','private-job',$3,$3,$4)`,
				[
					id,
					status,
					status === "active" ? new Date("2026-08-01T00:00:00Z") : null,
					status === "active" ? "import" : null,
				],
			);
		}
	}
});

afterAll(async () => {
	await resetAuthFixture(pool);
	await pool.end();
});

async function visible(userId: string) {
	return (
		await zdb.run(
			queries.taskImportActivations.mine.fn({
				args: undefined,
				ctx: { id: userId },
			}),
		)
	).sort((a, b) => a.taskId.localeCompare(b.taskId));
}

test("owner and viewer see only task ID and status within their workspace", async () => {
	const expected = [
		{ taskId: "visible-active", status: "active" },
		{ taskId: "visible-blocked", status: "blocked" },
		{ taskId: "visible-pending", status: "pending" },
	];
	expect(await visible("owner")).toEqual(expected);
	expect(await visible("viewer")).toEqual(expected);
	expect(await visible("outsider")).toEqual(
		expected.map((row) => ({
			...row,
			taskId: row.taskId.replace("visible", "foreign"),
		})),
	);
});

test("revocation removes status visibility and an unknown user sees nothing", async () => {
	await pool.query("delete from membership where id='viewer-seat'");
	expect(await visible("viewer")).toEqual([]);
	expect(await visible("unknown")).toEqual([]);
});

test("the generated client schema excludes provenance and recipient evidence", () => {
	expect(
		Object.keys(schema.tables.taskNotificationActivation.columns).sort(),
	).toEqual(["status", "taskId"]);
	expect(Object.keys(schema.tables)).not.toContain("taskNotificationRecipient");
});

test("native creation is false and activation adoption atomically promotes a permanent marker", async () => {
	const markers = async () =>
		(
			await pool.query(
				"select id,has_import_activation from task where list_id='visible-list' order by id",
			)
		).rows;
	expect(await markers()).toEqual([
		{ id: "visible-active", has_import_activation: true },
		{ id: "visible-blocked", has_import_activation: true },
		{ id: "visible-native", has_import_activation: false },
		{ id: "visible-pending", has_import_activation: true },
	]);
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query(
			"insert into task_notification_activation (task_id,status,generation) values ('visible-native','pending',1)",
		);
		expect(
			(
				await client.query(
					"select has_import_activation from task where id='visible-native'",
				)
			).rows[0].has_import_activation,
		).toBe(true);
		expect(
			(
				await pool.query(
					"select has_import_activation from task where id='visible-native'",
				)
			).rows[0].has_import_activation,
		).toBe(false);
		await client.query("commit");
	} finally {
		client.release();
	}
	await pool.query(
		"delete from task_notification_activation where task_id='visible-native'",
	);
	expect(
		(
			await pool.query(
				"select has_import_activation from task where id='visible-native'",
			)
		).rows[0].has_import_activation,
	).toBe(true);
	const visibleTasks = await zdb.run(
		queries.tasks.mine.fn({ args: undefined, ctx: { id: "viewer" } }),
	);
	expect(visibleTasks).toHaveLength(4);
	expect(visibleTasks.every((task) => task.hasImportActivation === true)).toBe(
		true,
	);
});

test("client creation and updates cannot set the server maintained marker", async () => {
	const args = {
		id: "client-task",
		listId: "visible-list",
		title: "Client",
		sortKey: "a0",
		hasImportActivation: true,
	};
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.task.create.fn({ tx, ctx: { id: "owner" }, args }),
		),
	);
	expect(
		(
			await pool.query(
				"select has_import_activation from task where id='client-task'",
			)
		).rows[0].has_import_activation,
	).toBe(false);
	const update = {
		id: "visible-active",
		title: "Updated",
		hasImportActivation: false,
	};
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.task.update.fn({ tx, ctx: { id: "owner" }, args: update }),
		),
	);
	expect(
		(
			await pool.query(
				"select has_import_activation from task where id='visible-active'",
			)
		).rows[0].has_import_activation,
	).toBe(true);
});

test("migration backfills authoritative activation presence and preserves native rows", async () => {
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query(
			"create role readiness_migration_owner nosuperuser nocreatedb nocreaterole nobypassrls",
		);
		await client.query(
			"create schema readiness_migration_test authorization readiness_migration_owner",
		);
		await client.query("set local role readiness_migration_owner");
		await client.query("set local search_path to readiness_migration_test");
		await client.query(
			"create table task (id text primary key); create table task_notification_activation (task_id text primary key)",
		);
		await client.query(
			"insert into task values ('native'),('imported'); insert into task_notification_activation values ('imported')",
		);
		await client.query(`alter table task_notification_activation enable row level security;
   alter table task_notification_activation force row level security;
   create policy task_notification_activation_service_select on task_notification_activation for select using
   (current_setting('ditero.activation_scope', true) in ('producer','invite','ack','account-delete'))`);
		expect(
			(await client.query("select * from task_notification_activation")).rows,
		).toEqual([]);
		await client.query(
			"select set_config('ditero.activation_scope','previous-test-scope',true)",
		);
		const sql = await readFile(
			new URL("../../drizzle/0055_melted_prima.sql", import.meta.url),
			"utf8",
		);
		await client.query(sql);
		expect(
			(
				await client.query(
					"select current_setting('ditero.activation_scope',true) as scope",
				)
			).rows[0].scope,
		).toBe("previous-test-scope");
		expect((await client.query("select * from task order by id")).rows).toEqual(
			[
				{ id: "imported", has_import_activation: true },
				{ id: "native", has_import_activation: false },
			],
		);
		await client.query(
			"create policy test_activation_insert on task_notification_activation for insert with check (true)",
		);
		await client.query(
			"insert into task values ('new'); insert into task_notification_activation values ('new')",
		);
		expect(
			(
				await client.query(
					"select has_import_activation from task where id='new'",
				)
			).rows[0].has_import_activation,
		).toBe(true);
	} finally {
		await client.query("rollback");
		client.release();
	}
});
