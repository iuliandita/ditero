import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { scanTick } from "../../src/server/notifications/scheduler.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import {
	applyImportBatch,
	getImportRunStatus,
} from "../../src/server/portability/import-apply-store.ts";
import {
	discardImportPlan,
	discardImportSource,
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const now = new Date("2026-09-18T10:00:00.000Z");
let document: PortableExportV1;
let source: { mode: "new"; id: string; label: string };
let mappings: ImportMappings;

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
	await db.insert(tables.user).values([
		{ id: "alice", name: "Alice", email: "alice@example.test" },
		{ id: "bob", name: "Bob", email: "bob@example.test" },
	]);
	await db.insert(tables.workspace).values(
		["source", "target", "other"].map((id) => ({
			id,
			name: id,
			ownerId: "alice",
			kind: "shared" as const,
		})),
	);
	await db.insert(tables.membership).values(
		["source", "target", "other"].map((workspaceId) => ({
			id: `${workspaceId}-alice`,
			workspaceId,
			userId: "alice",
			role: "owner" as const,
		})),
	);
	await db.insert(tables.folder).values({
		id: "folder",
		workspaceId: "source",
		name: "Groceries",
		sortKey: "a2",
	});
	await db.insert(tables.list).values({
		id: "list",
		workspaceId: "source",
		ownerId: "alice",
		folderId: "folder",
		title: "Shopping",
		kind: "shopping",
		icon: "shopping-cart",
		sortKey: "a3",
		completedDisplay: "keep",
	});
	await db.insert(tables.task).values({
		id: "a-root",
		listId: "list",
		title: "Coffee",
		notes: "Keep the original notes\nSecond line",
		done: true,
		dueAt: now,
		dueAllDay: true,
		completedAt: now,
		priority: 3,
		sortKey: "a4",
		quantity: "2.5",
		unit: "kg",
		category: "Pantry",
		rrule: "FREQ=WEEKLY;BYDAY=FR",
		recurrenceRelative: true,
	});
	await db.insert(tables.task).values({
		id: "z-child",
		listId: "list",
		parentId: "a-root",
		title: "Ground coffee",
		sortKey: "a5",
	});
	await db.insert(tables.label).values({
		id: "label",
		workspaceId: "source",
		name: "Weekend",
		color: "#123456",
	});
	await db.insert(tables.taskLabel).values({
		id: "link",
		taskId: "a-root",
		labelId: "label",
	});
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	source = { mode: "new", id: randomUUID(), label: "Native source" };
	mappings = {
		workspaces: { source: "target", target: "target", other: "other" },
		principals: { alice: "alice" },
	};
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});

const save = (plannerVersion: 1 | 2 = 2) =>
	saveImportPlan(runtime, "alice", source, document, mappings, {
		plannerVersion,
	});
const confirmation = (job: ImportPlanStatus) => ({
	planDigest: job.planDigest,
	counts: job.report.counts,
});
const apply = (job: ImportPlanStatus) =>
	applyImportBatch(runtime, "alice", job.id, confirmation(job));
async function finish(job: ImportPlanStatus) {
	let status = await apply(job);
	for (let batch = 0; status.state === "running" && batch < 10; batch++)
		status = await apply(job);
	expect(status.state).toBe("completed");
	return status;
}
async function targetId(collection: string, sourceId: string) {
	const result = await pool.query<{ target_id: string }>(
		"select target_id from import_source_map where source_id = $1 and collection = $2 and source_row_id = $3",
		[source.id, collection, sourceId],
	);
	const id = result.rows[0]?.target_id;
	if (!id) throw new Error(`Missing target for ${collection}/${sourceId}`);
	return id;
}
async function targetCounts() {
	return (
		await pool.query(
			`select (select count(*)::int from folder where workspace_id = 'target') as folders, (select count(*)::int from list where workspace_id = 'target') as lists, (select count(*)::int from label where workspace_id = 'target') as labels, (select count(*)::int from task t join list l on l.id=t.list_id where l.workspace_id = 'target') as tasks, (select count(*)::int from import_source_map) as maps`,
		)
	).rows[0];
}
function addBulk(count = 115) {
	const original = document.data.tasks.find((row) => row.id === "a-root");
	if (!original) throw new Error("Missing root fixture");
	for (let i = 0; i < count; i++)
		document.data.tasks.push({
			...original,
			id: `bulk-${String(i).padStart(3, "0")}`,
			title: `Bulk ${i}`,
			parentId: null,
			done: false,
			completedAt: null,
		});
}
async function dispositions(job: ImportPlanStatus) {
	return (
		await pool.query<{
			collection: string;
			source_id: string;
			disposition: string;
		}>(
			"select collection, source_id, disposition from import_item where job_id = $1 order by ordinal",
			[job.id],
		)
	).rows;
}

