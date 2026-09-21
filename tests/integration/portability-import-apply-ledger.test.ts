import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const ledgerTables = [
	"import_run",
	"import_source_map",
	"import_workspace_map",
];

beforeAll(async () => {
	await pool.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_apply_test') then create role ditero_import_apply_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query("grant usage on schema public to ditero_import_apply_test");
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_apply_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_apply_test");
	});
});
beforeEach(async () => {
	await resetAuthFixture(pool);
	await pool.query(
		`insert into "user" (id, name, email) values ('alice', 'Alice', 'alice@example.test'), ('bob', 'Bob', 'bob@example.test')`,
	);
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});

async function seedJob(client: PoolClient, owner = "alice", legacy = false) {
	const sourceId = randomUUID();
	const jobId = randomUUID();
	await client.query(
		`insert into import_source (id, owner_user_id, label, format, schema_version, source_user_id) values ($1,$2,'Source','ditero',1,'original-user')`,
		[sourceId, owner],
	);
	await client.query(
		`insert into import_job (id, source_id, owner_user_id, document_digest, mapping_digest, plan_digest, report, payload_bytes${legacy ? "" : ", planner_version, apply_supported"}) values ($1,$2,$3,'document','mapping','plan','{}',0${legacy ? "" : ",2,true"})`,
		[jobId, sourceId, owner],
	);
	return { sourceId, jobId };
}

async function insertItem(
	client: PoolClient,
	jobId: string,
	missing?: string,
	ordinal = 0,
) {
	const evidence = {
		phase: "tasks",
		content_digest: "content",
		target_precondition: "{}",
		dependency_proof: "[]",
	};
	await client.query(
		`insert into import_item (job_id, ordinal, collection, source_id, source_key, item_digest, disposition, payload, codes, phase, content_digest, target_precondition, dependency_proof) values ($1,$2,'tasks','task','tasks:task','item','ensure','{}','[]',$3,$4,$5,$6)`,
		[
			jobId,
			ordinal,
			...Object.entries(evidence).map(([key, value]) =>
				key === missing ? null : value,
			),
		],
	);
}

async function insertLedger(
	client: PoolClient,
	sourceId: string,
	jobId: string,
	owner = "alice",
) {
	await client.query(
		"insert into import_run (job_id, owner_user_id) values ($1,$2)",
		[jobId, owner],
	);
	await client.query(
		`insert into import_source_map (source_id, source_key, owner_user_id, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest) values ($1,'tasks:task',$2,'tasks','task','deleted-target','deleted-workspace','content','target','plan')`,
		[sourceId, owner],
	);
	await client.query(
		`insert into import_workspace_map (source_id, source_workspace_id, owner_user_id, target_workspace_id) values ($1,'original-workspace',$2,'deleted-workspace')`,
		[sourceId, owner],
	);
}

async function seedLedger() {
	return withUserContext(runtime, "alice", async (client) => {
		const ids = await seedJob(client);
		await insertItem(client, ids.jobId);
		await insertLedger(client, ids.sourceId, ids.jobId);
		return ids;
	});
}

test("legacy jobs default to non-applicable and cannot acquire a run", async () => {
	const { jobId } = await withUserContext(runtime, "alice", async (client) => {
		const ids = await seedJob(client, "alice", true);
		await client.query(
			`insert into import_item (job_id, ordinal, collection, source_id, source_key, item_digest, disposition, payload, codes) values ($1,0,'tasks','task','tasks:task','item','ensure','{}','[]')`,
			[ids.jobId],
		);
		return ids;
	});
	expect(
		(
			await pool.query(
				"select planner_version, apply_supported from import_job where id = $1",
				[jobId],
			)
		).rows,
	).toEqual([{ planner_version: 1, apply_supported: false }]);
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query(
				"insert into import_run (job_id, owner_user_id) values ($1,'alice')",
				[jobId],
			),
		),
	).rejects.toThrow(/row-level security/i);
});

