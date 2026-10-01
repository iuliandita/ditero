import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { withProducerTaskActivation } from "../../src/server/notifications/task-activation.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import {
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const raceRuntime = new Pool({
	connectionString: databaseURL,
	application_name: "import-activation-race",
});
const db = drizzle(pool, { schema: tables });
const historicalDue = new Date("2026-09-20T10:00:00.000Z");
let document: PortableExportV1;
let mappings: ImportMappings;
let source: { mode: "new"; id: string; label: string };

beforeAll(async () => {
	await pool.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_activation_apply_test') then create role ditero_import_activation_apply_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query(
		"grant usage on schema public to ditero_import_activation_apply_test",
	);
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_activation_apply_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_activation_apply_test");
	});
	raceRuntime.on("connect", (client) => {
		void client.query("set role ditero_import_activation_apply_test");
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
		{ id: "source-bob", workspaceId: "source", userId: "bob", role: "member" },
		{
			id: "target-alice",
			workspaceId: "target",
			userId: "alice",
			role: "owner",
		},
		{ id: "target-bob", workspaceId: "target", userId: "bob", role: "member" },
	]);
	await db.insert(tables.list).values({
		id: "source-list",
		workspaceId: "source",
		ownerId: "alice",
		title: "Source list",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "source-task",
		listId: "source-list",
		title: "Reminder",
		sortKey: "a0",
		dueAt: historicalDue,
		reminderTime: "09:00",
		fallbackUserId: "bob",
		urgent: true,
	});
	await db.insert(tables.taskAssignee).values({
		id: "source-task:bob",
		taskId: "source-task",
		userId: "bob",
	});
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	mappings = {
		workspaces: { source: "target", target: "target" },
		principals: { alice: "alice", bob: "bob" },
	};
	source = { mode: "new", id: randomUUID(), label: "Native source" };
}, 20_000);

afterAll(async () => {
	await raceRuntime.end();
	await runtime.end();
	await pool.end();
});

const save = (existing = false) =>
	saveImportPlan(
		runtime,
		"alice",
		existing ? { mode: "existing", id: source.id } : source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
const confirmation = (job: ImportPlanStatus) => ({
	planDigest: job.planDigest,
	counts: job.report.counts,
});
async function finish(job: ImportPlanStatus) {
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++)
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	expect(status.state).toBe("completed");
	return status;
}
async function targetId(collection: string, sourceId: string) {
	const row = (
		await pool.query<{ target_id: string }>(
			"select target_id from import_source_map where source_id=$1 and collection=$2 and source_row_id=$3",
			[source.id, collection, sourceId],
		)
	).rows[0];
	if (!row) throw new Error(`Missing ${collection} map`);
	return row.target_id;
}

async function addManyAssignees(count: number) {
	const ids = Array.from(
		{ length: count },
		(_, index) => `member-${String(index).padStart(3, "0")}`,
	);
	await db
		.insert(tables.user)
		.values(ids.map((id) => ({ id, name: id, email: `${id}@example.test` })));
	await db.insert(tables.membership).values(
		ids.flatMap((id) => [
			{
				id: `source-${id}`,
				workspaceId: "source",
				userId: id,
				role: "member" as const,
			},
			{
				id: `target-${id}`,
				workspaceId: "target",
				userId: id,
				role: "member" as const,
			},
		]),
	);
	await db.insert(tables.taskAssignee).values(
		ids.map((id) => ({
			id: `source-task:${id}`,
			taskId: "source-task",
			userId: id,
		})),
	);
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	for (const id of ids) mappings.principals[id] = id;
	return ids;
}

async function activeTransitionPlan() {
	const first = await save();
	await finish(first);
	const id = await targetId("tasks", "source-task");
	document.data.assignments.push({
		id: "source-task:alice",
		taskId: "source-task",
		userId: "alice",
	});
	return { id, job: await save(true) };
}

async function blockedBy(blockerPid: number) {
	return (
		(
			await pool.query<{ count: number }>(
				`select count(*)::int as count from pg_stat_activity
			where application_name='import-activation-race' and wait_event_type='Lock'
			and $1::int=any(pg_blocking_pids(pid))`,
				[blockerPid],
			)
		).rows[0]?.count ?? 0
	);
}