test("supported rows preserve every portable field without side effects", async () => {
	const job = await save();
	const status = await finish(job);
	expect(status.appliedCount).toBe(6);
	expect(status.noopCount).toBe(0);
	const output = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	const ids = new Map<string, string>();
	for (const collection of [
		"folders",
		"lists",
		"tasks",
		"labels",
		"taskLabels",
	] as const)
		for (const row of document.data[collection])
			ids.set(row.id, await targetId(collection, row.id));
	for (const collection of [
		"folders",
		"lists",
		"tasks",
		"labels",
		"taskLabels",
	] as const) {
		for (const original of document.data[collection]) {
			const expected: Record<string, unknown> = { ...original };
			for (const key of [
				"id",
				"folderId",
				"listId",
				"parentId",
				"taskId",
				"labelId",
			])
				if (typeof expected[key] === "string")
					expected[key] = ids.get(expected[key]);
			if ("workspaceId" in expected) expected.workspaceId = "target";
			expect(
				output.data[collection].find((row) => row.id === expected.id),
				collection,
			).toEqual(expected);
		}
	}
	for (const table of [
		"notification_outbox",
		"reminder_state",
		"karma",
		"karma_event",
		"comment",
		"task_assignee",
		"habit_log",
		"focus_session",
	])
		expect((await pool.query(`select * from ${table}`)).rows, table).toEqual(
			[],
		);
});

test("legacy jobs and incorrect digest or excluded counts write no content or progress", async () => {
	const legacy = await save(1);
	await expect(apply(legacy)).rejects.toMatchObject({
		code: "import-apply-unsupported",
	});
	const job = await save();
	for (const invalid of [
		{ ...confirmation(job), planDigest: "wrong" },
		{
			...confirmation(job),
			counts: { ...job.report.counts, blocked: job.report.counts.blocked + 1 },
		},
	])
		await expect(
			applyImportBatch(runtime, "alice", job.id, invalid),
		).rejects.toMatchObject({ code: "import-confirmation-mismatch" });
	expect(await targetCounts()).toEqual({
		folders: 0,
		lists: 0,
		labels: 0,
		tasks: 0,
		maps: 0,
	});
	expect((await pool.query("select * from import_run")).rows).toEqual([]);
});

test("lost-response retries and concurrent requests converge to one copy", async () => {
	const job = await save();
	const [a, b] = await Promise.all([apply(job), apply(job)]);
	expect(await apply(job)).toEqual(a);
	expect(a).toEqual(b);
	expect(a.state).toBe("completed");
	expect(await getImportRunStatus(runtime, "alice", job.id)).toEqual(a);
	expect(await getImportRunStatus(runtime, "bob", job.id)).toBeNull();
	expect(await targetCounts()).toEqual({
		folders: 1,
		lists: 1,
		labels: 1,
		tasks: 2,
		maps: 6,
	});
});

test("a batch advances at most 100 ordinals including excluded rows and resumes", async () => {
	addBulk();
	const firstTask = document.data.tasks.find((row) => row.id === "bulk-000");
	if (!firstTask) throw new Error("Missing bulk task");
	firstTask.reminderTime = "10:00";
	const job = await save();
	const first = await apply(job);
	expect(first.state).toBe("running");
	expect(first.nextOrdinal).toBe(100);
	expect(first.appliedCount).toBeLessThan(100);
	const completed = await finish(job);
	expect(completed.nextOrdinal).toBe((await dispositions(job)).length);
	expect(completed.appliedCount).toBe(120);
	expect((await targetCounts()).tasks).toBe(116);
});

