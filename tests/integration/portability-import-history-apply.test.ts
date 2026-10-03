import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import type { HistoryPreviewItem } from "../../src/domain/portability/import-apply-plan-v2.ts";
import { projectHistoricalRow } from "../../src/domain/portability/import-history-row.ts";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { parsePortableExportV2 } from "../../src/domain/portability/validate-v2.ts";
import { accountDeletionRoutes } from "../../src/server/account-deletion.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import { exportPortableJsonV2 } from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import {
	discardImportSource,
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({
	connectionString: databaseURL,
	application_name: "ditero-history-apply-test",
});
const role = "ditero_history_apply_test";
const runtimeClients = new Set<PoolClient>();
let archive: PortableExportV2;
let source: { mode: "new"; id: string; label: string };
let mappings: {
	workspaces: Record<string, string>;
	principals: Record<string, string | null>;
};
const confirmation = (job: ImportPlanStatus) => ({
	planDigest: job.planDigest,
	counts: job.report.counts,
});
const save = (historyApply = true) =>
	saveImportPlan(runtime, "hia-owner", source, archive, mappings, {
		plannerVersion: 4,
		historyApply,
	});
const apply = (job: ImportPlanStatus) =>
	applyImportBatch(runtime, "hia-owner", job.id, confirmation(job));
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
			`select (select count(*) from import_history_ledger)::int as ledger,
			 (select count(*) from imported_completion_event)::int as imported_events,
			 (select count(*) from task_completion_event)::int as native_events,
			 (select count(*) from karma_event)::int as karma_events,
			 (select count(*) from karma)::int as karma,
			 (select count(*) from notification_outbox)::int as notifications,
			 (select count(*) from reminder_state)::int as reminders`,
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
		runtimeClients.add(client);
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
	archive = parsePortableExportV2(
		await exportPortableJsonV2(admin, "hia-owner"),
	);
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

test("actual restricted role applies claims and ledger together without history side effects", async () => {
	const before = await counts();
	const job = await save();
	expect(job.report).toMatchObject({ plannerVersion: 5, applySupported: true });
	const run = await finish(job);
	expect(run.appliedCount).toBeGreaterThanOrEqual(5);
	expect(await counts()).toEqual({
		...before,
		ledger: 3,
		imported_events: 1,
	});
	const comment = await admin.query(
		"select author_id,historical_author_principal_id,historical_author_name,created_at from comment where source_namespace is not null",
	);
	expect(comment.rows).toEqual([
		{
			author_id: null,
			historical_author_principal_id: "hia-author",
			historical_author_name: "hia-author",
			created_at: new Date("2020-01-02T03:04:05.000Z"),
		},
	]);
	const template = await admin.query(
		"select created_by,historical_creator_principal_id from template where source_namespace is not null",
	);
	expect(template.rows).toEqual([
		{ created_by: "hia-owner", historical_creator_principal_id: "hia-author" },
	]);
	expect(await apply(job)).toEqual(run);
	expect(await counts()).toEqual({ ...before, ledger: 3, imported_events: 1 });
});

test("immutable preview jobs stay non-applicable after the apply migration", async () => {
	const preview = await save(false);
	const qualified = await save(true);
	expect(qualified.id).not.toBe(preview.id);
	await expect(apply(preview)).rejects.toMatchObject({
		code: "import-apply-unsupported",
	});
	await finish(qualified);
});

