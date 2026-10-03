import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ordinaryArchiveContent } from "../../src/domain/portability/import-document.ts";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { parsePortableExportV2 } from "../../src/domain/portability/validate-v2.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import {
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { importPlanRoutes } from "../../src/server/portability/import-routes.ts";
import { portabilityRoutes } from "../../src/server/portability/routes.ts";
import { taskHistoryRoutes } from "../../src/server/task-history.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({
	connectionString: databaseURL,
	application_name: "ditero-history-public-test",
});
const role = "ditero_history_public_test";
let archive: PortableExportV2;
let source: { mode: "new"; id: string; label: string };
let mappings: {
	workspaces: Record<string, string>;
	principals: Record<string, string | null>;
};
const guards = makeGuards(["http://localhost"], async (headers) =>
	headers.get("x-user")
		? ({ user: { id: headers.get("x-user") } } as Session)
		: null,
);
const app = new Elysia()
	.use(portabilityRoutes(runtime, guards))
	.use(importPlanRoutes(runtime, guards))
	.use(taskHistoryRoutes(runtime, guards));
function request(
	path: string,
	body?: unknown,
	actor = "hia-owner",
	method = body === undefined ? "GET" : "POST",
) {
	return app.handle(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				origin: "http://localhost",
				"x-user": actor,
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
async function save(actor = "hia-owner") {
	const response = await request(
		"/api/portability/import/plans",
		{ source, document: JSON.stringify(archive), mappings },
		actor,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as ImportPlanStatus;
}
const confirmation = (job: ImportPlanStatus) => ({
	planDigest: job.planDigest,
	counts: job.report.counts,
});
async function apply(job: ImportPlanStatus) {
	const response = await request(
		`/api/portability/import/plans/${job.id}/apply`,
		confirmation(job),
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as {
		state: string;
		nextOrdinal: number;
		appliedCount: number;
		noopCount: number;
	};
}
async function finish(job: ImportPlanStatus) {
	let run = await apply(job);
	for (let batch = 0; run.state === "running" && batch < 20; batch++)
		run = await apply(job);
	expect(run.state).toBe("completed");
	return run;
}
async function counts() {
	return (
		await admin.query(
			`select (select count(*) from import_history_ledger)::int as ledger, (select count(*) from imported_completion_event)::int as imported_events, (select count(*) from task_completion_event)::int as native_events, (select count(*) from karma_event)::int as karma_events, (select count(*) from karma)::int as karma, (select count(*) from notification_outbox)::int as notifications, (select count(*) from reminder_state)::int as reminders`,
		)
	).rows[0];
}
beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = '${role}') then
		 create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => {
		void client.query(`set role ${role}`);
	});
});
beforeEach(async () => {
	await admin.query("truncate import_history_ledger, import_history_redaction");
	await resetAuthFixture(admin);
	for (const id of ["hia-owner", "hia-author", "hia-viewer", "hia-outsider"])
		await admin.query(
			`insert into "user" (id,name,email,email_verified,created_at,updated_at)
			 values ($1,$1,$2,false,now(),now())`,
			[id, `${id}@example.test`],
		);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values
		 ('hia-source','Source','hia-owner','shared'),('hia-target','Target','hia-owner','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values
		 ('hia-source-seat','hia-owner','hia-source','owner'),
		 ('hia-target-seat','hia-owner','hia-target','owner'),
		 ('hia-author-seat','hia-author','hia-source','member'),
		 ('hia-viewer-seat','hia-viewer','hia-target','viewer')`,
	);
	await admin.query(
		`insert into list(id,workspace_id,owner_id,title,sort_key)
		 values ('hia-list','hia-source','hia-owner','Source list','a0')`,
	);
	await admin.query(
		`insert into task(id,list_id,title,sort_key)
		 values ('hia-task','hia-list','Original task','a0')`,
	);
	await admin.query(
		`insert into comment(id,task_id,author_id,body,created_at)
		 values ('hia-comment','hia-task','hia-author','Original comment','2020-01-02T03:04:05Z')`,
	);
	await admin.query(
		`insert into template(id,workspace_id,kind,name,content,created_by)
		 values ('hia-template','hia-source','task','Original template','{"kind":"task","task":{"title":"Reusable"}}','hia-author')`,
	);
	await admin.query(
		`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,
		 action,before_due_all_day,before_done,after_done)
		 values ($1,'hia-task','hia-author','member_mutation',
		 '2020-01-02T03:04:05Z','complete',false,false,true)`,
		[randomUUID()],
	);
	for (const kind of ["ntfy", "telegram", "discord", "slack", "email"])
		await admin.query(
			"insert into notification_channel(id,user_id,kind,config) values($1,'hia-owner',$2,$3)",
			[kind, kind, JSON.stringify({ marker: `SECRET-${kind}` })],
		);
	await admin.query(
		`insert into comment(id,task_id,author_id,body,created_at) select 'bulk-'||i,'hia-task','hia-author','Bulk '||i,'2020-01-02T03:04:05Z' from generate_series(1,105) i`,
	);
	await admin.query(
		`insert into template(id,workspace_id,kind,name,content,created_by) values ('hia-list-template','hia-source','list','Original list template','{"kind":"list","listKind":"tasks","tasks":[]}','hia-author')`,
	);
	for (const action of ["reopen", "skip"])
		await admin.query(
			`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,action,before_due_all_day,before_done,after_done,after_due_at) values($1,'hia-task','hia-author','capability_recipient','2020-01-02T03:04:05Z',$2,false,$3,$4,$5)`,
			[
				randomUUID(),
				action,
				action === "reopen",
				action === "skip",
				action === "skip" ? new Date("2020-01-03T03:04:05Z") : null,
			],
		);
	for (const action of ["habit_set", "habit_unlog"])
		await admin.query(
			`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,action,habit_date,before_habit_status,after_habit_status) values($1,'hia-task','hia-author','member_mutation','2020-01-02T03:04:05Z',$2,'2020-01-02','done',$3)`,
			[randomUUID(), action, action === "habit_set" ? "skipped" : null],
		);
	const namespace = randomUUID();
	for (const [index, kind] of [
		"source_claim",
		"unknown",
		"unknown",
	].entries()) {
		await admin.query(
			`insert into comment(id,task_id,body,created_at,source_namespace,source_row_id,historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at,provenance_redacted_at) values($1,'hia-task',$2,'2020-01-02T03:04:05Z',$3,$4,$5,$6,$7,$8,now(),$9)`,
			[
				`claim-${index}`,
				`Claim ${index}`,
				namespace,
				index === 0 ? "" : `old-comment-${index}`,
				kind,
				kind === "source_claim" ? namespace : null,
				kind === "source_claim" ? "hia-outsider" : null,
				kind === "source_claim" ? "Claimed author" : null,
				index === 2 ? new Date() : null,
			],
		);
		await admin.query(
			`insert into imported_completion_event(id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,actor_namespace,actor_principal_id,actor_name,origin_kind,origin_mechanism,origin_label,action,before_due_all_day,before_done,after_done,provenance_redacted_at) values($1,'hia-task',$2,$3,'2020-01-02T03:04:05Z',$4,$5,$6,$7,$4,$8,$9,'complete',false,false,true,$10)`,
			[
				randomUUID(),
				namespace,
				index === 0 ? "" : `old-event-${index}`,
				kind,
				kind === "source_claim" ? namespace : null,
				kind === "source_claim" ? "hia-outsider" : null,
				kind === "source_claim" ? "Claimed author" : null,
				kind === "source_claim" ? "capability_recipient" : null,
				kind === "source_claim" ? "Older app" : null,
				index === 2 ? new Date() : null,
			],
		);
	}
	for (const [index, kind] of ["task", "list"].entries()) {
		const claimed = index === 0;
		const content =
			kind === "task"
				? { kind: "task", task: { title: "Claimed reusable" } }
				: { kind: "list", listKind: "tasks", tasks: [] };
		await admin.query(
			`insert into template(id,workspace_id,kind,name,content,created_by,source_namespace,source_row_id,historical_creator_kind,historical_creator_namespace,historical_creator_principal_id,historical_creator_name,imported_at,provenance_redacted_at) values($1,'hia-source',$2,$3,$4,'hia-owner',$5,$6,$7,$8,$9,$10,now(),$11)`,
			[
				`claimed-template-${index}`,
				kind,
				`Claimed template ${index}`,
				JSON.stringify(content),
				namespace,
				claimed ? "" : "old-redacted-template",
				claimed ? "source_claim" : "unknown",
				claimed ? namespace : null,
				claimed ? "hia-outsider" : null,
				claimed ? "Claimed creator" : null,
				claimed ? null : new Date(),
			],
		);
	}
	const exported = await request("/api/portability/export?version=2");
	expect(exported.status, await exported.clone().text()).toBe(200);
	archive = parsePortableExportV2(await exported.text());
	mappings = {
		workspaces: Object.fromEntries(
			archive.data.workspaces.map((row) => [
				row.id,
				row.id === "hia-source" ? "hia-target" : row.id,
			]),
		),
		principals: Object.fromEntries(
			archive.data.principals.map((row) => [
				row.id,
				row.id === "hia-owner" ? row.id : null,
			]),
		),
	};
	source = { mode: "new", id: randomUUID(), label: "History source" };
});
afterAll(async () => {
	await runtime.end();
	await admin.end();
});

test("public v2 export/save/bounded apply/read/reexport/replay preserves claims without side effects", async () => {
	const before = await counts();
	const roleRow = (
		await runtime.query(
			"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
		)
	).rows[0];
	expect(roleRow).toEqual({ rolsuper: false, rolbypassrls: false });
	expect(archive.data.completionEvents.map((row) => row.action)).toEqual(
		expect.arrayContaining([
			"complete",
			"reopen",
			"skip",
			"habit_set",
			"habit_unlog",
		]),
	);
	expect(JSON.stringify(archive)).not.toContain("SECRET-");
	const job = await save();
	expect(job.report).toMatchObject({ plannerVersion: 5, applySupported: true });
	expect(await counts()).toEqual(before);
	expect((await save()).id).toBe(job.id);
	const first = await apply(job);
	expect(first).toMatchObject({ state: "running", nextOrdinal: 100 });
	const status = await request(`/api/portability/import/plans/${job.id}/run`);
	expect((await status.json()).run).toEqual(first);
	const run = await finish(job);
	expect(await apply(job)).toEqual(run);
	const after = await counts();
	expect(after).toEqual({
		...before,
		ledger:
			archive.data.comments.length +
			archive.data.templates.length +
			archive.data.completionEvents.length,
		imported_events:
			before.imported_events + archive.data.completionEvents.length,
	});
	const task = (await admin.query("select id from task where id<>'hia-task'"))
		.rows[0].id;
	expect(
		(await admin.query("select done,due_at from task where id=$1", [task]))
			.rows[0],
	).toEqual({
		done: archive.data.tasks[0].done,
		due_at:
			archive.data.tasks[0].dueAt === null
				? null
				: new Date(archive.data.tasks[0].dueAt),
	});
	const history = await request(
		`/api/tasks/history?taskId=${task}&workspaceId=hia-target`,
		undefined,
		"hia-viewer",
	);
	expect(history.status).toBe(200);
	expect((await history.json()).rows).toHaveLength(
		archive.data.completionEvents.length,
	);
	const comments = (
		await admin.query(
			"select author_id,historical_author_principal_id from comment where task_id=$1",
			[task],
		)
	).rows;
	expect(comments.every((row) => row.author_id === null)).toBe(true);
	expect(
		comments.some((row) => row.historical_author_principal_id === "hia-author"),
	).toBe(true);
	const exported = await request("/api/portability/export?version=2");
	const reexport = parsePortableExportV2(await exported.text());
	const copies = reexport.data.comments.filter((row) => row.taskId === task);
	expect(copies.map((row) => row.sourceRef)).toEqual(
		expect.arrayContaining(archive.data.comments.map((row) => row.sourceRef)),
	);
	expect(copies.find((row) => row.sourceRef.id === "")?.author).toEqual({
		kind: "source_claim",
		sourceNamespace: archive.data.comments.find(
			(row) => row.sourceRef.id === "",
		)?.sourceRef.namespace,
		sourcePrincipalId: "hia-outsider",
		displayName: "Claimed author",
	});
	expect(
		reexport.data.templates.filter(
			(row) =>
				row.workspaceId === "hia-target" && row.creator.kind === "source_claim",
		),
	).toHaveLength(3);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from membership where user_id='hia-outsider' and workspace_id='hia-target'",
			)
		).rows[0].count,
	).toBe(0);
});
test("existing preview stays immutable while public save creates a separate applicable digest", async () => {
	const preview = await saveImportPlan(
		runtime,
		"hia-owner",
		source,
		archive,
		mappings,
		{ plannerVersion: 4 },
	);
	const qualified = await save();
	expect(qualified.id).not.toBe(preview.id);
	const refused = await request(
		`/api/portability/import/plans/${preview.id}/apply`,
		confirmation(preview),
	);
	expect(refused.status).toBe(409);
	expect(await refused.json()).toEqual({ code: "import-apply-unsupported" });
	expect(
		(await request(`/api/portability/import/plans/${preview.id}`)).status,
	).toBe(200);
	expect(
		(
			await admin.query("select apply_supported from import_job where id=$1", [
				preview.id,
			])
		).rows[0].apply_supported,
	).toBe(false);
});
test("malformed graph and injected qualification flag persist no public plan", async () => {
	archive.data.comments[0].taskId = "missing-task";
	const invalid = await request("/api/portability/import/plans", {
		source,
		document: JSON.stringify(archive),
		mappings,
	});
	expect(invalid.status).toBe(400);
	const forged = await request("/api/portability/import/plans", {
		source,
		document: JSON.stringify(archive),
		mappings,
		historyApply: true,
	});
	expect(forged.status).toBe(400);
	expect(
		(await admin.query("select count(*)::int as count from import_job")).rows[0]
			.count,
	).toBe(0);
});
test("viewer cannot plan historical writes and nonowners cannot inspect or apply jobs", async () => {
	const job = await save();
	for (const actor of ["hia-viewer", "hia-outsider"]) {
		expect(
			(
				await request(
					`/api/portability/import/plans/${job.id}`,
					undefined,
					actor,
				)
			).status,
		).toBe(404);
		expect(
			(
				await request(
					`/api/portability/import/plans/${job.id}/apply`,
					confirmation(job),
					actor,
				)
			).status,
		).toBe(404);
	}
	mappings.principals["hia-owner"] = "hia-viewer";
	const denied = await request(
		"/api/portability/import/plans",
		{
			source: { ...source, id: randomUUID() },
			document: JSON.stringify(archive),
			mappings,
		},
		"hia-viewer",
	);
	expect(denied.status).toBe(403);
});
test("changed digest and confirmation counts refuse before the first write", async () => {
	const job = await save();
	for (const body of [
		{ ...confirmation(job), planDigest: "f".repeat(64) },
		{
			...confirmation(job),
			counts: { ...job.report.counts, ensure: job.report.counts.ensure + 1 },
		},
	]) {
		const response = await request(
			`/api/portability/import/plans/${job.id}/apply`,
			body,
		);
		expect(response.status).toBe(409);
	}
	expect((await counts()).ledger).toBe(0);
});
test("revocation after saving blocks all public historical writes", async () => {
	const job = await save();
	await admin.query("delete from membership where id='hia-target-seat'");
	const result = await request(
		`/api/portability/import/plans/${job.id}/apply`,
		confirmation(job),
	);
	expect(result.status).toBe(200);
	expect(await result.json()).toMatchObject({ state: "conflict" });
	expect((await counts()).ledger).toBe(0);
});
test("moving the imported parent between batches freezes a conflict without partial writes", async () => {
	const job = await save();
	await apply(job);
	const before = await counts();
	await admin.query("update task set list_id='hia-list' where id<>'hia-task'");
	const result = await apply(job);
	expect(result.state).toBe("conflict");
	expect(await counts()).toEqual(before);
});
test("mapped source cleanup is refused and administrative deletion retains template tombstones", async () => {
	const job = await save();
	await finish(job);
	const before = await counts();
	await admin.query("delete from template where workspace_id='hia-target'");
	expect(
		(
			await request(
				`/api/portability/import/sources/${source.id}/discard`,
				undefined,
				"hia-owner",
				"POST",
			)
		).status,
	).toBe(409);
	await admin.query("delete from import_source where id=$1", [source.id]);
	expect((await counts()).ledger).toBe(before.ledger);
	source = { ...source, id: randomUUID() };
	await finish(await save());
	expect(
		(
			await admin.query(
				"select count(*)::int as count from template where workspace_id='hia-target'",
			)
		).rows[0].count,
	).toBe(0);
});

test("public v1 plans retain planner 4 and ordinary apply semantics", async () => {
	const response = await request("/api/portability/import/plans", {
		source,
		document: JSON.stringify(ordinaryArchiveContent(archive)),
		mappings,
	});
	expect(response.status, await response.clone().text()).toBe(200);
	const job: ImportPlanStatus = await response.json();
	expect(job.report).toMatchObject({ plannerVersion: 4, applySupported: true });
	await finish(job);
	expect((await counts()).ledger).toBe(0);
});
test("deleted importing actor cannot use a saved public history job", async () => {
	const job = await save();
	await admin.query(`update "user" set deleted_at=now() where id='hia-owner'`);
	expect(
		(
			await request(
				`/api/portability/import/plans/${job.id}/apply`,
				confirmation(job),
			)
		).status,
	).toBe(403);
	expect((await counts()).ledger).toBe(0);
});
test("an existing import source cannot be rebound to another archive identity", async () => {
	await save();
	archive.sourceUserId = "hia-author";
	mappings.principals = Object.fromEntries(
		archive.data.principals.map((row) => [
			row.id,
			row.id === "hia-author" ? "hia-owner" : null,
		]),
	);
	const response = await request("/api/portability/import/plans", {
		source: { mode: "existing", id: source.id },
		document: JSON.stringify(archive),
		mappings,
	});
	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({ code: "source-binding-conflict" });
});