test("completed-job discard retains maps and an unchanged fresh plan applies only no-ops", async () => {
	const first = await save();
	await finish(first);
	const before = await targetCounts();
	expect(await discardImportPlan(runtime, "alice", first.id)).toBe(true);
	expect(
		(
			await pool.query("select * from import_item where job_id = $1", [
				first.id,
			])
		).rows,
	).toEqual([]);
	expect((await targetCounts()).maps).toBe(6);
	const second = await save();
	expect(second.id).not.toBe(first.id);
	const status = await finish(second);
	expect(status.appliedCount).toBe(0);
	expect(status.noopCount).toBe(6);
	expect(await targetCounts()).toEqual(before);
});

test.each([
	"source",
	"edited-target",
	"deleted-target",
])("%s changes exclude a mapped parent and its dependent child and link", async (change) => {
	await finish(await save());
	const rootId = await targetId("tasks", "a-root");
	if (change === "source") {
		const root = document.data.tasks.find((row) => row.id === "a-root");
		if (!root) throw new Error("Missing root fixture");
		root.title = "Changed source";
	} else if (change === "edited-target") {
		await pool.query("update task set title = 'User edit' where id = $1", [
			rootId,
		]);
	} else {
		await pool.query("delete from task_label where task_id = $1", [rootId]);
		await pool.query("delete from task where parent_id = $1", [rootId]);
		await pool.query("delete from task where id = $1", [rootId]);
	}
	const job = await save();
	const rows = await dispositions(job);
	for (const [collection, id] of [
		["tasks", "a-root"],
		["tasks", "z-child"],
		["taskLabels", "link"],
	])
		expect(
			rows.find((row) => row.collection === collection && row.source_id === id)
				?.disposition,
		).toBe("blocked");
	const before = await targetCounts();
	await finish(job);
	expect(await targetCounts()).toEqual(before);
	expect(
		(await pool.query("select title from task where id = $1", [rootId])).rows,
	).toEqual(
		change === "deleted-target"
			? []
			: [{ title: change === "edited-target" ? "User edit" : "Coffee" }],
	);
});

test.each([
	"list-move",
	"parent-move",
	"role-revoked",
])("%s after the first batch stops later writes without redirecting them", async (change) => {
	addBulk();
	const job = await save();
	const first = await apply(job);
	expect(first.state).toBe("running");
	const listId = await targetId("lists", "list");
	if (change === "list-move") {
		await pool.query(
			"update list set workspace_id = 'other', folder_id = null where id = $1",
			[listId],
		);
	} else if (change === "parent-move") {
		await db.insert(tables.list).values({
			id: "destination-list",
			workspaceId: "other",
			ownerId: "alice",
			title: "Elsewhere",
			sortKey: "a0",
		});
		await pool.query(
			"update task set list_id = 'destination-list' where id = $1",
			[await targetId("tasks", "a-root")],
		);
	} else {
		await pool.query(
			"update membership set role = 'viewer' where id = 'target-alice'",
		);
	}
	const maps = (await targetCounts()).maps;
	const status = await apply(job);
	expect(status.state).toBe("conflict");
	expect(status.conflictCode).toEqual(expect.any(String));
	expect(status.appliedCount).toBe(first.appliedCount);
	expect(status.nextOrdinal).toBe(first.nextOrdinal);
	expect((await targetCounts()).maps).toBe(maps);
	expect(
		(
			await pool.query(
				"select * from import_source_map where collection = 'tasks' and source_row_id = 'z-child'",
			)
		).rows,
	).toEqual([]);
	expect(await apply(job)).toEqual(status);
});

test("incomplete runs and retained source history cannot be discarded", async () => {
	addBulk();
	const job = await save();
	expect((await apply(job)).state).toBe("running");
	await expect(
		discardImportPlan(runtime, "alice", job.id),
	).rejects.toMatchObject({ code: expect.any(String) });
	await expect(
		discardImportSource(runtime, "alice", source.id),
	).rejects.toMatchObject({ code: expect.any(String) });
	await finish(job);
	await discardImportPlan(runtime, "alice", job.id);
	await expect(
		discardImportSource(runtime, "alice", source.id),
	).rejects.toMatchObject({ code: expect.any(String) });
	expect(
		(await pool.query("select * from import_source where id = $1", [source.id]))
			.rowCount,
	).toBe(1);
});

