import { randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import {
	type CollectedEvent,
	enqueueEvents,
	overdueSweep,
	withEventCollector,
} from "../../src/server/notifications/events.ts";
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
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
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
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_assignments_test') then create role ditero_import_assignments_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query(
		"grant usage on schema public to ditero_import_assignments_test",
	);
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_assignments_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_assignments_test");
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
	await db.insert(tables.membership).values([
		{ id: "source-bob", workspaceId: "source", userId: "bob", role: "member" },
		{ id: "target-bob", workspaceId: "target", userId: "bob", role: "viewer" },
	]);
	await db.insert(tables.taskAssignee).values([
		{ id: "a-root:alice", taskId: "a-root", userId: "alice" },
		{ id: "a-root:bob", taskId: "a-root", userId: "bob" },
		{ id: "z-child:bob", taskId: "z-child", userId: "bob" },
	]);
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	source = { mode: "new", id: randomUUID(), label: "Native source" };
	mappings = {
		workspaces: { source: "target", target: "target", other: "other" },
		principals: { alice: "alice", bob: "bob" },
	};
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});

const save = (plannerVersion: 2 | 3 = 3) =>
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

function addBulk(count = 115) {
	const original = document.data.tasks[0];
	if (!original) throw new Error("Missing fixture task");
	for (let i = 0; i < count; i++)
		document.data.tasks.push({
			...original,
			id: `bulk-${String(i).padStart(3, "0")}`,
			parentId: null,
			done: false,
			dueAt: null,
			completedAt: null,
		});
}
async function assignments() {
	return (
		await pool.query(
			"select a.id, a.task_id, a.user_id from task_assignee a join task t on t.id=a.task_id join list l on l.id=t.list_id where l.workspace_id='target' order by a.id",
		)
	).rows;
}
async function plannedAssignments(job: ImportPlanStatus) {
	return (
		await pool.query(
			"select disposition, target_id, dependency_proof from import_item where job_id=$1 and collection='assignments' order by ordinal",
			[job.id],
		)
	).rows;
}

test("self, viewer, and child assignments use canonical IDs and survive concurrent retries", async () => {
	const job = await save();
	const results = await Promise.all([apply(job), apply(job)]);
	expect(results.map((r) => r.state)).toEqual(["completed", "completed"]);
	expect(results[0].appliedCount).toBe(9);
	const frozen = await plannedAssignments(job);
	expect(frozen.map((row) => row.dependency_proof.assignee)).toEqual(
		expect.arrayContaining([
			{
				sourceUserId: "alice",
				targetUserId: "alice",
				workspaceId: "target",
				membershipId: "target-alice",
			},
			{
				sourceUserId: "bob",
				targetUserId: "bob",
				workspaceId: "target",
				membershipId: "target-bob",
			},
		]),
	);
	const root = await targetId("tasks", "a-root");
	const child = await targetId("tasks", "z-child");
	expect(await assignments()).toEqual(
		[
			{ id: `${root}:alice`, task_id: root, user_id: "alice" },
			{ id: `${root}:bob`, task_id: root, user_id: "bob" },
			{ id: `${child}:bob`, task_id: child, user_id: "bob" },
		].sort((a, b) => a.id.localeCompare(b.id)),
	);
	expect(await apply(job)).toEqual(results[0]);
	expect(await getImportRunStatus(runtime, "bob", job.id)).toBeNull();
	const next = await save();
	expect(await finish(next)).toMatchObject({ appliedCount: 0, noopCount: 9 });
	expect(await discardImportPlan(runtime, "alice", job.id)).toBe(true);
	await expect(
		discardImportSource(runtime, "alice", source.id),
	).rejects.toMatchObject({ code: "import-source-retained" });
	expect(await finish(await save())).toMatchObject({
		appliedCount: 0,
		noopCount: 9,
	});
});

test("v2 runs resume unchanged and v3 reuses their task maps", async () => {
	addBulk();
	const legacy = await save(2);
	expect((await apply(legacy)).state).toBe("running");
	expect(await finish(legacy)).toMatchObject({ appliedCount: 121 });
	expect(await assignments()).toEqual([]);
	const root = await targetId("tasks", "a-root");
	const current = await save();
	expect(await finish(current)).toMatchObject({
		appliedCount: 3,
		noopCount: 121,
	});
	expect(await targetId("tasks", "a-root")).toBe(root);
	expect(await assignments()).toHaveLength(3);
});