async function templateItem(job: ImportPlanStatus) {
	return (
		await admin.query<HistoryPreviewItem>(
			`select ordinal,collection,source_id as "sourceId",source_key as "sourceKey",item_digest as "itemDigest",
			 content_digest as "contentDigest",target_id as "targetId",disposition,payload,codes,phase,
			 target_precondition as "targetPrecondition",dependency_proof as "dependencyProof"
			 from import_item where job_id=$1 and collection='templates' and disposition='ensure'`,
			[job.id],
		)
	).rows[0];
}
async function direct(
	job: ImportPlanStatus,
	item: HistoryPreviewItem,
	ordinal = item.ordinal,
) {
	const client = await runtime.connect();
	await client.query("begin");
	await client.query("select set_config('ditero.user_id','hia-owner',true)");
	await client.query(
		"insert into import_run(job_id,owner_user_id,next_ordinal) values ($1,'hia-owner',$2)",
		[job.id, ordinal],
	);
	await client.query(
		"select set_config('ditero.history_job',$1,true),set_config('ditero.history_ordinal',$2,true)",
		[job.id, String(item.ordinal)],
	);
	return client;
}
async function insertRow(
	client: PoolClient,
	item: HistoryPreviewItem,
	changes: Record<string, unknown> = {},
) {
	const time = (
		await client.query<{ at: Date }>(
			"select date_trunc('milliseconds',transaction_timestamp()) as at",
		)
	).rows[0].at;
	const value = await projectHistoricalRow(
		item,
		"hia-owner",
		time.toISOString(),
	);
	const row = { ...value.row, ...changes };
	const fields = Object.keys(row);
	return client.query(
		`insert into "${value.table}" (${fields.map((field) => `"${field}"`).join(",")})
		 values (${fields.map((_, index) => `$${index + 1}`).join(",")})`,
		Object.values(row),
	);
}
async function rollback(client: PoolClient) {
	await client.query("rollback");
	client.release();
}
test("exact saved historical item succeeds directly under the restricted role", async () => {
	const job = await save();
	const item = await templateItem(job);
	const client = await direct(job, item);
	try {
		expect((await insertRow(client, item)).rowCount).toBe(1);
	} finally {
		await rollback(client);
	}
});
test.each([
	"payload",
	"native-author",
	"job",
	"ordinal",
	"stale-cursor",
	"guc-only",
	"wrong-actor",
	"replacement-seat",
])("database proof refuses %s without granting historical writes", async (kind) => {
	const job = await save();
	const item = await templateItem(job);
	const cursor =
		kind === "ordinal"
			? item.ordinal - 1
			: kind === "stale-cursor"
				? item.ordinal + 1
				: item.ordinal;
	if (kind === "replacement-seat") {
		await admin.query("delete from membership where id='hia-target-seat'");
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values ('hia-replacement-seat','hia-owner','hia-target','owner')",
		);
	}
	const client = await direct(job, item, cursor);
	try {
		if (kind === "wrong-actor")
			await client.query(
				"select set_config('ditero.user_id','hia-outsider',true)",
			);
		if (kind === "job" || kind === "guc-only")
			await client.query("select set_config('ditero.history_job',$1,true)", [
				kind === "job" ? randomUUID() : "",
			]);
		await expect(
			insertRow(
				client,
				item,
				kind === "payload"
					? { name: "Altered" }
					: kind === "native-author"
						? { historical_creator_kind: "native_user" }
						: {},
			),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(0);
});

test("source deletion retains replay identity and deleted historical targets remain tombstones", async () => {
	const job = await save();
	await finish(job);
	await admin.query("delete from comment where source_namespace is not null");
	await expect(
		discardImportSource(runtime, "hia-owner", source.id),
	).rejects.toMatchObject({ code: "import-source-retained" });
	await admin.query("delete from import_source where id = $1", [source.id]);
	expect((await counts()).ledger).toBe(3);
	// Templates keep the destination workspace identity while task copies use a new explicit parent.
	source = { ...source, id: randomUUID() };
	const copied = await save();
	await finish(copied);
	expect((await counts()).ledger).toBe(5);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from template where source_namespace is not null",
			)
		).rows[0].n,
	).toBe(1);
});

test("more than one hundred items resume at the committed cursor and never duplicate historical records", async () => {
	const original = archive.data.comments[0];
	archive.data.comments = Array.from({ length: 125 }, (_, index) => ({
		...original,
		id: `archive-comment-${index}`,
		sourceRef: { ...original.sourceRef, id: `raw-comment-${index}` },
	}));
	const job = await save();
	const first = await apply(job);
	expect(first).toMatchObject({ state: "running", nextOrdinal: 100 });
	const stored = (
		await admin.query(
			"select count(*)::int as n from import_item where job_id=$1",
			[job.id],
		)
	).rows[0].n;
	const run = await finish(job);
	expect(run.nextOrdinal).toBe(stored);
	expect((await counts()).ledger).toBe(127);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from comment where source_namespace is not null",
			)
		).rows[0].n,
	).toBe(125);
	expect(await apply(job)).toEqual(run);
});