test("a label natural-key collision excludes the label and dependent link without merging", async () => {
	await db.insert(tables.label).values({
		id: "existing-label",
		workspaceId: "target",
		name: "Weekend",
		color: "#ffffff",
	});
	const job = await save();
	const rows = await dispositions(job);
	for (const collection of ["labels", "taskLabels"])
		expect(rows.find((row) => row.collection === collection)?.disposition).toBe(
			"blocked",
		);
	await finish(job);
	expect(
		(
			await pool.query(
				"select id, color from label where workspace_id = 'target'",
			)
		).rows,
	).toEqual([{ id: "existing-label", color: "#ffffff" }]);
	expect(
		(
			await pool.query(
				"select * from task_label where label_id = 'existing-label'",
			)
		).rows,
	).toEqual([]);
});

test("a natural-key collision appearing after planning rolls the whole batch back", async () => {
	const job = await save();
	await db.insert(tables.label).values({
		id: "racing-label",
		workspaceId: "target",
		name: "Weekend",
		color: "#ffffff",
	});
	const status = await apply(job);
	expect(status.state).toBe("conflict");
	expect(status.appliedCount).toBe(0);
	expect(status.nextOrdinal).toBe(0);
	expect(await targetCounts()).toEqual({
		folders: 0,
		lists: 0,
		labels: 1,
		tasks: 0,
		maps: 0,
	});
});

test("a SQL constraint failure rolls content, maps and progress back together", async () => {
	const job = await save();
	await pool.query(
		"alter table task add constraint import_apply_test_failure check (title <> 'Ground coffee') not valid",
	);
	try {
		await expect(apply(job)).rejects.toMatchObject({ code: "23514" });
		expect(await targetCounts()).toEqual({
			folders: 0,
			lists: 0,
			labels: 0,
			tasks: 0,
			maps: 0,
		});
		expect((await pool.query("select * from import_run")).rows).toEqual([]);
	} finally {
		await pool.query(
			"alter table task drop constraint import_apply_test_failure",
		);
	}
	await finish(job);
	expect((await targetCounts()).tasks).toBe(2);
});

test.each([
	{ reminderTime: "10:00" },
	{ repeatEveryMin: 15 },
	{ maxRepeats: 2 },
	{ fallbackUserId: "alice" },
	{ urgent: true },
])("notification fields %j exclude the task, child and label link", async (fields) => {
	const root = document.data.tasks.find((row) => row.id === "a-root");
	if (!root) throw new Error("Missing root fixture");
	Object.assign(root, fields);
	const job = await save();
	const rows = await dispositions(job);
	for (const [collection, id] of [
		["tasks", "a-root"],
		["tasks", "z-child"],
		["taskLabels", "link"],
	])
		expect(
			rows.find((row) => row.collection === collection && row.source_id === id)
				?.disposition,
		).toBe("blocked");
	await finish(job);
	expect(await targetCounts()).toEqual({
		folders: 1,
		lists: 1,
		labels: 1,
		tasks: 0,
		maps: 3,
	});
});

test("a terminal-conflict job can be discarded without forgetting earlier batches", async () => {
	addBulk();
	const job = await save();
	expect((await apply(job)).state).toBe("running");
	await pool.query(
		"update list set workspace_id = 'other', folder_id = null where id = $1",
		[await targetId("lists", "list")],
	);
	expect((await apply(job)).state).toBe("conflict");
	const before = await targetCounts();
	expect(await discardImportPlan(runtime, "alice", job.id)).toBe(true);
	expect(await targetCounts()).toEqual(before);
	expect(await getImportRunStatus(runtime, "alice", job.id)).toBeNull();
	await expect(
		discardImportSource(runtime, "alice", source.id),
	).rejects.toMatchObject({ code: "import-source-retained" });
});

test("a mapped target edited after confirmation planning conflicts without overwriting", async () => {
	await finish(await save());
	const job = await save();
	const id = await targetId("tasks", "a-root");
	await pool.query(
		"update task set notes = 'Changed after planning' where id = $1",
		[id],
	);
	const before = await targetCounts();
	const status = await apply(job);
	expect(status.state).toBe("conflict");
	expect(status.appliedCount).toBe(0);
	expect(status.noopCount).toBe(0);
	expect(await targetCounts()).toEqual(before);
	expect(
		(await pool.query("select notes from task where id = $1", [id])).rows,
	).toEqual([{ notes: "Changed after planning" }]);
});