test.each([
	{ plannerVersion: 99, applySupported: true },
	{ plannerVersion: 4, applySupported: false },
])("public apply refuses unsupported saved plans without writes: %j", async ({
	plannerVersion,
	applySupported,
}) => {
	const job = await save();
	await pool.query(
		`update import_job set planner_version=$1, apply_supported=$2,
		 report=jsonb_set(jsonb_set(report, '{plannerVersion}', to_jsonb($1::int)), '{applySupported}', to_jsonb($2::boolean))
		 where id=$3`,
		[plannerVersion, applySupported, job.id],
	);
	await expect(
		applyImportBatch(runtime, "alice", job.id, confirmation(job)),
	).rejects.toMatchObject({ code: "import-apply-unsupported" });
	expect(
		(await pool.query("select count(*)::int as count from import_run")).rows[0]
			?.count,
	).toBe(0);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_activation",
			)
		).rows[0]?.count,
	).toBe(0);
});

test("public v4 apply requires exact confirmation before publishing the task", async () => {
	const job = await save();
	await expect(
		applyImportBatch(runtime, "alice", job.id, {
			...confirmation(job),
			planDigest: "0".repeat(64),
		}),
	).rejects.toMatchObject({ code: "import-confirmation-mismatch" });
	expect(
		(await pool.query("select count(*)::int as count from import_run")).rows[0]
			?.count,
	).toBe(0);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_activation",
			)
		).rows[0]?.count,
	).toBe(0);
	const result = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	expect(result.state).toBe("completed");
	const id = await targetId("tasks", "source-task");
	expect(
		(
			await pool.query(
				"select status from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0]?.status,
	).toBe("active");
});

