import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { HistoricalImportItem } from "../../src/domain/portability/import-plan-v2.ts";
import { parsePortableExportV2 } from "../../src/domain/portability/validate-v2.ts";
import { exportPortableJsonV2 } from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import {
	freezeHistoricalTargets,
	historicalItemKey,
} from "../../src/server/portability/import-history-target.ts";
import { saveImportPlan } from "../../src/server/portability/import-plan-store.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = "ditero_history_target_test";
const namespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const digest = "b".repeat(64);
const sourceHash = (id: string) =>
	createHash("sha256").update(id).digest("hex");
function item(
	parent = "iht-task",
	collection: "comments" | "templates" | "completionEvents" = "comments",
	sourceId = "",
): HistoricalImportItem {
	return {
		collection,
		archiveRowId: `source-${collection}`,
		archiveParentId: "source-parent",
		parentKind: collection === "templates" ? "workspace" : "task",
		ledger: {
			collection,
			targetParentId: parent,
			sourceNamespace: namespace,
			sourceId,
			sourceIdHash: sourceHash(sourceId),
		},
		semanticPayload: {},
		semanticDigest: digest,
	};
}
async function open(userId = "iht-member") {
	const client = await admin.connect();
	await client.query(`set role ${role}`);
	await client.query("begin");
	await client.query("select set_config('ditero.user_id', $1, true)", [userId]);
	return client;
}
async function close(client: PoolClient) {
	await client.query("rollback");
	await client.query("reset role");
	client.release();
}
async function freeze(value: HistoricalImportItem, userId = "iht-member") {
	const client = await open(userId);
	try {
		return (await freezeHistoricalTargets(client, userId, [value])).get(
			historicalItemKey(value),
		);
	} finally {
		await close(client);
	}
}
async function ledger(id: string, value: HistoricalImportItem, target: string) {
	await admin.query(
		"insert into import_history_ledger (id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest) values ($1,$2,$3,$4,$5,$6,$7,$8)",
		[
			id,
			value.collection,
			value.ledger.targetParentId,
			namespace,
			value.ledger.sourceId,
			value.ledger.sourceIdHash,
			target,
			digest,
		],
	);
}
async function wipe() {
	await admin.query("alter table import_history_ledger disable trigger user");
	try {
		await admin.query(
			"delete from import_history_ledger where id like 'iht-%'",
		);
	} finally {
		await admin.query("alter table import_history_ledger enable trigger user");
	}
	await admin.query("delete from template where id like 'iht-%'");
	await admin.query("delete from task where id like 'iht-%'");
	await admin.query("delete from list where id like 'iht-%'");
	await admin.query("delete from membership where id like 'iht-%'");
	await admin.query("delete from workspace where id like 'iht-%'");
	await admin.query("delete from \"user\" where id like 'iht-%'");
}
beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = '${role}') then create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => {
		void client.query(`set role ${role}`);
	});
	await admin.query(
		`grant select, update on "user", workspace, membership, list, task, comment, template to ${role}`,
	);
	await admin.query(
		`grant select on import_history_ledger, imported_completion_event to ${role}`,
	);
	await wipe();
	for (const id of [
		"iht-owner",
		"iht-member",
		"iht-viewer",
		"iht-outsider",
		"iht-deleted",
	])
		await admin.query(
			'insert into "user" (id,name,email,email_verified,created_at,updated_at) values ($1,$1,$2,false,now(),now())',
			[id, `${id}@example.test`],
		);
	await admin.query(
		"update \"user\" set deleted_at = now() where id = 'iht-deleted'",
	);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('iht-space','History','iht-owner','shared'),('iht-other-space','Other','iht-outsider','shared')",
	);
	for (const [id, userId, workspaceId, memberRole] of [
		["iht-owner-seat", "iht-owner", "iht-space", "owner"],
		["iht-member-seat", "iht-member", "iht-space", "member"],
		["iht-viewer-seat", "iht-viewer", "iht-space", "viewer"],
		["iht-deleted-seat", "iht-deleted", "iht-space", "member"],
		["iht-other-seat", "iht-outsider", "iht-other-space", "owner"],
	])
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,$4)",
			[id, userId, workspaceId, memberRole],
		);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ('iht-list','iht-space','iht-owner','History','a0'),('iht-other-list','iht-other-space','iht-outsider','Other','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('iht-task','iht-list','History','a0'),('iht-copy','iht-list','Copy','a1'),('iht-other-task','iht-other-list','Other','a0')",
	);
});
afterAll(async () => {
	try {
		await wipe();
	} finally {
		await admin.end();
		await runtime.end();
	}
});