test("same-parent replay keeps deleted targets absent and does not restore redacted attribution", async () => {
	await finish(await save());
	const ledger = (
		await admin.query(
			"select content_digest from import_history_ledger order by id",
		)
	).rows;
	await admin.query("delete from comment where source_namespace is not null");
	await admin.query(`update template set historical_creator_kind='unknown',historical_creator_namespace=null,
	 historical_creator_principal_id=null,historical_creator_name=null,provenance_redacted_at=now()
	 where source_namespace is not null`);
	const replay = await save();
	const run = await finish(replay);
	expect(run.noopCount).toBeGreaterThanOrEqual(3);
	expect((await counts()).ledger).toBe(3);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from comment where source_namespace is not null",
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select historical_creator_kind,historical_creator_name,provenance_redacted_at from template where source_namespace is not null",
			)
		).rows[0],
	).toMatchObject({
		historical_creator_kind: "unknown",
		historical_creator_name: null,
		provenance_redacted_at: expect.any(Date),
	});
	expect(
		(
			await admin.query(
				"select content_digest from import_history_ledger order by id",
			)
		).rows,
	).toEqual(ledger);
	const exported = parsePortableExportV2(
		await exportPortableJsonV2(admin, "hia-owner"),
	);
	expect(
		exported.data.templates.find((row) => row.id !== "hia-template")?.creator,
	).toEqual({ kind: "unknown" });
	await expect(
		admin.query(
			"update template set provenance_redacted_at=null where source_namespace is not null",
		),
	).rejects.toMatchObject({ code: "23514" });
});

test("empty source IDs survive apply and reexport without becoming archive-local IDs", async () => {
	archive.data.comments[0].sourceRef.id = "";
	await finish(await save());
	expect(
		(
			await admin.query(
				"select source_row_id from import_history_ledger where collection='comments'",
			)
		).rows,
	).toEqual([{ source_row_id: "" }]);
	const exported = parsePortableExportV2(
		await exportPortableJsonV2(admin, "hia-owner"),
	);
	const copied = exported.data.comments.find(
		(row) => row.author.kind === "source_claim",
	);
	expect(copied?.sourceRef).toEqual(archive.data.comments[0].sourceRef);
	expect(copied?.id).not.toBe(archive.data.comments[0].id);
});

test("concurrent accounts create separate task copies and replay one shared workspace template", async () => {
	await admin.query(`insert into "user"(id,name,email,email_verified,created_at,updated_at)
	 values ('hia-writer','Writer','hia-writer@example.test',false,now(),now())`);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('hia-writer-seat','hia-writer','hia-target','member')",
	);
	const first = await save();
	const secondMappings = {
		...mappings,
		principals: { ...mappings.principals, "hia-owner": "hia-writer" },
	};
	const second = await saveImportPlan(
		runtime,
		"hia-writer",
		{ ...source, id: randomUUID() },
		archive,
		secondMappings,
		{ plannerVersion: 4, historyApply: true },
	);
	const runs = await Promise.all([
		apply(first),
		applyImportBatch(runtime, "hia-writer", second.id, confirmation(second)),
	]);
	expect(runs.map((run) => run.state)).toEqual(["completed", "completed"]);
	expect(runs.reduce((n, run) => n + run.noopCount, 0)).toBe(1);
	expect((await counts()).ledger).toBe(5);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from template where source_namespace is not null",
			)
		).rows[0].n,
	).toBe(1);
});

test("deleted source authors remain claims while a deleted importing actor is refused", async () => {
	const job = await save();
	await admin.query(
		"update \"user\" set deleted_at=now() where id='hia-author'",
	);
	await finish(job);
	expect(
		(
			await admin.query(
				"select historical_author_principal_id from comment where source_namespace is not null",
			)
		).rows[0],
	).toEqual({ historical_author_principal_id: "hia-author" });
	const next = await save();
	await admin.query(
		"update \"user\" set deleted_at=now() where id='hia-owner'",
	);
	await expect(apply(next)).rejects.toMatchObject({ status: 403 });
	expect((await counts()).ledger).toBe(3);
});