test("null and collapsed principal mappings exclude only affected assignments", async () => {
	mappings.principals.bob = null;
	const job = await save();
	expect(
		(await plannedAssignments(job)).map((r) => r.disposition).sort(),
	).toEqual(["blocked", "blocked", "ensure"]);
	await finish(job);
	expect(await assignments()).toHaveLength(1);
});

test("collapsed principals cannot claim the same target task-user pair twice", async () => {
	mappings.principals.bob = "alice";
	const job = await save();
	const rows = await plannedAssignments(job);
	expect(rows.filter((r) => r.disposition === "blocked")).toHaveLength(2);
	await finish(job);
	expect(await assignments()).toHaveLength(1);
});

test.each([
	"missing",
	"foreign",
	"wrong-workspace",
])("%s principal mapping is rejected before saving", async (kind) => {
	if (kind !== "missing")
		await db.insert(tables.user).values({
			id: "charlie",
			name: "Charlie",
			email: "charlie@example.test",
		});
	if (kind === "wrong-workspace")
		await db.insert(tables.membership).values({
			id: "other-charlie",
			workspaceId: "other",
			userId: "charlie",
			role: "viewer",
		});
	mappings.principals.bob = "charlie";
	await expect(save()).rejects.toMatchObject({
		code: "invalid-principal-mapping",
	});
});

test.each([
	"revoked",
	"recreated",
	"moved",
	"deleted-user",
])("%s assignee evidence stops the next batch and preserves committed work", async (kind) => {
	addBulk();
	const job = await save();
	const first = await apply(job);
	expect(first.state).toBe("running");
	if (kind === "deleted-user")
		await pool.query(`update "user" set deleted_at=now() where id='bob'`);
	else if (kind === "moved")
		await pool.query(
			"update membership set workspace_id='other' where id='target-bob'",
		);
	else {
		await pool.query("delete from membership where id='target-bob'");
		if (kind === "recreated")
			await db.insert(tables.membership).values({
				id: "replacement-bob",
				workspaceId: "target",
				userId: "bob",
				role: "viewer",
			});
	}
	const stopped = await apply(job);
	expect(stopped).toMatchObject({
		state: "conflict",
		conflictCode: "assignee-membership-conflict",
		nextOrdinal: first.nextOrdinal,
		appliedCount: first.appliedCount,
	});
	expect(await assignments()).toEqual([]);
	expect(await apply(job)).toEqual(stopped);
	expect(await discardImportPlan(runtime, "alice", job.id)).toBe(true);
});

test.each([
	"revoked",
	"recreated",
])("%s membership conflicts on mapped assignments without changing existing rows", async (kind) => {
	await finish(await save());
	const existing = await assignments();
	expect(existing).toHaveLength(3);
	const job = await save();
	const frozen = await pool.query<{ kind: string }>(
		"select target_precondition->>'kind' as kind from import_item where job_id=$1 and collection='assignments'",
		[job.id],
	);
	expect(frozen.rows).toEqual([
		{ kind: "mapped" },
		{ kind: "mapped" },
		{ kind: "mapped" },
	]);
	await pool.query("delete from membership where id='target-bob'");
	if (kind === "recreated")
		await db.insert(tables.membership).values({
			id: "replacement-bob",
			workspaceId: "target",
			userId: "bob",
			role: "viewer",
		});
	const stopped = await apply(job);
	expect(stopped).toMatchObject({
		state: "conflict",
		conflictCode: "assignee-membership-conflict",
		nextOrdinal: 0,
		appliedCount: 0,
		noopCount: 0,
	});
	expect(await assignments()).toEqual(existing);
	expect(await apply(job)).toEqual(stopped);
});

test("changing an assignee role to viewer keeps the frozen membership valid", async () => {
	await pool.query("update membership set role='member' where id='target-bob'");
	addBulk();
	const job = await save();
	await apply(job);
	await pool.query("update membership set role='viewer' where id='target-bob'");
	await finish(job);
	expect(await assignments()).toHaveLength(3);
});

