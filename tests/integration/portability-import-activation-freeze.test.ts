import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import { saveImportPlan } from "../../src/server/portability/import-plan-store.ts";
import { digestImportTarget } from "../../src/server/portability/import-target.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
let document: PortableExportV1;
let mappings: ImportMappings;
let source: { mode: "new"; id: string; label: string };

beforeAll(async () => {
	await pool.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_import_activation_freeze_test') then create role ditero_import_activation_freeze_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await pool.query(
		"grant usage on schema public to ditero_import_activation_freeze_test",
	);
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_import_activation_freeze_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_import_activation_freeze_test");
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
		{ id: "source-bob", workspaceId: "source", userId: "bob", role: "member" },
		{ id: "target-bob", workspaceId: "target", userId: "bob", role: "member" },
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
		title: "Reminder",
		sortKey: "a0",
		dueAt: new Date("2026-09-20T10:00:00.000Z"),
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
});
afterAll(async () => {
	await runtime.end();
	await pool.end();
});

async function frozenItems(jobId: string) {
	return (
		await pool.query<{
			collection: string;
			source_id: string;
			ordinal: number;
			source_key: string;
			target_id: string | null;
			content_digest: string | null;
			payload: Record<string, unknown>;
			disposition: string;
			dependency_proof: Record<string, unknown> | null;
		}>(
			`select collection, source_id, source_key, target_id, ordinal, content_digest, payload, disposition, dependency_proof from import_item where job_id = $1 order by ordinal`,
			[jobId],
		)
	).rows;
}

async function seedMappedTarget(jobId: string) {
	const rows = await frozenItems(jobId);
	for (const collection of ["lists", "tasks"] as const) {
		const item = rows.find((row) => row.collection === collection);
		if (!item?.target_id || !item.content_digest)
			throw new Error(`Missing ${collection} item`);
		const table = collection === "lists" ? "list" : "task";
		const fields = Object.entries(item.payload);
		const columns = fields.map(
			([key]) =>
				`"${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}"`,
		);
		await pool.query(
			`insert into "${table}" (${columns.join(", ")}) values (${fields.map((_, index) => `$${index + 1}`).join(", ")})`,
			fields.map(([, value]) => value),
		);
		const target = (
			await pool.query<Record<string, unknown>>(
				`select * from "${table}" where id = $1`,
				[item.target_id],
			)
		).rows[0];
		if (!target) throw new Error(`Missing ${table} target`);
		await pool.query(
			`insert into import_source_map (source_id, source_key, owner_user_id, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest) values ($1,$2,'alice',$3,$4,$5,'target',$6,$7,$8)`,
			[
				source.id,
				item.source_key,
				collection,
				item.source_id,
				item.target_id,
				item.content_digest,
				await digestImportTarget(collection, target, () => {}),
				jobId,
			],
		);
	}
	return rows.find((row) => row.collection === "tasks")?.target_id ?? "";
}

async function seedMappedAssignment(jobId: string, taskId: string) {
	const item = (await frozenItems(jobId)).find(
		(row) => row.collection === "assignments",
	);
	if (!item?.target_id || !item.content_digest)
		throw new Error("Missing assignment item");
	await db
		.insert(tables.taskAssignee)
		.values({ id: item.target_id, taskId, userId: "bob" });
	const target = (
		await pool.query<Record<string, unknown>>(
			"select * from task_assignee where id = $1",
			[item.target_id],
		)
	).rows[0];
	if (!target) throw new Error("Missing assignment target");
	await pool.query(
		`insert into import_source_map (source_id, source_key, owner_user_id, collection, source_row_id, target_id, target_workspace_id, content_digest, last_target_digest, last_plan_digest) values ($1,$2,'alice','assignments',$3,$4,'target',$5,$6,$7)`,
		[
			source.id,
			item.source_key,
			item.source_id,
			item.target_id,
			item.content_digest,
			await digestImportTarget("assignments", target, () => {}),
			jobId,
		],
	);
}

