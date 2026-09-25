import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { withUserContext } from "../../src/db/user-context.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import { saveImportPlan } from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
let document: PortableExportV1;
let mappings: ImportMappings;

beforeAll(async () => {
	await pool.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_activation_run_policy_test') then create role ditero_import_activation_run_policy_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query(
		"grant usage on schema public to ditero_import_activation_run_policy_test",
	);
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_activation_run_policy_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_activation_run_policy_test");
	});
});
beforeEach(async () => {
	await resetAuthFixture(pool);
	await db.insert(tables.user).values([
		{ id: "alice", name: "Alice", email: "alice@example.test" },
		{ id: "bob", name: "Bob", email: "bob@example.test" },
	]);
	await db.insert(tables.workspace).values([
		{ id: "source", name: "Source", ownerId: "alice", kind: "shared" },
		{ id: "target", name: "Target", ownerId: "alice", kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{
			id: "source-alice",
			workspaceId: "source",
			userId: "alice",
			role: "owner",
		},
		{
			id: "target-alice",
			workspaceId: "target",
			userId: "alice",
			role: "owner",
		},
	]);
	await db.insert(tables.list).values({
		id: "source-list",
		workspaceId: "source",
		ownerId: "alice",
		title: "List",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "source-task",
		listId: "source-list",
		title: "Task",
		sortKey: "a0",
	});
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	mappings = {
		workspaces: { source: "target", target: "target" },
		principals: { alice: "alice" },
	};
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});

async function save(plannerVersion: 2 | 3 | 4) {
	const saved = await saveImportPlan(
		runtime,
		"alice",
		{ mode: "new", id: randomUUID(), label: "Native source" },
		document,
		mappings,
		{ plannerVersion },
	);
	expect(saved.report).toMatchObject({ plannerVersion, applySupported: true });
	return saved.id;
}

async function insertRun(userId: string, jobId: string) {
	return withUserContext(runtime, userId, (client) =>
		client.query(
			"insert into import_run (job_id, owner_user_id) values ($1, 'alice') returning state",
			[jobId],
		),
	);
}

async function cloneJob(
	jobId: string,
	plannerVersion: number,
	applySupported: boolean,
) {
	const id = randomUUID();
	await pool.query(
		`insert into import_job (id, source_id, owner_user_id, document_digest, mapping_digest, plan_digest, planner_version, apply_supported, report, payload_bytes)
		 select $2, source_id, owner_user_id, document_digest, mapping_digest, $2, $3, $4, report, payload_bytes from import_job where id = $1`,
		[jobId, id, plannerVersion, applySupported],
	);
	return id;
}

test("restricted runtime can write runs for saved v2/v3/v4 plans but rejects foreign and future jobs", async () => {
	const v4 = await save(4);
	const role = await withUserContext(runtime, "alice", (client) =>
		client.query<{
			current_user: string;
			rolbypassrls: boolean;
		}>(
			"select current_user, rolbypassrls from pg_roles where rolname = current_user",
		),
	);
	expect(role.rows[0]).toEqual({
		current_user: "ditero_import_activation_run_policy_test",
		rolbypassrls: false,
	});
	for (const version of [2, 3] as const) {
		const jobId = await save(version);
		expect((await insertRun("alice", jobId)).rows[0]?.state).toBe("pending");
		const updated = await withUserContext(runtime, "alice", (client) =>
			client.query(
				"update import_run set state = 'running' where job_id = $1 returning state",
				[jobId],
			),
		);
		expect(updated.rows[0]?.state).toBe("running");
	}
	expect((await insertRun("alice", v4)).rows[0]?.state).toBe("pending");
	const updated = await withUserContext(runtime, "alice", (client) =>
		client.query(
			"update import_run set state = 'running' where job_id = $1 returning state",
			[v4],
		),
	);
	expect(updated.rows[0]?.state).toBe("running");

	await expect(insertRun("bob", v4)).rejects.toMatchObject({ code: "42501" });
	const foreignUpdate = await withUserContext(runtime, "bob", (client) =>
		client.query(
			"update import_run set state = 'completed' where job_id = $1",
			[v4],
		),
	);
	expect(foreignUpdate.rowCount).toBe(0);
	const futureJob = await cloneJob(v4, 5, true);
	await expect(insertRun("alice", futureJob)).rejects.toMatchObject({
		code: "42501",
	});
	await pool.query(
		"insert into import_run (job_id, owner_user_id) values ($1, 'alice')",
		[futureJob],
	);
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query(
				"update import_run set state = 'running' where job_id = $1",
				[futureJob],
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	const unsupportedJob = await cloneJob(v4, 4, false);
	await expect(insertRun("alice", unsupportedJob)).rejects.toMatchObject({
		code: "42501",
	});
});