test("source workspace pins permit unrelated new content but reject redirected history", async () => {
	await finish(await save());
	await db.insert(tables.workspace).values({
		id: "later-source",
		name: "Later",
		ownerId: "alice",
		kind: "shared",
	});
	await db.insert(tables.membership).values({
		id: "later-alice",
		workspaceId: "later-source",
		userId: "alice",
		role: "owner",
	});
	await db.insert(tables.list).values({
		id: "later-list",
		workspaceId: "later-source",
		ownerId: "alice",
		title: "Later list",
		sortKey: "a0",
	});
	const later = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	const workspace = later.data.workspaces.find(
		(row) => row.id === "later-source",
	);
	const membership = later.data.memberships.find(
		(row) => row.id === "later-alice",
	);
	const list = later.data.lists.find((row) => row.id === "later-list");
	if (!workspace || !membership || !list)
		throw new Error("Missing later native export fixture");
	document.data.workspaces.push(workspace);
	document.data.memberships.push(membership);
	document.data.lists.push(list);
	mappings.workspaces["later-source"] = "other";
	const status = await finish(await save());
	expect(status.appliedCount).toBe(1);
	expect(status.noopCount).toBe(6);
	mappings.workspaces.source = "other";
	const before = await targetCounts();
	await expect(save()).rejects.toMatchObject({ code: "invalid-mappings" });
	expect(await targetCounts()).toEqual(before);
});

test("large ASCII notes within the document limit survive apply and unchanged replan", async () => {
	const root = document.data.tasks.find((row) => row.id === "a-root");
	if (!root) throw new Error("Missing root fixture");
	root.notes = "a".repeat(12 * 1024 * 1024);
	const first = await save();
	await finish(first);
	expect(
		(
			await pool.query("select notes from task where id = $1", [
				await targetId("tasks", "a-root"),
			])
		).rows,
	).toEqual([{ notes: root.notes }]);
	await discardImportPlan(runtime, "alice", first.id);
	const repeated = await finish(await save());
	expect(repeated.appliedCount).toBe(0);
	expect(repeated.noopCount).toBe(6);
}, 30_000);

test("production scheduler leaves due imported tasks inert with a working reminder channel", async () => {
	for (const task of document.data.tasks) {
		task.done = false;
		task.completedAt = null;
		task.dueAt = now.toISOString();
		task.rrule = null;
	}
	await db.insert(tables.userPref).values({ id: "alice", timezone: "UTC" });
	await db.insert(tables.notificationChannel).values({
		id: "scheduler-channel",
		userId: "alice",
		kind: "ntfy",
		config: { topic: "import-test", server: "https://ntfy.invalid" },
	});
	await finish(await save());
	const options = {
		now: new Date("2026-09-18T10:00:30.000Z"),
		timing: { tickMs: 1000, graceMs: 3_600_000, lateThresholdMs: 60_000 },
	};
	await scanTick(db, options);
	for (const table of [
		"notification_outbox",
		"reminder_state",
		"karma",
		"karma_event",
	])
		expect((await pool.query(`select * from ${table}`)).rows, table).toEqual(
			[],
		);
	await db.insert(tables.task).values({
		id: "scheduler-positive-control",
		listId: "list",
		title: "Explicitly enabled reminder",
		sortKey: "b0",
		dueAt: now,
		reminderTime: "10:00",
	});
	await scanTick(db, options);
	expect(
		(await pool.query("select task_id, recipient_user_id from reminder_state"))
			.rows,
	).toEqual([
		{ task_id: "scheduler-positive-control", recipient_user_id: "alice" },
	]);
	expect(
		(await pool.query("select count(*)::int as count from notification_outbox"))
			.rows,
	).toEqual([{ count: 1 }]);
	for (const table of ["karma", "karma_event"])
		expect((await pool.query(`select * from ${table}`)).rows, table).toEqual(
			[],
		);
});