test("saved v5 preview retains historical claims and exact planned-parent evidence without content writes", async () => {
	await admin.query(
		"insert into comment (id,task_id,author_id,body) values ('iht-preview-comment','iht-task','iht-member','Original historical text')",
	);
	const archive = parsePortableExportV2(
		await exportPortableJsonV2(admin, "iht-owner"),
	);
	const source = {
		mode: "new" as const,
		id: randomUUID(),
		label: "History archive",
	};
	const mappings = {
		workspaces: Object.fromEntries(
			archive.data.workspaces.map((row) => [row.id, row.id]),
		),
		principals: Object.fromEntries(
			archive.data.principals.map((row) => [
				row.id,
				row.id === "iht-owner" ? "iht-owner" : null,
			]),
		),
	};
	const before = await admin.query(
		"select (select count(*) from task)::int as tasks, (select count(*) from membership)::int as memberships, (select count(*) from comment)::int as comments, (select count(*) from imported_completion_event)::int as events",
	);
	const first = await saveImportPlan(
		runtime,
		"iht-owner",
		source,
		archive,
		mappings,
		{ plannerVersion: 4 },
	);
	const later = { ...archive, exportedAt: "2026-10-03T12:00:00.000Z" };
	const second = await saveImportPlan(
		runtime,
		"iht-owner",
		source,
		later,
		mappings,
		{ plannerVersion: 4 },
	);
	expect(second).toEqual(first);
	expect(first.report).toMatchObject({
		plannerVersion: 5,
		applySupported: false,
		applyBlockedReason: "history-apply-unsupported",
	});
	expect(first).not.toHaveProperty("items");
	const rows = await admin.query<{
		payload: { author: { kind: string; sourcePrincipalId: string } };
		dependency_proof: {
			parent: { dependencySourceKey: string; membershipId: string };
		};
	}>(
		"select payload, dependency_proof from import_item where job_id = $1 and collection = 'comments' and source_id = 'iht-preview-comment'",
		[first.id],
	);
	expect(rows.rows).toHaveLength(1);
	expect(rows.rows[0].payload.author).toMatchObject({
		kind: "source_claim",
		sourcePrincipalId: "iht-member",
	});
	expect(rows.rows[0].dependency_proof.parent).toMatchObject({
		membershipId: "iht-owner-seat",
		dependencySourceKey: expect.any(String),
	});
	await expect(
		applyImportBatch(runtime, "iht-owner", first.id, {
			planDigest: first.planDigest,
			counts: first.report.counts,
		}),
	).rejects.toMatchObject({ code: "import-apply-unsupported" });
	const direct = await open("iht-owner");
	try {
		await expect(
			direct.query(
				"insert into import_run (job_id,owner_user_id) values ($1,'iht-owner')",
				[first.id],
			),
		).rejects.toMatchObject({ code: "42501" });
	} finally {
		await close(direct);
	}
	expect(
		(
			await admin.query(
				"select (select count(*) from task)::int as tasks, (select count(*) from membership)::int as memberships, (select count(*) from comment)::int as comments, (select count(*) from imported_completion_event)::int as events",
			)
		).rows,
	).toEqual(before.rows);
	const malformed = structuredClone(archive);
	const historicalPrincipal = malformed.data.principals.find(
		(row) => row.id === "iht-member",
	);
	if (!historicalPrincipal)
		throw new Error("Missing historical principal fixture");
	historicalPrincipal.name = "x".repeat(513);
	await expect(
		saveImportPlan(
			runtime,
			"iht-owner",
			{ ...source, id: randomUUID() },
			malformed,
			mappings,
			{ plannerVersion: 4 },
		),
	).rejects.toMatchObject({ code: "historical-author-name-too-long" });
});

test("current writable membership authorizes deterministic creates and separate parent copies", async () => {
	const value = item();
	const first = await freeze(value);
	const second = await freeze(value);
	const copy = await freeze(item("iht-copy"));
	expect(first?.decision.disposition).toBe("create");
	expect(second?.decision).toEqual(first?.decision);
	expect(copy?.decision).not.toEqual(first?.decision);
	expect(first?.parent).toMatchObject({
		id: "iht-task",
		workspaceId: "iht-space",
		membershipId: "iht-member-seat",
		listId: "iht-list",
	});
	expect(
		(
			await admin.query(
				"select id from import_history_ledger where id like 'iht-%'",
			)
		).rowCount,
	).toBe(0);
});

