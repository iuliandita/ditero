import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { withUserContext } from "../../src/db/user-context.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import {
	discardImportPlan,
	discardImportSource,
	getImportPlanStatus,
	listImportSources,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
let document: PortableExportV1;
let source: { mode: "new"; id: string; label: string };
let mappings: ImportMappings;

beforeAll(async () => {
	await pool.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_test') then create role ditero_import_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query("grant usage on schema public to ditero_import_test");
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_test");
	});
});
beforeEach(async () => {
	await resetAuthFixture(pool);
	await db.insert(tables.user).values(
		["alice", "bob", "foreign"].map((id) => ({
			id,
			name: id,
			email: `${id}@example.test`,
		})),
	);
	await db.insert(tables.workspace).values([
		{ id: "source", name: "Source", ownerId: "bob", kind: "shared" },
		{ id: "target", name: "Target", ownerId: "bob", kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{
			id: "source-alice",
			userId: "alice",
			workspaceId: "source",
			role: "owner",
		},
		{
			id: "target-alice",
			userId: "alice",
			workspaceId: "target",
			role: "owner",
		},
		{ id: "source-bob", userId: "bob", workspaceId: "source", role: "owner" },
		{ id: "target-bob", userId: "bob", workspaceId: "target", role: "owner" },
	]);
	await db.insert(tables.list).values({
		id: "list",
		workspaceId: "source",
		ownerId: "alice",
		title: "List",
		sortKey: "a0",
	});
	await db
		.insert(tables.task)
		.values({ id: "task", listId: "list", title: "Task", sortKey: "a0" });
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	source = { mode: "new", id: randomUUID(), label: "Native source" };
	mappings = {
		workspaces: { source: "target", target: "target" },
		principals: { alice: "alice", bob: "bob" },
	};
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});
function setTitle(title: string) {
	const task = document.data.tasks[0];
	if (!task) throw new Error("Missing fixture task");
	task.title = title;
}
const save = () => saveImportPlan(runtime, "alice", source, document, mappings);

test("planning cancellation persists no source or job", async () => {
	const controller = new AbortController();
	const pending = saveImportPlan(runtime, "alice", source, document, mappings, {
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toMatchObject({
		code: "import-cancelled",
		status: 408,
	});
	expect(
		(await pool.query("select count(*)::int as count from import_source"))
			.rows[0].count,
	).toBe(0);
});

test("the shared deadline bounds acquisition and returns a late connection", async () => {
	const blocked = new Pool({ connectionString: databaseURL, max: 1 });
	const held = await blocked.connect();
	try {
		await expect(
			saveImportPlan(blocked, "alice", source, document, mappings, {
				deadline: performance.now() + 200,
			}),
		).rejects.toMatchObject({ code: "import-timeout", status: 503 });
	} finally {
		held.release();
	}
	try {
		expect((await blocked.query("select 1 as ready")).rows[0].ready).toBe(1);
		expect(
			(await pool.query("select count(*)::int as count from import_source"))
				.rows[0].count,
		).toBe(0);
	} finally {
		await blocked.end();
	}
});

test("cancelling a saturated pool request returns 408 and releases its late client", async () => {
	const blocked = new Pool({ connectionString: databaseURL, max: 1 });
	const held = await blocked.connect();
	const controller = new AbortController();
	const pending = saveImportPlan(blocked, "alice", source, document, mappings, {
		signal: controller.signal,
	});
	const rejected = expect(pending).rejects.toMatchObject({
		code: "import-cancelled",
		status: 408,
	});
	try {
		await vi.waitFor(() => expect(blocked.waitingCount).toBe(1));
		controller.abort();
		await rejected;
	} finally {
		controller.abort();
		held.release();
	}
	try {
		expect((await blocked.query("select 1 as ready")).rows[0].ready).toBe(1);
	} finally {
		await blocked.end();
	}
});

test("concurrent duplicate saves return one immutable plan and no content writes", async () => {
	const before = await pool.query(
		"select (select count(*) from task) as tasks, (select count(*) from membership) as memberships",
	);
	const [a, b] = await Promise.all([save(), save()]);
	expect(a).toEqual(b);
	expect(a).not.toHaveProperty("items");
	expect(a).not.toHaveProperty("payload");
	expect(await getImportPlanStatus(runtime, "alice", a.id)).toEqual(a);
	const listed = await listImportSources(runtime, "alice");
	expect(listed).toHaveLength(1);
	expect(listed[0]?.jobs).toEqual([a]);
	const counts = await pool.query(
		"select (select count(*) from import_source)::int as sources, (select count(*) from import_job)::int as jobs, (select count(*) from import_item)::int as items",
	);
	expect(counts.rows[0]).toMatchObject({ sources: 1, jobs: 1 });
	expect(counts.rows[0]?.items).toBeGreaterThan(0);
	expect(
		(
			await pool.query(
				"select (select count(*) from task) as tasks, (select count(*) from membership) as memberships",
			)
		).rows,
	).toEqual(before.rows);
	await withUserContext(runtime, "alice", async (client) => {
		for (const table of ["import_source", "import_job", "import_item"]) {
			const update = await client.query(
				`update ${table} set ${table === "import_source" ? "label = 'changed'" : table === "import_job" ? "payload_bytes = 0" : "disposition = 'blocked'"}`,
			);
			expect(update.rowCount).toBe(0);
		}
	});
	expect(await getImportPlanStatus(runtime, "alice", a.id)).toEqual(a);
});

test("runtime RLS hides all ledger rows from another owner and rejects cross-owner insertion", async () => {
	const saved = await save();
	expect(await getImportPlanStatus(runtime, "bob", saved.id)).toBeNull();
	expect(await listImportSources(runtime, "bob")).toEqual([]);
	expect(await discardImportPlan(runtime, "bob", saved.id)).toBe(false);
	expect(await discardImportSource(runtime, "bob", source.id)).toBe(false);
	await withUserContext(runtime, "bob", async (client) => {
		for (const table of ["import_source", "import_job", "import_item"])
			expect((await client.query(`select * from ${table}`)).rows).toEqual([]);
	});
	await expect(
		withUserContext(runtime, "bob", (client) =>
			client.query(
				"insert into import_source (id,owner_user_id,label,format,schema_version,source_user_id) values ($1,'alice','bad','ditero',1,'alice')",
				[randomUUID()],
			),
		),
	).rejects.toThrow(/row-level security/i);
});

test("changed documents create another job while binding and label remain immutable", async () => {
	const first = await save();
	setTitle("Later content");
	const second = await save();
	expect(second.id).not.toBe(first.id);
	expect(await getImportPlanStatus(runtime, "alice", first.id)).toEqual(first);
	await expect(
		saveImportPlan(
			runtime,
			"alice",
			{ ...source, label: "Changed" },
			document,
			mappings,
		),
	).rejects.toMatchObject({ code: "source-binding-conflict" });
	document.sourceUserId = "bob";
	mappings.principals.bob = "alice";
	await expect(save()).rejects.toMatchObject({
		code: "source-binding-conflict",
	});
});

test("authorization is rechecked on duplicate, and mapped principals need current seats", async () => {
	await save();
	await pool.query(
		"update membership set role = 'viewer' where id = 'target-alice'",
	);
	await expect(save()).rejects.toMatchObject({
		code: "invalid-workspace-mapping",
	});
	await pool.query(
		"update membership set role = 'owner' where id = 'target-alice'",
	);
	await pool.query("delete from membership where id = 'target-bob'");
	await expect(save()).rejects.toMatchObject({
		code: "invalid-principal-mapping",
	});
	mappings.principals.bob = "foreign";
	await expect(save()).rejects.toMatchObject({
		code: "invalid-principal-mapping",
	});
	mappings.principals.bob = null;
	await expect(save()).resolves.toHaveProperty("id");
	await pool.query("delete from membership where id = 'target-alice'");
	await expect(save()).rejects.toMatchObject({
		code: "invalid-workspace-mapping",
	});
});

test("job quota and payload quota reject atomically, duplicates remain available", async () => {
	const first = await save();
	for (let i = 1; i < 10; i++) {
		setTitle(`Task ${i}`);
		await save();
	}
	expect(await getImportPlanStatus(runtime, "alice", first.id)).toEqual(first);
	await expect(save()).resolves.toHaveProperty("id");
	setTitle("One too many");
	await expect(save()).rejects.toMatchObject({ code: "import-quota-exceeded" });
	expect((await listImportSources(runtime, "alice"))[0]?.jobs).toHaveLength(10);
	await discardImportSource(runtime, "alice", source.id);
	const saved = await save();
	await pool.query("update import_job set payload_bytes = $1 where id = $2", [
		64 * 1024 * 1024,
		saved.id,
	]);
	setTitle("Byte overflow");
	const another = { ...source, id: randomUUID() };
	await expect(
		saveImportPlan(runtime, "alice", another, document, mappings),
	).rejects.toMatchObject({ code: "import-quota-exceeded" });
	expect(await listImportSources(runtime, "alice")).toHaveLength(1);
});

test("source quota counts empty retained sources and whole-job/source discard cascades", async () => {
	for (let i = 0; i < 10; i++) {
		source.id = randomUUID();
		const job = await save();
		expect(await discardImportPlan(runtime, "alice", job.id)).toBe(true);
	}
	source.id = randomUUID();
	await expect(save()).rejects.toMatchObject({ code: "import-quota-exceeded" });
	const all = await listImportSources(runtime, "alice");
	expect(all).toHaveLength(10);
	expect((await pool.query("select * from import_item")).rows).toEqual([]);
	expect(
		await discardImportSource(runtime, "alice", all[0]?.id ?? "missing"),
	).toBe(true);
	await save();
	expect(await discardImportSource(runtime, "alice", source.id)).toBe(true);
	expect((await pool.query("select * from import_job")).rows).toEqual([]);
	expect((await pool.query("select * from import_item")).rows).toEqual([]);
});

test("account soft deletion removes retained payloads and rejects later saves", async () => {
	await save();
	const guards = makeGuards(
		["http://localhost"],
		async () => ({ user: { id: "alice" } }) as Session,
	);
	const app = new Elysia().use(accountDeletionRoutes(runtime, guards));
	const response = await app.handle(
		new Request("http://localhost/api/account/delete", {
			method: "POST",
			headers: {
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({ acknowledgeKeyLoss: true }),
		}),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	for (const table of ["import_source", "import_job", "import_item"])
		expect((await pool.query(`select * from ${table}`)).rows).toEqual([]);
	await expect(save()).rejects.toMatchObject({ code: "inactive-user" });
});

test("fallback mappings require membership without a source membership row", async () => {
	for (const workspace of document.data.workspaces) workspace.ownerId = "alice";
	document.data.memberships = document.data.memberships.filter(
		(row) => row.userId !== "bob",
	);
	const task = document.data.tasks[0];
	if (!task) throw new Error("Missing fixture task");
	task.fallbackUserId = "bob";
	await save();
	await pool.query("delete from membership where id = 'target-bob'");
	await expect(save()).rejects.toMatchObject({
		code: "invalid-principal-mapping",
	});
});

test("committed item payloads cannot be appended or individually discarded", async () => {
	const saved = await save();
	const before = await pool.query(
		"select count(*)::int as count from import_item where job_id = $1",
		[saved.id],
	);
	await withUserContext(runtime, "alice", async (client) => {
		const result = await client.query(
			"delete from import_item where job_id = $1",
			[saved.id],
		);
		expect(result.rowCount).toBe(0);
	});
	await expect(
		withUserContext(runtime, "alice", (client) =>
			client.query(
				`insert into import_item (job_id, ordinal, collection, source_id, source_key, item_digest, target_id, disposition, payload, codes) select job_id, 99999, collection, source_id, source_key, item_digest, target_id, disposition, payload, codes from import_item where job_id = $1 limit 1`,
				[saved.id],
			),
		),
	).rejects.toThrow(/row-level security/i);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from import_item where job_id = $1",
				[saved.id],
			)
		).rows,
	).toEqual(before.rows);
	expect(await discardImportPlan(runtime, "alice", saved.id)).toBe(true);
	expect(
		(
			await pool.query("select * from import_item where job_id = $1", [
				saved.id,
			])
		).rows,
	).toEqual([]);
});