test("v4 publishes a new task only after its assignment and suppresses historical overdue for its recipient", async () => {
	const job = await save();
	const status = await finish(job);
	expect(status.appliedCount).toBe(3);
	const id = await targetId("tasks", "source-task");
	const guard = (
		await pool.query<{
			status: string;
			generation: number;
			import_occurrence_cutoff: Date;
			recipient_generation_cutoff: Date;
		}>(
			"select status,generation,import_occurrence_cutoff,recipient_generation_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(guard).toMatchObject({ status: "active", generation: 1 });
	expect(guard?.recipient_generation_cutoff.getTime()).toBeGreaterThanOrEqual(
		guard?.import_occurrence_cutoff.getTime() ?? Infinity,
	);
	const recipients = (
		await pool.query<{
			user_id: string;
			active: boolean;
			generation: number;
			overdue_suppressed_due_at: Date | null;
		}>(
			"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id=$1",
			[id],
		)
	).rows;
	expect(recipients).toEqual([
		{
			user_id: "bob",
			active: true,
			generation: 1,
			overdue_suppressed_due_at: historicalDue,
		},
	]);
});

test("v4 applies empty task and principal source IDs through assignment activation", async () => {
	const task = document.data.tasks[0];
	const assignment = document.data.assignments[0];
	const principal = document.data.principals.find((row) => row.id === "bob");
	if (!task || !assignment || !principal)
		throw new Error("Missing source task or principal");
	task.id = "";
	task.fallbackUserId = "";
	assignment.taskId = "";
	assignment.userId = "";
	principal.id = "";
	for (const membership of document.data.memberships)
		if (membership.userId === "bob") membership.userId = "";
	delete mappings.principals.bob;
	mappings.principals[""] = "bob";
	const job = await save();
	const status = await finish(job);
	expect(status.appliedCount).toBe(3);
	const taskId = await targetId("tasks", "");
	const assignmentId = await targetId("assignments", assignment.id);
	expect(
		(
			await pool.query(
				"select task_id, user_id from task_assignee where id = $1",
				[assignmentId],
			)
		).rows[0],
	).toEqual({ task_id: taskId, user_id: "bob" });
	expect(
		(
			await pool.query(
				"select status from task_notification_activation where task_id = $1",
				[taskId],
			)
		).rows[0]?.status,
	).toBe("active");
});

test("a returning assignee retains null overdue suppression across generations", async () => {
	const future = new Date("2099-01-01T10:00:00.000Z");
	const task = document.data.tasks.find((row) => row.id === "source-task");
	if (!task) throw new Error("Missing source task");
	task.dueAt = future.toISOString();
	const job = await save();
	await finish(job);
	const id = await targetId("tasks", "source-task");
	const recipient = (
		await pool.query<{ overdue_suppressed_due_at: Date | null }>(
			"select overdue_suppressed_due_at from task_notification_recipient where task_id=$1 and user_id='bob'",
			[id],
		)
	).rows[0];
	expect(recipient?.overdue_suppressed_due_at).toBeNull();
	await pool.query(
		"delete from task_assignee where task_id=$1 and user_id='bob'",
		[id],
	);
	document.data.assignments = [
		{ id: "source-task:alice", taskId: "source-task", userId: "alice" },
	];
	const second = await save(true);
	await finish(second);
	expect(
		(
			await pool.query(
				"select active from task_notification_recipient where task_id=$1 and user_id='bob'",
				[id],
			)
		).rows[0]?.active,
	).toBe(false);

	await db.insert(tables.user).values({
		id: "charlie",
		name: "Charlie",
		email: "charlie@example.test",
	});
	await db.insert(tables.membership).values([
		{
			id: "source-charlie",
			workspaceId: "source",
			userId: "charlie",
			role: "member",
		},
		{
			id: "target-charlie",
			workspaceId: "target",
			userId: "charlie",
			role: "member",
		},
	]);
	mappings.principals.charlie = "charlie";
	document.data.principals.push({ id: "charlie", name: "Charlie" });
	document.data.memberships.push({
		id: "source-charlie",
		workspaceId: "source",
		userId: "charlie",
		role: "member",
	});
	await db.insert(tables.taskAssignee).values({
		id: `${id}:bob`,
		taskId: id,
		userId: "bob",
	});
	document.data.assignments.push({
		id: "source-task:charlie",
		taskId: "source-task",
		userId: "charlie",
	});
	const third = await save(true);
	await finish(third);
	expect(
		(
			await pool.query(
				"select active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id=$1 and user_id='bob'",
				[id],
			)
		).rows[0],
	).toEqual({
		active: true,
		generation: 3,
		overdue_suppressed_due_at: null,
	});
});

test("unassigned fallback deactivates on assignment and keeps its null suppression when it returns", async () => {
	const future = new Date("2099-01-01T10:00:00.000Z");
	const task = document.data.tasks.find((row) => row.id === "source-task");
	if (!task) throw new Error("Missing source task");
	task.dueAt = future.toISOString();
	document.data.assignments = [];
	const first = await save();
	await finish(first);
	const id = await targetId("tasks", "source-task");
	const initial = (
		await pool.query<{
			user_id: string;
			active: boolean;
			overdue_suppressed_due_at: Date | null;
		}>(
			"select user_id,active,overdue_suppressed_due_at from task_notification_recipient where task_id=$1",
			[id],
		)
	).rows;
	expect(initial).toEqual([
		{ user_id: "alice", active: true, overdue_suppressed_due_at: null },
	]);

	await db.insert(tables.user).values({
		id: "charlie",
		name: "Charlie",
		email: "charlie@example.test",
	});
	await db.insert(tables.membership).values([
		{
			id: "source-charlie",
			workspaceId: "source",
			userId: "charlie",
			role: "member",
		},
		{
			id: "target-charlie",
			workspaceId: "target",
			userId: "charlie",
			role: "member",
		},
	]);
	mappings.principals.charlie = "charlie";
	document.data.principals.push({ id: "charlie", name: "Charlie" });
	document.data.memberships.push({
		id: "source-charlie",
		workspaceId: "source",
		userId: "charlie",
		role: "member",
	});
	await db.insert(tables.taskAssignee).values({
		id: `${id}:bob`,
		taskId: id,
		userId: "bob",
	});
	document.data.assignments.push({
		id: "source-task:charlie",
		taskId: "source-task",
		userId: "charlie",
	});
	const second = await save(true);
	await finish(second);
	expect(
		(
			await pool.query(
				"select user_id,active from task_notification_recipient where task_id=$1 order by user_id",
				[id],
			)
		).rows,
	).toEqual([
		{ user_id: "alice", active: false },
		{ user_id: "bob", active: true },
		{ user_id: "charlie", active: true },
	]);

	await pool.query(
		"delete from task_assignee where task_id=$1 and user_id='bob'",
		[id],
	);
	document.data.assignments.push({
		id: "source-task:alice",
		taskId: "source-task",
		userId: "alice",
	});
	const third = await save(true);
	await finish(third);
	expect(
		(
			await pool.query(
				"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id=$1 order by user_id",
				[id],
			)
		).rows,
	).toEqual([
		{
			user_id: "alice",
			active: true,
			generation: 3,
			overdue_suppressed_due_at: null,
		},
		{
			user_id: "bob",
			active: false,
			generation: 2,
			overdue_suppressed_due_at: null,
		},
		{
			user_id: "charlie",
			active: true,
			generation: 3,
			overdue_suppressed_due_at: null,
		},
	]);
});

test("active mapped task pauses for a new assignment, advances only its generation cutoff, and preserves returning recipient evidence", async () => {
	const first = await save();
	await finish(first);
	const id = await targetId("tasks", "source-task");
	const before = (
		await pool.query<{
			import_occurrence_cutoff: Date;
			recipient_generation_cutoff: Date;
		}>(
			"select import_occurrence_cutoff,recipient_generation_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	if (!before) throw new Error("Missing first activation");
	document.data.assignments.push({
		id: "source-task:alice",
		taskId: "source-task",
		userId: "alice",
	});
	const second = await save(true);
	await finish(second);
	const after = (
		await pool.query<{
			status: string;
			generation: number;
			import_occurrence_cutoff: Date;
			recipient_generation_cutoff: Date;
		}>(
			"select status,generation,import_occurrence_cutoff,recipient_generation_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(after).toMatchObject({ status: "active", generation: 2 });
	expect(after?.import_occurrence_cutoff).toEqual(
		before.import_occurrence_cutoff,
	);
	expect(after?.recipient_generation_cutoff.getTime()).toBeGreaterThanOrEqual(
		before.recipient_generation_cutoff.getTime(),
	);
	const recipients = (
		await pool.query<{
			user_id: string;
			active: boolean;
			generation: number;
			overdue_suppressed_due_at: Date | null;
		}>(
			"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id=$1 order by user_id",
			[id],
		)
	).rows;
	expect(recipients).toEqual([
		{
			user_id: "alice",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: historicalDue,
		},
		{
			user_id: "bob",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: historicalDue,
		},
	]);
	const observed = await save(true);
	await finish(observed);
	const final = (
		await pool.query<{ generation: number; recipient_generation_cutoff: Date }>(
			"select generation,recipient_generation_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(final).toEqual({
		generation: 2,
		recipient_generation_cutoff: after?.recipient_generation_cutoff,
	});
});

test("a task stays pending across the 100-item window and publishes the complete recipient set", async () => {
	const added = await addManyAssignees(105);
	const job = await save();
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select 1 from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
			[source.id],
		);
		if (mapped.rowCount) break;
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	}
	expect(status.state).toBe("running");
	const id = await targetId("tasks", "source-task");
	const pending = (
		await pool.query<{ status: string; import_occurrence_cutoff: Date | null }>(
			"select status,import_occurrence_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(pending).toEqual({
		status: "pending",
		import_occurrence_cutoff: null,
	});
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_recipient where task_id=$1",
				[id],
			)
		).rows[0]?.count,
	).toBe(0);
	for (let batch = 0; status.state === "running" && batch < 20; batch++)
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	expect(status.state).toBe("completed");
	const active = (
		await pool.query<{ status: string; generation: number }>(
			"select status,generation from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(active).toEqual({ status: "active", generation: 1 });
	const recipients = (
		await pool.query<{ user_id: string }>(
			"select user_id from task_notification_recipient where task_id=$1 and active order by user_id",
			[id],
		)
	).rows.map((row) => row.user_id);
	expect(recipients).toEqual(["bob", ...added].sort());
}, 20_000);

test("an independently ready task activates while a later assignment-heavy task remains pending", async () => {
	await addManyAssignees(105);
	await db.insert(tables.task).values({
		id: "a-early",
		listId: "source-list",
		title: "Early reminder",
		sortKey: "a1",
		dueAt: historicalDue,
		reminderTime: "08:00",
	});
	document = JSON.parse(
		await exportPortableJson(pool, "alice"),
	) as PortableExportV1;
	const job = await save();
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select count(*)::int as count from import_source_map where source_id=$1 and collection='tasks' and source_row_id in ('a-early','source-task')",
			[source.id],
		);
		if (mapped.rows[0]?.count === 2) break;
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	}
	expect(status.state).toBe("running");
	const earlyId = await targetId("tasks", "a-early");
	const slowId = await targetId("tasks", "source-task");
	const rows = (
		await pool.query<{ task_id: string; status: string }>(
			"select task_id,status from task_notification_activation where task_id=any($1::text[])",
			[[earlyId, slowId]],
		)
	).rows;
	expect(rows).toContainEqual({ task_id: earlyId, status: "active" });
	expect(rows).toContainEqual({ task_id: slowId, status: "pending" });
	expect(
		(
			await pool.query(
				"select user_id from task_notification_recipient where task_id=$1 and active",
				[earlyId],
			)
		).rows,
	).toEqual([{ user_id: "alice" }]);
}, 20_000);

test("readiness evidence drift rolls back remaining links and leaves the cursor unchanged", async () => {
	await addManyAssignees(105);
	const job = await save();
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select 1 from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
			[source.id],
		);
		if (mapped.rowCount) break;
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	}
	expect(status.state).toBe("running");
	const id = await targetId("tasks", "source-task");
	const countBefore = (
		await pool.query<{ count: number }>(
			"select count(*)::int as count from task_assignee where task_id=$1",
			[id],
		)
	).rows[0]?.count;
	await pool.query(
		"update task_notification_activation set expected_relationship_digest=$2 where task_id=$1",
		[id, "b".repeat(64)],
	);
	const stopped = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	expect(stopped).toMatchObject({
		state: "conflict",
		conflictCode: "activation-evidence-conflict",
		nextOrdinal: status.nextOrdinal,
	});
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_assignee where task_id=$1",
				[id],
			)
		).rows[0]?.count,
	).toBe(countBefore);
	expect(
		(
			await pool.query(
				"select status from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0]?.status,
	).toBe("pending");
}, 20_000);