test.each([
	"phase",
	"content_digest",
	"target_precondition",
	"dependency_proof",
])("v2 ensured items reject missing %s in the creating transaction", async (missing) => {
	await expect(
		withUserContext(runtime, "alice", async (client) => {
			const { jobId } = await seedJob(client);
			await insertItem(client, jobId, missing);
		}),
	).rejects.toThrow(/row-level security/i);
	expect((await pool.query("select * from import_job")).rows).toEqual([]);
});

test("v2 evidence permits same-transaction items but cannot reopen a committed plan", async () => {
	const { jobId } = await seedLedger();
	await expect(
		withUserContext(runtime, "alice", (client) =>
			insertItem(client, jobId, undefined, 1),
		),
	).rejects.toThrow(/row-level security/i);
	expect(
		(
			await pool.query("select ordinal from import_item where job_id = $1", [
				jobId,
			])
		).rows,
	).toEqual([{ ordinal: 0 }]);
});

test("runtime RLS isolates reads, updates and deletes on every apply ledger table", async () => {
	await seedLedger();
	await withUserContext(runtime, "bob", async (client) => {
		for (const table of ledgerTables) {
			expect((await client.query(`select * from ${table}`)).rows).toEqual([]);
			expect(
				(await client.query(`update ${table} set owner_user_id = 'bob'`))
					.rowCount,
			).toBe(0);
			expect((await client.query(`delete from ${table}`)).rowCount).toBe(0);
		}
	});
	await withUserContext(runtime, "alice", async (client) => {
		for (const table of ledgerTables)
			expect((await client.query(`select * from ${table}`)).rowCount).toBe(1);
		expect(
			(await client.query("update import_run set state = 'running'")).rowCount,
		).toBe(1);
		expect(
			(await client.query("update import_source_map set version = 2")).rowCount,
		).toBe(1);
	});
});

test("runtime inserts require matching parent ownership and cannot forge another owner", async () => {
	const { jobId, sourceId } = await withUserContext(
		runtime,
		"alice",
		(client) => seedJob(client),
	);
	for (const owner of ["alice", "bob"]) {
		const inserts = [
			["insert into import_run (job_id, owner_user_id) values ($1,$2)", jobId],
			[
				`insert into import_source_map (source_id, source_key, owner_user_id, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest) values ($1,'key',$2,'tasks','task','target','workspace','content','target','plan')`,
				sourceId,
			],
			[
				"insert into import_workspace_map (source_id, source_workspace_id, owner_user_id, target_workspace_id) values ($1,'workspace',$2,'target')",
				sourceId,
			],
		];
		for (const [query, id] of inserts) {
			if (!query || !id) throw new Error("Missing insertion fixture");
			await expect(
				withUserContext(runtime, "bob", (client) =>
					client.query(query, [id, owner]),
				),
			).rejects.toThrow(/row-level security/i);
		}
	}
});

test("run and source-map updates cannot transfer ownership or change to a foreign parent", async () => {
	await seedLedger();
	const foreign = await withUserContext(runtime, "bob", (client) =>
		seedJob(client, "bob"),
	);
	for (const query of [
		"update import_run set owner_user_id = 'bob'",
		"update import_source_map set owner_user_id = 'bob'",
	]) {
		await expect(
			withUserContext(runtime, "alice", (client) => client.query(query)),
		).rejects.toThrow(/identity is immutable/i);
	}
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query("update import_run set job_id = $1", [foreign.jobId]),
		),
	).rejects.toThrow(/identity is immutable/i);
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query("update import_source_map set source_id = $1", [
				foreign.sourceId,
			]),
		),
	).rejects.toThrow(/identity is immutable/i);
});

test("a run cannot be rebound to another applicable job owned by the same user", async () => {
	const original = await seedLedger();
	const alternate = await withUserContext(runtime, "alice", (client) =>
		seedJob(client),
	);
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query("update import_run set job_id = $1 where job_id = $2", [
				alternate.jobId,
				original.jobId,
			]),
		),
	).rejects.toThrow(/import_run identity is immutable/i);
	expect((await pool.query("select job_id from import_run")).rows).toEqual([
		{ job_id: original.jobId },
	]);
});