test("database proof rejects a revoked write role before inserting the exact item", async () => {
	const job = await save();
	const item = await templateItem(job);
	await admin.query(
		"update membership set role='viewer' where id='hia-target-seat'",
	);
	const client = await direct(job, item);
	try {
		await expect(insertRow(client, item)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(0);
});

async function insertLedger(
	client: PoolClient,
	item: HistoryPreviewItem,
	changes: Record<string, unknown> = {},
) {
	const tuple = item.dependencyProof?.ledger;
	if (!tuple) throw new Error("Missing historical ledger fixture");
	const row = {
		id: "e".repeat(64),
		collection: tuple.collection,
		target_parent_id: tuple.targetParentId,
		source_namespace: tuple.sourceNamespace,
		source_row_id: tuple.sourceId,
		source_row_id_sha256: tuple.sourceIdHash,
		target_id: item.targetId,
		content_digest: item.contentDigest,
		...changes,
	};
	const fields = Object.keys(row);
	return client.query(
		`insert into import_history_ledger (${fields.map((field) => `"${field}"`).join(",")})
	 values (${fields.map((_, index) => `$${index + 1}`).join(",")})`,
		Object.values(row),
	);
}
test("ledger insertion requires exact content and a forged ledger rolls the preceding content back", async () => {
	const job = await save();
	const item = await templateItem(job);
	let client = await direct(job, item);
	try {
		await expect(insertLedger(client, item)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await rollback(client);
	}
	client = await direct(job, item);
	try {
		await insertRow(client, item);
		await expect(
			insertLedger(client, item, { content_digest: "f".repeat(64) }),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from template where source_namespace is not null",
			)
		).rows[0].n,
	).toBe(0);
	client = await direct(job, item);
	try {
		await insertRow(client, item);
		expect((await insertLedger(client, item)).rowCount).toBe(1);
		expect(
			(await client.query("select id from import_history_ledger")).rowCount,
		).toBe(1);
		expect(
			(
				await client.query(
					"update import_history_ledger set content_digest=$1",
					["f".repeat(64)],
				)
			).rowCount,
		).toBe(0);
	} finally {
		await rollback(client);
	}
});

test("historical content cannot commit without its ledger and the exact pair can commit", async () => {
	const job = await save();
	const item = await templateItem(job);
	let client = await direct(job, item);
	try {
		await insertRow(client, item);
		await expect(client.query("commit")).rejects.toMatchObject({
			code: "23514",
		});
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(0);
	expect(
		(
			await admin.query(
				"select id from template where source_namespace is not null",
			)
		).rowCount,
	).toBe(0);
	client = await direct(job, item);
	try {
		await insertRow(client, item);
		await insertLedger(client, item);
		await client.query("commit");
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(1);
	expect(
		(
			await admin.query(
				"select id from template where source_namespace is not null",
			)
		).rowCount,
	).toBe(1);
});

test("an old create proof and a new tombstone proof cannot resurrect a mapped target", async () => {
	const original = await save();
	const originalItem = await templateItem(original);
	await finish(original);
	await admin.query("delete from template where source_namespace is not null");
	await admin.query("delete from import_run where job_id=$1", [original.id]);
	let client = await direct(original, originalItem);
	try {
		await expect(insertRow(client, originalItem)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await rollback(client);
	}
	const replay = await save();
	const replayItem = await templateItem(replay);
	expect(replayItem.targetPrecondition?.kind).toBe("mapped");
	client = await direct(replay, replayItem);
	try {
		await expect(insertRow(client, replayItem)).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await rollback(client);
	}
	expect((await counts()).ledger).toBe(3);
	expect(
		(
			await admin.query(
				"select id from template where source_namespace is not null",
			)
		).rowCount,
	).toBe(0);
});

test("version five preserves assignment and suppressed notification activation while appending historical events", async () => {
	await admin.query(
		"update task set due_at='2020-01-03T10:00:00Z', reminder_time='09:00', fallback_user_id='hia-owner',urgent=true where id='hia-task'",
	);
	await admin.query(
		"insert into task_assignee(id,task_id,user_id) values ('hia-assignment','hia-task','hia-owner')",
	);
	archive = parsePortableExportV2(
		await exportPortableJsonV2(admin, "hia-owner"),
	);
	await finish(await save());
	const copied = (
		await admin.query(
			"select target_id from import_source_map where source_id=$1 and collection='tasks'",
			[source.id],
		)
	).rows[0].target_id;
	expect(
		(
			await admin.query("select user_id from task_assignee where task_id=$1", [
				copied,
			])
		).rows,
	).toEqual([{ user_id: "hia-owner" }]);
	const activation = (
		await admin.query(
			"select status,import_occurrence_cutoff from task_notification_activation where task_id=$1",
			[copied],
		)
	).rows;
	expect(activation).toEqual([
		{ status: "active", import_occurrence_cutoff: expect.any(Date) },
	]);
	const recipient = (
		await admin.query(
			"select active,overdue_suppressed_due_at from task_notification_recipient where task_id=$1 and user_id='hia-owner'",
			[copied],
		)
	).rows;
	expect(recipient).toEqual([
		{
			active: true,
			overdue_suppressed_due_at: new Date("2020-01-03T10:00:00Z"),
		},
	]);
	expect((await counts()).notifications).toBe(0);
	expect((await counts()).karma_events).toBe(0);
	expect((await counts()).imported_events).toBe(1);
});

test("qualification runs as a real non-superuser role without RLS bypass", async () => {
	const result = await runtime.query(
		"select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(result.rows).toEqual([
		{ current_user: role, rolsuper: false, rolbypassrls: false },
	]);
});

test("account deletion keeps shared history and replay identity accessible to the remaining owner", async () => {
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values ('hia-other-source-owner','hia-viewer','hia-source','owner')",
	);
	await admin.query(
		"update membership set role='owner' where id='hia-viewer-seat'",
	);
	await finish(await save());
	const guards: Guards = {
		foreignOrigin: () => false,
		guardedPost:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: "hia-owner" } } as Session),
		guardedGet:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: "hia-owner" } } as Session),
	};
	const app = new Elysia().use(accountDeletionRoutes(runtime, guards));
	const response = await app.handle(
		new Request("http://localhost/api/account/delete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ acknowledgeKeyLoss: true }),
		}),
	);
	expect(response.status).toBe(200);
	expect(
		(
			await admin.query(
				"select id from import_source where owner_user_id='hia-owner'",
			)
		).rowCount,
	).toBe(0);
	expect((await counts()).ledger).toBe(3);
	const exported = parsePortableExportV2(
		await exportPortableJsonV2(runtime, "hia-viewer"),
	);
	expect(
		exported.data.comments.find((row) => row.author.kind === "source_claim")
			?.author,
	).toMatchObject({ kind: "source_claim", sourcePrincipalId: "hia-author" });
	expect(
		exported.data.templates.find((row) => row.creator.kind === "source_claim")
			?.creator,
	).toMatchObject({ kind: "source_claim", sourcePrincipalId: "hia-author" });
});