test("a revoked required seat conflicts a pending batch without advancing its cursor or links", async () => {
	await addManyAssignees(105);
	const job = await save();
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select 1 from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
			[source.id],
		);
		if (mapped.rowCount) break;
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	}
	expect(status.state).toBe("running");
	const id = await targetId("tasks", "source-task");
	const before = (
		await pool.query<{ count: number }>(
			"select count(*)::int as count from task_assignee where task_id=$1",
			[id],
		)
	).rows[0]?.count;
	await pool.query("delete from membership where id='target-member-104'");
	const stopped = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	expect(stopped).toMatchObject({
		state: "conflict",
		conflictCode: "assignee-membership-conflict",
		nextOrdinal: status.nextOrdinal,
	});
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_assignee where task_id=$1",
				[id],
			)
		).rows[0]?.count,
	).toBe(before);
	expect(
		(
			await pool.query(
				"select status from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0]?.status,
	).toBe("pending");
}, 20_000);

test("more than 100 ready guards cannot be hidden behind the activation page limit", async () => {
	await addManyAssignees(105);
	const job = await save();
	let status = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	for (let batch = 0; status.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select 1 from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
			[source.id],
		);
		if (mapped.rowCount) break;
		status = await applyImportBatch(
			runtime,
			"alice",
			job.id,
			confirmation(job),
		);
	}
	expect(status.state).toBe("running");
	const listId = await targetId("lists", "source-list");
	const ids = Array.from(
		{ length: 101 },
		(_, index) => `extra-${String(index).padStart(3, "0")}`,
	);
	await db
		.insert(tables.task)
		.values(ids.map((id) => ({ id, listId, title: id, sortKey: id })));
	await db.insert(tables.taskNotificationActivation).values(
		ids.map((taskId) => ({
			taskId,
			status: "pending",
			generation: 1,
			owningJobId: job.id,
			readinessOrdinal: 0,
		})),
	);
	const stopped = await applyImportBatch(
		runtime,
		"alice",
		job.id,
		confirmation(job),
	);
	expect(stopped).toMatchObject({
		state: "conflict",
		conflictCode: "activation-readiness-conflict",
		nextOrdinal: status.nextOrdinal,
	});
}, 20_000);