test.each([
	"source_id",
	"source_key",
	"collection",
	"source_row_id",
	"target_id",
	"target_workspace_id",
])("source-map %s cannot redirect history within the same owner", async (column) => {
	await seedLedger();
	const alternate = await withUserContext(runtime, "alice", (client) =>
		seedJob(client),
	);
	const before = (await pool.query("select * from import_source_map")).rows;
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query(`update import_source_map set ${column} = $1`, [
				column === "source_id" ? alternate.sourceId : "redirected",
			]),
		),
	).rejects.toThrow(/import_source_map identity is immutable/i);
	expect((await pool.query("select * from import_source_map")).rows).toEqual(
		before,
	);
});

test("identity guards allow run progress and map digest updates", async () => {
	await seedLedger();
	await withUserContext(runtime, "alice", async (client) => {
		const run = await client.query(
			`update import_run set job_id = job_id, owner_user_id = owner_user_id, state = 'completed', next_ordinal = 3, applied_count = 2, noop_count = 1, conflict_code = null, conflict_ordinal = null, updated_at = now(), completed_at = now() returning state, next_ordinal, applied_count, noop_count, completed_at`,
		);
		expect(run.rows).toEqual([
			{
				state: "completed",
				next_ordinal: 3,
				applied_count: 2,
				noop_count: 1,
				completed_at: expect.any(Date),
			},
		]);
		const map = await client.query(
			`update import_source_map set source_id = source_id, source_key = source_key, owner_user_id = owner_user_id, collection = collection, source_row_id = source_row_id, target_id = target_id, target_workspace_id = target_workspace_id, content_digest = 'new-content', last_target_digest = 'new-target', last_plan_digest = 'new-plan', version = 2, updated_at = now() returning content_digest, last_target_digest, last_plan_digest, version`,
		);
		expect(map.rows).toEqual([
			{
				content_digest: "new-content",
				last_target_digest: "new-target",
				last_plan_digest: "new-plan",
				version: 2,
			},
		]);
	});
});

test("workspace mapping pins are immutable even to their owner", async () => {
	await seedLedger();
	await withUserContext(runtime, "alice", async (client) => {
		expect(
			(
				await client.query(
					"update import_workspace_map set target_workspace_id = 'redirected'",
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await client.query(
					"select target_workspace_id from import_workspace_map",
				)
			).rows,
		).toEqual([{ target_workspace_id: "deleted-workspace" }]);
	});
});

test("deleting a completed job removes its run and payload while retaining source maps", async () => {
	const { jobId } = await seedLedger();
	await withUserContext(runtime, "alice", async (client) => {
		await client.query(
			"update import_run set state = 'completed', completed_at = now() where job_id = $1",
			[jobId],
		);
		expect(
			(await client.query("delete from import_job where id = $1", [jobId]))
				.rowCount,
		).toBe(1);
	});
	for (const table of ["import_job", "import_item", "import_run"])
		expect((await pool.query(`select * from ${table}`)).rowCount).toBe(0);
	for (const table of [
		"import_source",
		"import_source_map",
		"import_workspace_map",
	])
		expect((await pool.query(`select * from ${table}`)).rowCount).toBe(1);
});

test.each([
	"source",
	"account",
])("%s hard deletion cascades through all import ledger rows", async (kind) => {
	const { sourceId } = await seedLedger();
	if (kind === "source")
		await withUserContext(runtime, "alice", (client) =>
			client.query("delete from import_source where id = $1", [sourceId]),
		);
	else await pool.query(`delete from "user" where id = 'alice'`);
	for (const table of [
		"import_source",
		"import_job",
		"import_item",
		...ledgerTables,
	])
		expect((await pool.query(`select * from ${table}`)).rows).toEqual([]);
});