test("explicit v4 save freezes complete recipients and fallback with live seats", async () => {
	const before = await pool.query("select count(*)::int as count from task");
	const saved = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	expect(saved.report).toMatchObject({
		plannerVersion: 4,
		applySupported: true,
	});
	const rows = await frozenItems(saved.id);
	const task = rows.find(
		(row) => row.collection === "tasks" && row.source_id === "source-task",
	);
	const assignment = rows.find((row) => row.collection === "assignments");
	expect(task?.disposition).toBe("ensure");
	expect(assignment?.disposition).toBe("ensure");
	expect(task?.dependency_proof).toMatchObject({
		fallback: {
			sourceUserId: "bob",
			targetUserId: "bob",
			workspaceId: "target",
			membershipId: "target-bob",
		},
		activation: {
			kind: "transition",
			precondition: { kind: "absent" },
			generation: 1,
			readinessOrdinal: assignment?.ordinal,
			expectedRelationships: {
				count: 2,
				evidence: {
					version: 1,
					workspaceId: "target",
					assignees: [{ userId: "bob", membershipId: "target-bob" }],
					ownerFallback: null,
					escalationFallback: { userId: "bob", membershipId: "target-bob" },
				},
			},
		},
	});
	expect(assignment?.dependency_proof).toMatchObject({
		taskActivationGeneration: 1,
	});
	expect(
		(await pool.query("select count(*)::int as count from task")).rows,
	).toEqual(before.rows);
	expect(
		(
			await pool.query(
				"select count(*)::int as count from task_notification_activation",
			)
		).rows[0]?.count,
	).toBe(0);
});

test("v4 freezes an assignment to a task with an empty source ID", async () => {
	const task = document.data.tasks[0];
	const assignment = document.data.assignments[0];
	if (!task || !assignment)
		throw new Error("Missing source task or assignment");
	task.id = "";
	assignment.taskId = "";
	const saved = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	expect(saved.report).toMatchObject({ applySupported: true });
	const rows = await frozenItems(saved.id);
	const frozenTask = rows.find(
		(row) => row.collection === "tasks" && row.source_id === "",
	);
	const frozenAssignment = rows.find((row) => row.collection === "assignments");
	expect(frozenTask?.dependency_proof).toMatchObject({
		activation: {
			kind: "transition",
			readinessOrdinal: frozenAssignment?.ordinal,
			expectedRelationships: {
				count: 2,
				evidence: {
					assignees: [{ userId: "bob", membershipId: "target-bob" }],
				},
			},
		},
	});
	expect(frozenAssignment?.dependency_proof).toMatchObject({
		taskActivationGeneration: 1,
	});
});

test("v4 retains an empty principal source ID in assignee and fallback proofs", async () => {
	const principal = document.data.principals.find((row) => row.id === "bob");
	const memberships = document.data.memberships.filter(
		(row) => row.userId === "bob",
	);
	const task = document.data.tasks[0];
	const assignment = document.data.assignments[0];
	if (!principal || memberships.length === 0 || !task || !assignment)
		throw new Error("Missing source principal references");
	principal.id = "";
	for (const membership of memberships) membership.userId = "";
	task.fallbackUserId = "";
	assignment.userId = "";
	delete mappings.principals.bob;
	mappings.principals[""] = "bob";
	const saved = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	expect(saved.report).toMatchObject({ applySupported: true });
	const rows = await frozenItems(saved.id);
	const frozenTask = rows.find((row) => row.collection === "tasks");
	const frozenAssignment = rows.find((row) => row.collection === "assignments");
	expect(frozenTask?.dependency_proof?.fallback).toMatchObject({
		sourceUserId: "",
		targetUserId: "bob",
		membershipId: "target-bob",
	});
	expect(frozenAssignment?.dependency_proof?.assignee).toMatchObject({
		sourceUserId: "",
		targetUserId: "bob",
		membershipId: "target-bob",
	});
});

test("a task without assignments freezes its list-owner base recipient", async () => {
	document.data.assignments = [];
	const saved = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const task = (await frozenItems(saved.id)).find(
		(row) => row.collection === "tasks" && row.source_id === "source-task",
	);
	expect(task?.dependency_proof).toMatchObject({
		activation: {
			kind: "transition",
			readinessOrdinal: task?.ordinal,
			expectedRelationships: {
				count: 2,
				evidence: {
					assignees: [],
					ownerFallback: { userId: "alice", membershipId: "target-alice" },
					escalationFallback: { userId: "bob", membershipId: "target-bob" },
				},
			},
		},
	});
});