test("a terminal old run can be adopted by one sealed task item and then published", async () => {
	await addManyAssignees(105);
	const first = await save();
	let firstStatus = await applyImportBatch(
		runtime,
		"alice",
		first.id,
		confirmation(first),
	);
	for (let batch = 0; firstStatus.state === "running" && batch < 20; batch++) {
		const mapped = await pool.query(
			"select 1 from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
			[source.id],
		);
		if (mapped.rowCount) break;
		firstStatus = await applyImportBatch(
			runtime,
			"alice",
			first.id,
			confirmation(first),
		);
	}
	expect(firstStatus.state).toBe("running");
	const id = await targetId("tasks", "source-task");
	await pool.query(
		"update import_run set state='conflict',conflict_code='test-terminal',conflict_ordinal=next_ordinal where job_id=$1",
		[first.id],
	);
	const second = await save(true);
	await finish(second);
	const guard = (
		await pool.query<{
			status: string;
			generation: number;
			owning_job_id: string;
			import_occurrence_cutoff: Date;
		}>(
			"select status,generation,owning_job_id,import_occurrence_cutoff from task_notification_activation where task_id=$1",
			[id],
		)
	).rows[0];
	expect(guard).toMatchObject({
		status: "active",
		generation: 2,
		owning_job_id: second.id,
	});
	expect(guard?.import_occurrence_cutoff).toBeInstanceOf(Date);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_recipient where task_id=$1 and active",
				[id],
			)
		).rows[0]?.count,
	).toBe(106);
}, 20_000);