test("connection loss between content and ledger rolls back the entire batch and permits retry", async () => {
	const job = await save();
	const blocker = await admin.connect();
	const blockerPid = (
		await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
	).rows[0].pid;
	await blocker.query("begin");
	await blocker.query("select pg_advisory_xact_lock(510,1)");
	await admin.query(`create function hia_pause_ledger() returns trigger language plpgsql as $$
	 begin perform pg_advisory_xact_lock(510,1); return NEW; end $$`);
	await admin.query(
		"create trigger zz_hia_pause_ledger before insert on import_history_ledger for each row execute function hia_pause_ledger()",
	);
	const pending = apply(job).then(
		(run) => ({ run }),
		(error: unknown) => ({ error }),
	);
	let backend: number | undefined;
	const connectionErrors: Error[] = [];
	const onConnectionError = (error: Error) => connectionErrors.push(error);
	try {
		const deadline = performance.now() + 5000;
		while (performance.now() < deadline && !backend) {
			const rows = await admin.query<{ pid: number }>(
				`select pid from pg_stat_activity
			 where datname=current_database() and application_name='ditero-history-apply-test'
			 and pid<>pg_backend_pid() and query like 'insert into import_history_ledger%'
			 and $1=any(pg_blocking_pids(pid))`,
				[blockerPid],
			);
			backend = rows.rows[0]?.pid;
			if (!backend) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(backend).toBeTypeOf("number");
		if (backend === undefined)
			throw new Error("Missing blocked import backend");
		for (const client of runtimeClients)
			client.once("error", onConnectionError);
		const killed = await admin.query(
			"select pg_terminate_backend($1) as killed",
			[backend],
		);
		expect(killed.rows[0].killed).toBe(true);
		expect(await pending).toHaveProperty("error");
		await new Promise((resolve) => setImmediate(resolve));
		expect(connectionErrors.map((error) => error.message)).toEqual([
			"Connection terminated unexpectedly",
		]);
	} finally {
		await blocker.query("rollback");
		blocker.release();
		await pending;
		for (const client of runtimeClients)
			client.removeListener("error", onConnectionError);
		await admin.query(
			"drop trigger zz_hia_pause_ledger on import_history_ledger",
		);
		await admin.query("drop function hia_pause_ledger()");
	}
	expect((await counts()).ledger).toBe(0);
	expect(
		(await admin.query("select count(*)::int as n from task")).rows[0].n,
	).toBe(1);
	expect(
		(
			await admin.query("select job_id from import_run where job_id=$1", [
				job.id,
			])
		).rowCount,
	).toBe(0);
	await finish(job);
	expect((await counts()).ledger).toBe(3);
});