test.each([
	"task",
	"list",
])("a target %s move stops assignments", async (kind) => {
	await finish(await save(2));
	const job = await save();
	if (kind === "list")
		await pool.query(
			"update list set workspace_id='other',folder_id=null where id=$1",
			[await targetId("lists", "list")],
		);
	else
		await pool.query("update task set list_id='list' where id=$1", [
			await targetId("tasks", "a-root"),
		]);
	expect((await apply(job)).state).toBe("conflict");
	expect(await assignments()).toEqual([]);
});

test.each([
	"before",
	"after",
])("a task-user collision %s planning never overwrites an assignment", async (when) => {
	await finish(await save(2));
	const root = await targetId("tasks", "a-root");
	let job: ImportPlanStatus | undefined;
	if (when === "after") job = await save();
	await db
		.insert(tables.taskAssignee)
		.values({ id: "manual-assignment", taskId: root, userId: "bob" });
	if (when === "before") {
		job = await save();
		expect(
			(await plannedAssignments(job)).filter(
				(r) => r.disposition === "blocked",
			),
		).toHaveLength(1);
		await finish(job);
	} else {
		if (!job) throw new Error("Missing saved plan");
		expect((await apply(job)).state).toBe("conflict");
	}
	expect(
		(
			await pool.query(
				"select user_id from task_assignee where id='manual-assignment'",
			)
		).rows,
	).toEqual([{ user_id: "bob" }]);
});

test("imports do not replay notifications and canonical assignments support normal unassign", async () => {
	await db.insert(tables.notificationChannel).values({
		id: "bob-channel",
		userId: "bob",
		kind: "ntfy",
		config: { serverUrl: "https://ntfy.example.test", topic: "assignments" },
		enabled: true,
	});
	const events: CollectedEvent[] = [];
	const job = await save();
	await withEventCollector(events, () => finish(job));
	await withEventCollector(events, () => apply(job));
	expect(events).toEqual([]);
	await scanTick(db, {
		now: new Date(now.getTime() + 30_000),
		timing: { tickMs: 1000, graceMs: 3_600_000, lateThresholdMs: 60_000 },
	});
	await overdueSweep(db, {
		now: new Date(now.getTime() + 30_000),
		maxQueuedPerUser: 100,
	});
	expect(
		(await pool.query("select count(*)::int as count from notification_outbox"))
			.rows[0].count,
	).toBe(0);
	const root = await targetId("tasks", "a-root");
	const zdb = zeroNodePg(schema, pool);
	await zdb.transaction((tx) =>
		mutators.task.unassign.fn({
			tx,
			ctx: { id: "alice" },
			args: { taskId: root, userId: "bob" },
		}),
	);
	expect(
		(
			await pool.query("select id from task_assignee where id=$1", [
				`${root}:bob`,
			])
		).rows,
	).toEqual([]);
	await withEventCollector(events, () =>
		zdb.transaction((tx) =>
			mutators.task.assign.fn({
				tx,
				ctx: { id: "alice" },
				args: { taskId: root, userId: "bob" },
			}),
		),
	);
	expect(events).toHaveLength(1);
	await enqueueEvents(db, events, { now, maxQueuedPerUser: 100 });
	expect(
		(await pool.query("select count(*)::int as count from notification_outbox"))
			.rows[0].count,
	).toBe(1);
});

async function waitsFor(blocker: number, application: string) {
	await expect
		.poll(
			async () =>
				(
					await pool.query<{ count: number }>(
						"select count(*)::int as count from pg_stat_activity where application_name=$1 and $2::int=any(pg_blocking_pids(pid))",
						[application, blocker],
					)
				).rows[0]?.count,
		)
		.toBe(1);
}

