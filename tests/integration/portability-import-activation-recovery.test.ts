import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	digestImportExpectedRelationships,
	type ImportRelationshipEvidence,
} from "../../src/domain/portability/import-apply-plan.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import {
	finishTaskActivation,
	reviewTaskActivation,
} from "../../src/server/portability/import-activation-recovery.ts";
import { importActivationRoutes } from "../../src/server/portability/import-activation-routes.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const oldDue = new Date("2026-09-20T10:00:00.000Z");
const evidence: ImportRelationshipEvidence = {
	version: 1,
	workspaceId: "space",
	assignees: [{ userId: "member", membershipId: "seat-member" }],
	ownerFallback: null,
	escalationFallback: null,
};

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_recovery_test') then create role ditero_recovery_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query("grant usage on schema public to ditero_recovery_test");
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_recovery_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_recovery_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	for (const id of ["owner", "member", "viewer", "foreign"]) {
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
	] as const)
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,'space',$3)",
			[`seat-${id}`, id, role],
		);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ('list','space','owner','Shared list','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,due_at) values ('task','list','Imported task','a0',$1)",
		[oldDue],
	);
	await admin.query(
		"insert into task_assignee (id,task_id,user_id) values ('pair','task','member')",
	);
	const digest = await digestImportExpectedRelationships(evidence, () => {});
	const bytes = (
		await admin.query<{ bytes: number }>(
			"select octet_length($1::jsonb::text)::int as bytes",
			[JSON.stringify(evidence)],
		)
	).rows[0]?.bytes;
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,expected_relationship_digest,expected_relationship_count,
		expected_relationship_bytes,expected_relationships)
		values ('task','pending',1,$1,1,$2,$3::jsonb)`,
		[digest, bytes, JSON.stringify(evidence)],
	);
});

afterAll(async () => {
	await runtime.end();
	await admin.end();
});

test("a live member reviews and finishes one task, then retries the same digest", async () => {
	const review = await reviewTaskActivation(runtime, "member", "task");
	expect(review.status).toBe("pending");
	expect(review.counts).toMatchObject({ currentAssignees: 1, missingLinks: 0 });
	expect(review.owningRun).toBe("none");
	expect(review.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: "current-assignee", name: "member" }),
		]),
	);
	const completed = await finishTaskActivation(
		runtime,
		"member",
		"task",
		review.reviewDigest,
	);
	expect(completed).toEqual({ code: "completed", generation: 2 });
	expect(
		await finishTaskActivation(runtime, "member", "task", review.reviewDigest),
	).toEqual({ code: "already-completed", generation: 2 });
	const guard = (
		await admin.query(
			"select status,generation,completion_mode,manual_review_digest,import_occurrence_cutoff from task_notification_activation where task_id='task'",
		)
	).rows[0];
	expect(guard).toMatchObject({
		status: "active",
		generation: 2,
		completion_mode: "manual",
		manual_review_digest: review.reviewDigest,
	});
	expect(guard.import_occurrence_cutoff).toBeInstanceOf(Date);
	const recipients = (
		await admin.query(
			"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='task'",
		)
	).rows;
	expect(recipients).toEqual([
		expect.objectContaining({
			user_id: "member",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: oldDue,
		}),
	]);
});

test("viewer and foreign users cannot review or finish", async () => {
	for (const id of ["viewer", "foreign"]) {
		await expect(
			reviewTaskActivation(runtime, id, "task"),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			finishTaskActivation(runtime, id, "task", "a".repeat(64)),
		).rejects.toMatchObject({ status: 404 });
	}
});

test("changed pairs make the prior review stale; missing expected links remain missing", async () => {
	const first = await reviewTaskActivation(runtime, "owner", "task");
	await admin.query("delete from task_assignee where id='pair'");
	await expect(
		finishTaskActivation(runtime, "owner", "task", first.reviewDigest),
	).rejects.toMatchObject({ code: "activation-review-stale", status: 409 });
	const review = await reviewTaskActivation(runtime, "owner", "task");
	expect(review.counts.missingLinks).toBe(1);
	expect(review.missingLinksRemainMissing).toBe(true);
	await finishTaskActivation(runtime, "owner", "task", review.reviewDigest);
	expect(
		(await admin.query("select count(*)::int as count from task_assignee"))
			.rows[0]?.count,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select user_id from task_notification_recipient where active",
			)
		).rows,
	).toEqual([{ user_id: "owner" }]);
});

test("owning run is projected under its owner without granting the current writer ledger access", async () => {
	await admin.query(
		"insert into import_source (id,owner_user_id,label,format,schema_version,source_user_id) values ('source','owner','Source','ditero-json',1,'owner')",
	);
	await admin.query(
		`insert into import_job
		(id,source_id,owner_user_id,document_digest,mapping_digest,plan_digest,report,payload_bytes)
		values ('job','source','owner',$1,$1,$1,'{}'::jsonb,0)`,
		["a".repeat(64)],
	);
	await admin.query(
		"insert into import_run (job_id,owner_user_id,state) values ('job','owner','running')",
	);
	await admin.query(
		"update task_notification_activation set owning_source_id='source',owning_owner_user_id='owner',owning_job_id='job' where task_id='task'",
	);
	const review = await reviewTaskActivation(runtime, "member", "task");
	expect(review.owningRun).toBe("unfinished");
	await finishTaskActivation(runtime, "member", "task", review.reviewDigest);
	expect(
		(await admin.query("select state from import_run where job_id='job'")).rows,
	).toEqual([{ state: "running" }]);
});

test("deleted source and job remain recoverable with an unavailable ledger state", async () => {
	await admin.query(
		"update task_notification_activation set owning_source_id='gone',owning_owner_user_id='owner',owning_job_id='gone' where task_id='task'",
	);
	const review = await reviewTaskActivation(runtime, "member", "task");
	expect(review.owningRun).toBe("unavailable");
	await finishTaskActivation(runtime, "member", "task", review.reviewDigest);
	expect(
		(
			await admin.query(
				"select status,completion_mode from task_notification_activation where task_id='task'",
			)
		).rows,
	).toEqual([{ status: "active", completion_mode: "manual" }]);
});

test("a deleted original importer does not block a current writer's recovery", async () => {
	await admin.query("update workspace set owner_id='member' where id='space'");
	await admin.query("update list set owner_id='member' where id='list'");
	await admin.query("delete from membership where id='seat-owner'");
	await admin.query("update \"user\" set deleted_at=now() where id='owner'");
	await admin.query(
		"update task_notification_activation set owning_source_id='gone',owning_owner_user_id='owner',owning_job_id='gone' where task_id='task'",
	);
	const review = await reviewTaskActivation(runtime, "member", "task");
	expect(review.owningRun).toBe("unavailable");
	expect(review.counts.currentAssignees).toBe(1);
	expect(
		await finishTaskActivation(runtime, "member", "task", review.reviewDigest),
	).toEqual({ code: "completed", generation: 2 });
});

test("a former importer with no membership still has a truthful unfinished-run indicator", async () => {
	await admin.query(
		"insert into import_source (id,owner_user_id,label,format,schema_version,source_user_id) values ('source','owner','Source','ditero-json',1,'owner')",
	);
	await admin.query(
		`insert into import_job
		(id,source_id,owner_user_id,document_digest,mapping_digest,plan_digest,report,payload_bytes)
		values ('job','source','owner',$1,$1,$1,'{}'::jsonb,0)`,
		["a".repeat(64)],
	);
	await admin.query(
		"insert into import_run (job_id,owner_user_id,state) values ('job','owner','running')",
	);
	await admin.query("update workspace set owner_id='member' where id='space'");
	await admin.query("update list set owner_id='member' where id='list'");
	await admin.query("delete from membership where id='seat-owner'");
	await admin.query(
		"update task_notification_activation set owning_source_id='source',owning_owner_user_id='owner',owning_job_id='job' where task_id='task'",
	);
	const review = await reviewTaskActivation(runtime, "member", "task");
	expect(review.owningRun).toBe("unfinished");
	expect(
		await finishTaskActivation(runtime, "member", "task", review.reviewDigest),
	).toEqual({ code: "completed", generation: 2 });
	expect(
		(await admin.query("select state from import_run where job_id='job'")).rows,
	).toEqual([{ state: "running" }]);
});

test("large review pages share one full-evidence digest", async () => {
	await admin.query(
		`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		select 'person-'||n,'Person '||n,'person-'||n||'@example.test',false,now(),now()
		from generate_series(1,105) n`,
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role)
		select 'seat-person-'||n,'person-'||n,'space','member'
		from generate_series(1,105) n`,
	);
	await admin.query(
		`insert into task_assignee (id,task_id,user_id)
		select 'pair-person-'||n,'task','person-'||n
		from generate_series(1,105) n`,
	);
	const first = await reviewTaskActivation(runtime, "member", "task", 0);
	const second = await reviewTaskActivation(runtime, "member", "task", 1);
	expect(first.reviewDigest).toBe(second.reviewDigest);
	expect(first.totalItems).toBe(107);
	expect(first.items).toHaveLength(100);
	expect(second.items).toHaveLength(7);
	expect(first.counts.currentAssignees).toBe(106);
});

