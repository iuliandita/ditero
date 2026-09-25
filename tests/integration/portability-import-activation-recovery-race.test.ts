import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ImportMappings } from "../../src/domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import {
	finishTaskActivation,
	reviewTaskActivation,
} from "../../src/server/portability/import-activation-recovery.ts";
import { applyImportBatchV4Internal } from "../../src/server/portability/import-apply-store.ts";
import {
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const importer = new Pool({
	connectionString: databaseURL,
	application_name: "manual-race-importer",
});
const reviewer = new Pool({
	connectionString: databaseURL,
	application_name: "manual-race-reviewer",
});
const db = drizzle(admin, { schema: tables });
let job: ImportPlanStatus;
let targetTaskId: string;

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_recovery_race_test') then create role ditero_recovery_race_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_recovery_race_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_recovery_race_test",
	);
	for (const pool of [importer, reviewer])
		pool.on("connect", (client) => {
			void client.query("set role ditero_recovery_race_test");
		});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	const people = [
		"alice",
		"bob",
		...Array.from(
			{ length: 105 },
			(_, i) => `member-${String(i).padStart(3, "0")}`,
		),
	];
	await db
		.insert(tables.user)
		.values(
			people.map((id) => ({ id, name: id, email: `${id}@example.test` })),
		);
	await db.insert(tables.workspace).values([
		{ id: "source", name: "Source", ownerId: "alice", kind: "shared" },
		{ id: "target", name: "Target", ownerId: "alice", kind: "shared" },
	]);
	await db.insert(tables.membership).values(
		people.flatMap((id) => [
			{
				id: `source-${id}`,
				workspaceId: "source",
				userId: id,
				role: id === "alice" ? ("owner" as const) : ("member" as const),
			},
			{
				id: `target-${id}`,
				workspaceId: "target",
				userId: id,
				role: id === "alice" ? ("owner" as const) : ("member" as const),
			},
		]),
	);
	await db.insert(tables.list).values({
		id: "source-list",
		workspaceId: "source",
		ownerId: "alice",
		title: "Source",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "source-task",
		listId: "source-list",
		title: "Reminder",
		sortKey: "a0",
		dueAt: new Date("2026-09-20T10:00:00Z"),
		reminderTime: "09:00",
		fallbackUserId: "bob",
		urgent: true,
	});
	await db.insert(tables.taskAssignee).values(
		["bob", ...people.filter((id) => id.startsWith("member-"))].map((id) => ({
			id: `source-task:${id}`,
			taskId: "source-task",
			userId: id,
		})),
	);
	const document = JSON.parse(
		await exportPortableJson(admin, "alice"),
	) as PortableExportV1;
	const mappings: ImportMappings = {
		workspaces: { source: "target", target: "target" },
		principals: Object.fromEntries(people.map((id) => [id, id])),
	};
	const sourceId = randomUUID();
	job = await saveImportPlan(
		importer,
		"alice",
		{ mode: "new", id: sourceId, label: "Import" },
		document,
		mappings,
		{ plannerVersion: 4 },
	);
	for (let attempt = 0; attempt < 20; attempt++) {
		const status = await applyImportBatchV4Internal(importer, "alice", job.id, {
			planDigest: job.planDigest,
			counts: job.report.counts,
		});
		const mapped = (
			await admin.query<{ target_id: string }>(
				"select target_id from import_source_map where source_id=$1 and collection='tasks' and source_row_id='source-task'",
				[sourceId],
			)
		).rows[0];
		if (mapped) {
			targetTaskId = mapped.target_id;
			expect(status.state).toBe("running");
			break;
		}
	}
	if (!targetTaskId)
		throw new Error("Imported task did not reach pending state");
	expect(
		(
			await admin.query(
				"select status from task_notification_activation where task_id=$1",
				[targetTaskId],
			)
		).rows[0]?.status,
	).toBe("pending");
}, 30_000);

afterAll(async () => {
	await reviewer.end();
	await importer.end();
	await admin.end();
});

async function continueImport() {
	let result = await applyImportBatchV4Internal(importer, "alice", job.id, {
		planDigest: job.planDigest,
		counts: job.report.counts,
	});
	for (let attempt = 0; result.state === "running" && attempt < 20; attempt++)
		result = await applyImportBatchV4Internal(importer, "alice", job.id, {
			planDigest: job.planDigest,
			counts: job.report.counts,
		});
	return result;
}

async function waitForBlocked(applicationName: string, timeoutMs = 8_000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const row = (
			await admin.query<{ blocked: boolean }>(
				`select exists(select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock') as blocked`,
				[applicationName],
			)
		).rows[0];
		if (row?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${applicationName} did not block`);
}

test.each([
	"importer",
	"recovery",
] as const)("%s wins the task lock and the other operation respects the generation fence", async (first) => {
	const review = await reviewTaskActivation(reviewer, "bob", targetTaskId);
	const blocker = await admin.connect();
	let importPromise: ReturnType<typeof continueImport> | undefined;
	let recoveryPromise: ReturnType<typeof finishTaskActivation> | undefined;
	try {
		await blocker.query("begin");
		await blocker.query("select id from task where id=$1 for update", [
			targetTaskId,
		]);
		if (first === "importer") {
			importPromise = continueImport();
			await waitForBlocked("manual-race-importer");
			recoveryPromise = finishTaskActivation(
				reviewer,
				"bob",
				targetTaskId,
				review.reviewDigest,
			);
			await waitForBlocked("manual-race-reviewer");
		} else {
			recoveryPromise = finishTaskActivation(
				reviewer,
				"bob",
				targetTaskId,
				review.reviewDigest,
			);
			await waitForBlocked("manual-race-reviewer");
			importPromise = continueImport();
			await waitForBlocked("manual-race-importer");
		}
		await blocker.query("commit");
		const [imported, recovered] = await Promise.allSettled([
			importPromise,
			recoveryPromise,
		]);
		if (first === "importer") {
			expect(imported.status).toBe("fulfilled");
			if (imported.status === "fulfilled")
				expect(imported.value.state).toBe("completed");
			expect(recovered.status).toBe("rejected");
			if (recovered.status === "rejected")
				expect(recovered.reason).toMatchObject({ status: 409 });
		} else {
			expect(recovered).toMatchObject({
				status: "fulfilled",
				value: { code: "completed" },
			});
			expect(imported.status).toBe("fulfilled");
			if (imported.status === "fulfilled")
				expect(imported.value.state).toBe("conflict");
		}
	} finally {
		await blocker.query("rollback");
		blocker.release();
	}
}, 30_000);