test("a stale active-generation proof conflicts without writing a new assignment", async () => {
	const first = await save();
	await finish(first);
	const id = await targetId("tasks", "source-task");
	document.data.assignments.push({
		id: "source-task:alice",
		taskId: "source-task",
		userId: "alice",
	});
	const stale = await save(true);
	await pool.query(
		"update task_notification_activation set generation=generation+1,updated_at=now() where task_id=$1",
		[id],
	);
	const result = await applyImportBatch(
		runtime,
		"alice",
		stale.id,
		confirmation(stale),
	);
	expect(result).toMatchObject({
		state: "conflict",
		conflictCode: "activation-precondition-conflict",
	});
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_assignee where task_id=$1 and user_id='alice'",
				[id],
			)
		).rows[0]?.count,
	).toBe(0);
	expect(
		(
			await pool.query(
				"select generation,status from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0],
	).toEqual({ generation: 2, status: "active" });
});

test("an unchanged notification-inert legacy task gains a guard only when a new v4 link is added", async () => {
	const task = document.data.tasks.find((row) => row.id === "source-task");
	if (!task) throw new Error("Missing source task");
	task.dueAt = null;
	task.reminderTime = null;
	task.fallbackUserId = null;
	task.urgent = false;
	document.data.assignments = [];
	const legacy = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 3 },
	);
	let legacyStatus = await applyImportBatch(
		runtime,
		"alice",
		legacy.id,
		confirmation(legacy),
	);
	for (let batch = 0; legacyStatus.state === "running" && batch < 20; batch++)
		legacyStatus = await applyImportBatch(
			runtime,
			"alice",
			legacy.id,
			confirmation(legacy),
		);
	expect(legacyStatus.state).toBe("completed");
	const id = await targetId("tasks", "source-task");
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0]?.count,
	).toBe(0);
	const guardless = await save(true);
	await finish(guardless);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0]?.count,
	).toBe(0);
	document.data.assignments.push({
		id: "source-task:bob",
		taskId: "source-task",
		userId: "bob",
	});
	const linked = await save(true);
	await finish(linked);
	expect(
		(
			await pool.query(
				"select status,generation from task_notification_activation where task_id=$1",
				[id],
			)
		).rows[0],
	).toEqual({ status: "active", generation: 1 });
	expect(
		(
			await pool.query(
				"select user_id,active from task_notification_recipient where task_id=$1",
				[id],
			)
		).rows,
	).toEqual([{ user_id: "bob", active: true }]);
});