test.each([
	"iht-viewer",
	"iht-outsider",
	"iht-deleted",
	"iht-missing",
])("refuses inaccessible parent without disclosing target for %s", async (userId) => {
	await expect(freeze(item(), userId)).rejects.toMatchObject({
		code: "historical-parent-unavailable",
	});
	await expect(freeze(item("nonexistent"), userId)).rejects.toMatchObject({
		code: "historical-parent-unavailable",
	});
});

test("reads exact empty-ID replay, content conflicts and retained tombstones", async () => {
	const value = item();
	await admin.query(
		"insert into comment (id,task_id,body,source_namespace,source_row_id,historical_author_kind,imported_at) values ('iht-comment','iht-task','History',$1,'','unknown',now())",
		[namespace],
	);
	await ledger("iht-empty", value, "iht-comment");
	expect((await freeze(value))?.decision).toEqual({
		disposition: "replay",
		targetId: "iht-comment",
	});
	const changed = { ...value, semanticDigest: "c".repeat(64) };
	expect((await freeze(changed))?.decision).toEqual({
		disposition: "conflict",
		code: "historical-content-conflict",
	});
	await admin.query("delete from comment where id = 'iht-comment'");
	expect((await freeze(value))?.decision).toEqual({
		disposition: "tombstone",
		targetId: "iht-comment",
	});
});

test("template and imported-event targets use their actual parent", async () => {
	const template = item("iht-space", "templates", "template");
	await admin.query(
		"insert into template (id,workspace_id,kind,name,content,created_by) values ('iht-template','iht-space','task','History','{}'::jsonb,'iht-owner')",
	);
	await ledger("iht-template-ledger", template, "iht-template");
	expect((await freeze(template))?.decision.disposition).toBe("replay");
	const event = item("iht-task", "completionEvents", "event");
	await admin.query(
		"insert into imported_completion_event (id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,origin_kind,action,before_due_all_day,before_done,after_done) values ('iht-event','iht-task',$1,'event',now(),'unknown','unknown','complete',false,false,true)",
		[namespace],
	);
	await ledger("iht-event-ledger", event, "iht-event");
	expect((await freeze(event))?.decision.disposition).toBe("replay");
});

test("a moved task follows its current workspace rather than original access", async () => {
	await admin.query(
		"update task set list_id = 'iht-other-list' where id = 'iht-copy'",
	);
	try {
		await expect(freeze(item("iht-copy"))).rejects.toMatchObject({
			code: "historical-parent-unavailable",
		});
		expect(
			(await freeze(item("iht-copy"), "iht-outsider"))?.parent.workspaceId,
		).toBe("iht-other-space");
	} finally {
		await admin.query(
			"update task set list_id = 'iht-list' where id = 'iht-copy'",
		);
	}
});

async function blocked(waiter: number, blocker: number) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const result = await admin.query<{ blocked: boolean }>(
			"select $2::int = any(pg_blocking_pids($1::int)) as blocked",
			[waiter, blocker],
		);
		if (result.rows[0]?.blocked) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Expected blocking PID was not observed");
}
test("freezing holds membership authority through caller commit", async () => {
	const planner = await open();
	const remover = await admin.connect();
	let pending: Promise<unknown> | undefined;
	try {
		await freezeHistoricalTargets(planner, "iht-member", [item()]);
		await remover.query("begin");
		const plannerPid = (
			await planner.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		const removerPid = (
			await remover.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		pending = remover.query(
			"delete from membership where id = 'iht-member-seat'",
		);
		await blocked(removerPid, plannerPid);
		await planner.query("commit");
		await pending;
		pending = undefined;
	} finally {
		await planner.query("rollback");
		await remover.query("rollback");
		if (pending) await pending;
		await planner.query("reset role");
		planner.release();
		remover.release();
	}
});

test("a prior membership removal wins before the frozen ledger read", async () => {
	const planner = await open();
	const remover = await admin.connect();
	try {
		const plannerPid = (
			await planner.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		const removerPid = (
			await remover.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		await remover.query("begin");
		await remover.query("delete from membership where id = 'iht-member-seat'");
		const pending = freezeHistoricalTargets(planner, "iht-member", [item()]);
		const refused = expect(pending).rejects.toMatchObject({
			code: "historical-parent-unavailable",
		});
		await blocked(plannerPid, removerPid);
		await remover.query("commit");
		await refused;
	} finally {
		await close(planner);
		await remover.query("rollback");
		remover.release();
	}
});