test("routes require a session, same origin, explicit confirmation, and a current review", async () => {
	const guards = makeGuards(["http://localhost"], async (headers) => {
		const id = headers.get("x-test-user");
		return id ? ({ user: { id } } as Session) : null;
	});
	const app = importActivationRoutes(runtime, guards);
	const url = "http://localhost/api/portability/import/tasks/task";
	const unauthorized = await app.handle(
		new Request(`${url}/activation-review`),
	);
	expect(unauthorized.status).toBe(401);
	const foreign = await app.handle(
		new Request(`${url}/activation-review`, {
			headers: { "x-test-user": "member", origin: "http://foreign.test" },
		}),
	);
	expect(foreign.status).toBe(403);
	const reviewResponse = await app.handle(
		new Request(`${url}/activation-review`, {
			headers: { "x-test-user": "member" },
		}),
	);
	expect(reviewResponse.status).toBe(200);
	const review = await reviewResponse.json();
	const wrongOrigin = await app.handle(
		new Request(`${url}/finish`, {
			method: "POST",
			headers: {
				"x-test-user": "member",
				origin: "http://foreign.test",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				reviewDigest: review.reviewDigest,
				confirm: true,
			}),
		}),
	);
	expect(wrongOrigin.status).toBe(403);
	const noConfirm = await app.handle(
		new Request(`${url}/finish`, {
			method: "POST",
			headers: {
				"x-test-user": "member",
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({ reviewDigest: review.reviewDigest }),
		}),
	);
	expect(noConfirm.status).toBe(400);
	await admin.query("delete from task_assignee where id='pair'");
	const stale = await app.handle(
		new Request(`${url}/finish`, {
			method: "POST",
			headers: {
				"x-test-user": "member",
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				reviewDigest: review.reviewDigest,
				confirm: true,
			}),
		}),
	);
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ code: "activation-review-stale" });
	const freshResponse = await app.handle(
		new Request(`${url}/activation-review`, {
			headers: { "x-test-user": "member" },
		}),
	);
	expect(freshResponse.status).toBe(200);
	const fresh = await freshResponse.json();
	const finish = await app.handle(
		new Request(`${url}/finish`, {
			method: "POST",
			headers: {
				"x-test-user": "member",
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				reviewDigest: fresh.reviewDigest,
				confirm: true,
			}),
		}),
	);
	expect(finish.status, await finish.clone().text()).toBe(200);
});