test("an active mapped task with a new link freezes the current-plus-source union", async () => {
	const first = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const taskId = await seedMappedTarget(first.id);
	await db
		.insert(tables.taskAssignee)
		.values({ id: `${taskId}:alice`, taskId, userId: "alice" });
	const oldEvidence = {
		version: 1,
		workspaceId: "target",
		assignees: [{ userId: "alice", membershipId: "target-alice" }],
		ownerFallback: null,
		escalationFallback: { userId: "bob", membershipId: "target-bob" },
	};
	const bytes = (
		await pool.query<{ bytes: number }>(
			"select octet_length($1::jsonb::text)::int as bytes",
			[JSON.stringify(oldEvidence)],
		)
	).rows[0]?.bytes;
	await pool.query(
		`insert into task_notification_activation (task_id, status, generation, import_occurrence_cutoff, recipient_generation_cutoff, completion_mode, owning_source_id, owning_owner_user_id, owning_job_id, expected_relationship_digest, expected_relationship_count, expected_relationship_bytes, expected_relationships) values ($1,'active',2,now(),now(),'import',$2,'alice',$3,$4,2,$5,$6::jsonb)`,
		[
			taskId,
			source.id,
			first.id,
			"a".repeat(64),
			bytes,
			JSON.stringify(oldEvidence),
		],
	);
	const next = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const rows = await frozenItems(next.id);
	const task = rows.find(
		(row) => row.collection === "tasks" && row.source_id === "source-task",
	);
	const assignment = rows.find((row) => row.collection === "assignments");
	expect(task?.dependency_proof).toMatchObject({
		activation: {
			kind: "transition",
			generation: 3,
			readinessOrdinal: assignment?.ordinal,
			precondition: {
				kind: "present",
				status: "active",
				generation: 2,
				owningSourceId: source.id,
				owningJobId: first.id,
				owningOwnerUserId: "alice",
				expectedRelationshipDigest: "a".repeat(64),
			},
			expectedRelationships: {
				count: 3,
				evidence: {
					assignees: [
						{ userId: "alice", membershipId: "target-alice" },
						{ userId: "bob", membershipId: "target-bob" },
					],
					ownerFallback: null,
					escalationFallback: { userId: "bob", membershipId: "target-bob" },
				},
			},
		},
	});
	expect(assignment?.dependency_proof).toMatchObject({
		taskActivationGeneration: 3,
	});
	await seedMappedAssignment(next.id, taskId);
	const observed = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const observedRows = await frozenItems(observed.id);
	const observedTask = observedRows.find(
		(row) => row.collection === "tasks" && row.source_id === "source-task",
	);
	expect(observedTask?.dependency_proof).toMatchObject({
		activation: {
			kind: "observe",
			generation: 2,
			readinessOrdinal: observedTask?.ordinal,
			precondition: { kind: "present", status: "active", generation: 2 },
		},
	});
	expect(
		observedRows.find((row) => row.collection === "assignments")
			?.dependency_proof,
	).toMatchObject({ taskActivationGeneration: 2 });
});

test("a mapped guardless task with no new links stays guardless", async () => {
	const first = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const taskId = await seedMappedTarget(first.id);
	await seedMappedAssignment(first.id, taskId);
	const saved = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const rows = await frozenItems(saved.id);
	expect(
		rows.find((row) => row.collection === "tasks")?.dependency_proof,
	).not.toHaveProperty("activation");
	expect(
		rows.find((row) => row.collection === "assignments")?.dependency_proof,
	).not.toHaveProperty("taskActivationGeneration");
});

test("a running pending generation cannot be adopted by a new plan", async () => {
	const first = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const taskId = await seedMappedTarget(first.id);
	await pool.query(
		`insert into task_notification_activation (task_id, status, generation, owning_source_id, owning_owner_user_id, owning_job_id) values ($1,'pending',1,$2,'alice',$3)`,
		[taskId, source.id, first.id],
	);
	await pool.query(
		`insert into import_run (job_id, owner_user_id, state) values ($1,'alice','running')`,
		[first.id],
	);
	const next = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const rows = await frozenItems(next.id);
	expect(
		rows.find(
			(row) => row.collection === "tasks" && row.source_id === "source-task",
		)?.disposition,
	).toBe("blocked");
	expect(
		rows.find((row) => row.collection === "assignments")?.disposition,
	).toBe("blocked");
	expect(next.report.findings).toContainEqual(
		expect.objectContaining({ code: "activation-running" }),
	);
});

test("a late intended assignment collision reverse-blocks a notification task", async () => {
	const first = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const projectedTaskId = (await frozenItems(first.id)).find(
		(row) => row.collection === "tasks",
	)?.target_id;
	if (!projectedTaskId) throw new Error("Missing projected task");
	await db.insert(tables.list).values({
		id: "other-list",
		workspaceId: "target",
		ownerId: "alice",
		title: "Other",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "other-task",
		listId: "other-list",
		title: "Other",
		sortKey: "a0",
	});
	await db.insert(tables.taskAssignee).values({
		id: `${projectedTaskId}:bob`,
		taskId: "other-task",
		userId: "alice",
	});
	const next = await saveImportPlan(
		runtime,
		"alice",
		source,
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	const rows = await frozenItems(next.id);
	expect(
		rows.find((row) => row.collection === "assignments")?.disposition,
	).toBe("blocked");
	expect(
		rows.find(
			(row) => row.collection === "tasks" && row.source_id === "source-task",
		)?.disposition,
	).toBe("blocked");
});