test("a producer holding the task share lock finishes before the v4 transition", async () => {
	const { id, job } = await activeTransitionPlan();
	const producer = await runtime.connect();
	let releaseProducer = () => {};
	const holdProducer = new Promise<void>((resolve) => {
		releaseProducer = resolve;
	});
	let enteredProducer = () => {};
	const entered = new Promise<void>((resolve) => {
		enteredProducer = resolve;
	});
	let producerWork: Promise<number> | undefined;
	let applyWork: Promise<unknown> | undefined;
	try {
		await producer.query("begin");
		const producerPid = (
			await producer.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0]?.pid;
		if (!producerPid) throw new Error("Missing producer backend");
		producerWork = withProducerTaskActivation(producer, id, async (lookup) => {
			if (lookup.kind !== "guarded") throw new Error("Expected active guard");
			enteredProducer();
			await holdProducer;
			return lookup.generation;
		});
		await entered;
		applyWork = applyImportBatch(
			raceRuntime,
			"alice",
			job.id,
			confirmation(job),
		);
		await expect
			.poll(() => blockedBy(producerPid), { timeout: 5_000 })
			.toBeGreaterThan(0);
		releaseProducer();
		expect(await producerWork).toBe(1);
		await producer.query("commit");
		const result = await applyWork;
		expect(result).toMatchObject({ state: "completed" });
	} finally {
		releaseProducer();
		await producer.query("rollback").catch(() => {});
		producer.release();
		await applyWork;
	}
});

test("a v4 transition holding the task update lock makes the producer observe the published generation", async () => {
	const { id, job } = await activeTransitionPlan();
	const holder = await pool.connect();
	const producer = await runtime.connect();
	let applyWork: Promise<unknown> | undefined;
	let producerWork: Promise<number> | undefined;
	try {
		await holder.query("begin");
		await holder.query(
			"select task_id from task_notification_recipient where task_id=$1 and user_id='bob' for update",
			[id],
		);
		const holderPid = (
			await holder.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0]?.pid;
		if (!holderPid) throw new Error("Missing holder backend");
		applyWork = applyImportBatch(
			raceRuntime,
			"alice",
			job.id,
			confirmation(job),
		);
		await expect
			.poll(() => blockedBy(holderPid), { timeout: 5_000 })
			.toBeGreaterThan(0);
		const importerPid = (
			await pool.query<{ pid: number }>(
				`select pid from pg_stat_activity where application_name='import-activation-race'
				and wait_event_type='Lock' and $1::int=any(pg_blocking_pids(pid))`,
				[holderPid],
			)
		).rows[0]?.pid;
		if (!importerPid) throw new Error("Missing blocked importer backend");
		await producer.query("begin");
		const producerPid = (
			await producer.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0]?.pid;
		if (!producerPid) throw new Error("Missing producer backend");
		producerWork = withProducerTaskActivation(producer, id, async (lookup) => {
			if (lookup.kind !== "guarded") throw new Error("Expected active guard");
			return lookup.generation;
		});
		await expect
			.poll(
				async () =>
					(
						await pool.query<{ blocked: boolean }>(
							"select $1::int=any(pg_blocking_pids($2::int)) as blocked",
							[importerPid, producerPid],
						)
					).rows[0]?.blocked,
				{ timeout: 5_000 },
			)
			.toBe(true);
		await holder.query("commit");
		expect(await applyWork).toMatchObject({ state: "completed" });
		expect(await producerWork).toBe(2);
		await producer.query("commit");
	} finally {
		await holder.query("rollback").catch(() => {});
		await producer.query("rollback").catch(() => {});
		holder.release();
		producer.release();
		await applyWork;
		await producerWork;
	}
});