test("a concurrent list move holds apply at the real dependency lock then conflicts", async () => {
	addBulk();
	const job = await save();
	const first = await apply(job);
	expect(first.state).toBe("running");
	const listId = await targetId("lists", "list");
	const mapsBefore = (await targetCounts()).maps;
	const mover = await pool.connect();
	const applying = new Pool({
		connectionString: databaseURL,
		application_name: "import-apply-lock-test",
	});
	applying.on("connect", (client) => {
		void client.query("set role ditero_import_apply_test");
	});
	let pending: ReturnType<typeof applyImportBatch> | undefined;
	try {
		await mover.query("begin");
		const moverPid = (
			await mover.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0]?.pid;
		await mover.query(
			"update list set workspace_id = 'other', folder_id = null where id = $1",
			[listId],
		);
		pending = applyImportBatch(applying, "alice", job.id, confirmation(job));
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from pg_stat_activity where application_name = 'import-apply-lock-test' and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))",
							[moverPid],
						)
					).rows[0]?.count,
			)
			.toBe(1);
		await mover.query("commit");
		const status = await pending;
		expect(status.state).toBe("conflict");
		expect(status.nextOrdinal).toBe(first.nextOrdinal);
		expect(status.appliedCount).toBe(first.appliedCount);
		expect((await targetCounts()).maps).toBe(mapsBefore);
		expect(
			(
				await pool.query(
					"select count(*)::int as count from task where list_id = $1",
					[listId],
				)
			).rows[0]?.count,
		).toBe(first.appliedCount - 3);
	} finally {
		await mover.query("rollback");
		await pending;
		mover.release();
		await applying.end();
	}
});

test("workspace pin quota rolls the new batch back and retains previous imported rows", async () => {
	await finish(await save());
	await pool.query(
		`insert into import_workspace_map (source_id, source_workspace_id, owner_user_id, target_workspace_id)
		select $1, 'quota-pin-' || n, 'alice', 'other' from generate_series(1, 1000 - (select count(*)::int from import_workspace_map where owner_user_id = 'alice')) n`,
		[source.id],
	);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from import_workspace_map",
			)
		).rows,
	).toEqual([{ count: 1000 }]);
	const original = document.data.lists[0];
	if (!original) throw new Error("Missing list fixture");
	document.data.lists.push({
		...original,
		id: "new-other-list",
		workspaceId: "other",
		folderId: null,
		title: "New other list",
	});
	const job = await save();
	const before = await targetCounts();
	const status = await apply(job);
	expect(status.state).toBe("conflict");
	expect(status.conflictCode).toBe("import-map-quota-exceeded");
	expect(status.nextOrdinal).toBe(0);
	expect(status.appliedCount).toBe(0);
	expect(status.noopCount).toBe(0);
	expect(await targetCounts()).toEqual(before);
	expect(
		(await pool.query("select * from list where workspace_id = 'other'")).rows,
	).toEqual([]);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from import_workspace_map",
			)
		).rows,
	).toEqual([{ count: 1000 }]);
});

test("apply holds its list dependency against concurrent moves while waiting on the parent", async () => {
	addBulk();
	const job = await save();
	expect((await apply(job)).state).toBe("running");
	const listId = await targetId("lists", "list");
	const parentId = await targetId("tasks", "a-root");
	const blocker = await pool.connect();
	const mover = await pool.connect();
	const applying = new Pool({
		connectionString: databaseURL,
		application_name: "import-apply-held-lock-test",
	});
	applying.on("connect", (client) => {
		void client.query("set role ditero_import_apply_test");
	});
	let pending: ReturnType<typeof applyImportBatch> | undefined;
	try {
		await blocker.query("begin");
		const blockerPid = (
			await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0]?.pid;
		await blocker.query("select id from task where id = $1 for update", [
			parentId,
		]);
		pending = applyImportBatch(applying, "alice", job.id, confirmation(job));
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ count: number }>(
							"select count(*)::int as count from pg_stat_activity where application_name = 'import-apply-held-lock-test' and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))",
							[blockerPid],
						)
					).rows[0]?.count,
			)
			.toBe(1);
		await mover.query("begin");
		await mover.query("set local lock_timeout = '100ms'");
		await expect(
			mover.query(
				"update list set workspace_id = 'other', folder_id = null where id = $1",
				[listId],
			),
		).rejects.toMatchObject({ code: "55P03" });
		await mover.query("rollback");
		await blocker.query("commit");
		expect((await pending).state).toBe("completed");
		expect(
			(
				await pool.query("select workspace_id from list where id = $1", [
					listId,
				])
			).rows,
		).toEqual([{ workspace_id: "target" }]);
		expect((await targetCounts()).tasks).toBe(117);
	} finally {
		await mover.query("rollback");
		await blocker.query("rollback");
		await pending;
		mover.release();
		blocker.release();
		await applying.end();
	}
});