test("assignee SHARE lock blocks soft deletion until an applying batch commits", async () => {
	await finish(await save(2));
	const job = await save();
	const blocker = await pool.connect();
	const deleter = await pool.connect();
	const application = `assignment-apply-${randomUUID()}`;
	const applying = new Pool({
		connectionString: databaseURL,
		application_name: application,
		max: 1,
	});
	applying.on("connect", (client) => {
		void client.query("set role ditero_import_assignments_test");
	});
	let pending: ReturnType<typeof applyImportBatch> | undefined;
	let deletion: Promise<unknown> | undefined;
	try {
		await blocker.query("begin");
		const blockerPid = (await blocker.query("select pg_backend_pid() as pid"))
			.rows[0].pid as number;
		await blocker.query("select id from task where id=$1 for update", [
			await targetId("tasks", "a-root"),
		]);
		pending = applyImportBatch(applying, "alice", job.id, confirmation(job));
		await waitsFor(blockerPid, application);
		const applyingPid = (
			await pool.query(
				"select pid from pg_stat_activity where application_name=$1",
				[application],
			)
		).rows[0].pid as number;
		await deleter.query("begin");
		const deleteApplication = `assignment-delete-${randomUUID()}`;
		await deleter.query("select set_config('application_name',$1,true)", [
			deleteApplication,
		]);
		deletion = deleter.query(
			`update "user" set deleted_at=now() where id='bob'`,
		);
		await waitsFor(applyingPid, deleteApplication);
		await blocker.query("commit");
		expect((await pending).state).toBe("completed");
		await deletion;
		await deleter.query("rollback");
		expect(await assignments()).toHaveLength(3);
	} finally {
		await blocker.query("rollback");
		await pending?.catch(() => {});
		await deletion?.catch(() => {});
		await deleter.query("rollback");
		blocker.release();
		deleter.release();
		await applying.end();
	}
});

test("soft deletion committed before the SHARE lock makes the batch conflict", async () => {
	await finish(await save(2));
	const job = await save();
	const deleter = await pool.connect();
	const application = `assignment-after-delete-${randomUUID()}`;
	const applying = new Pool({
		connectionString: databaseURL,
		application_name: application,
		max: 1,
	});
	applying.on("connect", (client) => {
		void client.query("set role ditero_import_assignments_test");
	});
	let pending: ReturnType<typeof applyImportBatch> | undefined;
	try {
		await deleter.query("begin");
		const pid = (await deleter.query("select pg_backend_pid() as pid")).rows[0]
			.pid as number;
		await deleter.query(`update "user" set deleted_at=now() where id='bob'`);
		pending = applyImportBatch(applying, "alice", job.id, confirmation(job));
		await waitsFor(pid, application);
		await deleter.query("commit");
		expect(await pending).toMatchObject({
			state: "conflict",
			conflictCode: "assignee-membership-conflict",
			appliedCount: 0,
			nextOrdinal: 0,
		});
		expect(await assignments()).toEqual([]);
	} finally {
		await deleter.query("rollback");
		await pending?.catch(() => {});
		deleter.release();
		await applying.end();
	}
});

test("one principal mapped across workspaces freezes the matching membership for each assignment", async () => {
	await db.insert(tables.membership).values({
		id: "other-bob",
		workspaceId: "other",
		userId: "bob",
		role: "viewer",
	});
	await db.insert(tables.list).values({
		id: "second-list",
		workspaceId: "other",
		ownerId: "alice",
		title: "Second",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "second-task",
		listId: "second-list",
		title: "Second task",
		sortKey: "a0",
	});
	await db
		.insert(tables.taskAssignee)
		.values({ id: "second-task:bob", taskId: "second-task", userId: "bob" });
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	const job = await save();
	const rows = await plannedAssignments(job);
	expect(rows.map((row) => row.dependency_proof.assignee)).toEqual(
		expect.arrayContaining([
			{
				sourceUserId: "bob",
				targetUserId: "bob",
				workspaceId: "target",
				membershipId: "target-bob",
			},
			{
				sourceUserId: "bob",
				targetUserId: "bob",
				workspaceId: "other",
				membershipId: "other-bob",
			},
		]),
	);
	await finish(job);
	const second = await targetId("tasks", "second-task");
	expect(
		(
			await pool.query("select id from task_assignee where task_id=$1", [
				second,
			])
		).rows,
	).toEqual([{ id: `${second}:bob` }]);
});
