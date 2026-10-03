import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	type HistoryCursor,
	historyPageSchema,
} from "../../src/domain/task-history.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import {
	readTaskHistory,
	taskHistoryRoutes,
} from "../../src/server/task-history.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: url });
const runtime = new Pool({
	connectionString: url,
	application_name: "ditero-history-read-test",
});
const role = "ditero_history_read_test";
const at = new Date("2020-01-02T03:04:05Z");
const claimNamespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let user = "hr-viewer";
const guards: Guards = {
	foreignOrigin: () => false,
	guardedGet:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: user } } as Session),
	guardedPost:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: user } } as Session),
};
const app = new Elysia().use(taskHistoryRoutes(runtime, guards));
const read = (cursor: HistoryCursor | null = null) =>
	readTaskHistory(runtime, user, "hr-task", "hr-space", cursor);
const request = (query = "taskId=hr-task&workspaceId=hr-space") =>
	app.handle(new Request(`http://localhost/api/tasks/history?${query}`));
beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists(select from pg_roles where rolname='${role}') then create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls;end if;end $$`,
	);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => void client.query(`set role ${role}`));
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	user = "hr-viewer";
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values ('hr-owner','Owner','hr-owner@example.test',false),('hr-viewer','Viewer','hr-viewer@example.test',false),('hr-outsider','Outside','hr-outside@example.test',false)`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values ('hr-space','Shared','hr-owner','shared'),('hr-outside','Outside','hr-outsider','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values ('hr-owner-seat','hr-owner','hr-space','owner'),('hr-viewer-seat','hr-viewer','hr-space','viewer'),('hr-outside-seat','hr-outsider','hr-outside','owner')`,
	);
	await admin.query(
		`insert into list(id,workspace_id,owner_id,title,sort_key) values ('hr-list','hr-space','hr-owner','List','a0'),('hr-outside-list','hr-outside','hr-outsider','Outside','a0')`,
	);
	await admin.query(
		`insert into task(id,list_id,title,sort_key) values ('hr-task','hr-list','Task','a0')`,
	);
});
afterAll(async () => {
	await runtime.end();
	await admin.end();
});
async function seed(native: number, imported: number) {
	for (let i = 0; i < native; i++)
		await admin.query(
			`insert into task_completion_event(id,task_id,actor_user_id,origin,recorded_at,action,before_due_all_day,before_done,after_done) values ($1,'hr-task','hr-owner','member_mutation',$2,'complete',false,false,true)`,
			[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, at],
		);
	for (let i = 0; i < imported; i++)
		await admin.query(
			`insert into imported_completion_event(id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,actor_namespace,actor_principal_id,actor_name,origin_kind,origin_label,action,before_due_all_day,before_done,after_done) values ($1,'hr-task',$2,$3,$4,'source_claim',$2,'hr-owner','Claimed person','source_claim','External app','complete',false,false,true)`,
			[i.toString(16).padStart(64, "0"), claimNamespace, `source-${i}`, at],
		);
}
test("real viewer reads one total bounded order across equal-time native/imported boundaries", async () => {
	await seed(105, 100);
	const pages = [];
	let cursor: HistoryCursor | null = null;
	do {
		const page = await read(cursor);
		expect(historyPageSchema.safeParse(page).success).toBe(true);
		pages.push(page);
		cursor = page.nextCursor;
	} while (cursor);
	expect(pages.map((page) => page.rows.length)).toEqual([100, 100, 5]);
	const rows = pages.flatMap((page) => page.rows);
	expect(new Set(rows.map((row) => `${row.sourceKind}:${row.id}`)).size).toBe(
		205,
	);
	expect(rows.slice(0, 105).every((row) => row.sourceKind === "native")).toBe(
		true,
	);
	expect(rows.slice(105).every((row) => row.sourceKind === "imported")).toBe(
		true,
	);
	expect(
		pages[1]?.rows.slice(0, 5).every((row) => row.sourceKind === "native"),
	).toBe(true);
	expect(pages[1]?.rows[5]?.sourceKind).toBe("imported");
	expect(
		(
			await runtime.query(
				"select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ current_user: role, rolsuper: false, rolbypassrls: false }]);
});
test("public claims contain display attribution without source identity or local identity elevation", async () => {
	await seed(1, 1);
	const response = await request();
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const page = await response.json();
	expect(page.rows[0].actor).toEqual({
		kind: "native_user",
		displayName: "Owner",
	});
	expect(page.rows[1].actor).toEqual({
		kind: "source_claim",
		displayName: "Claimed person",
	});
	expect(JSON.stringify(page)).not.toContain(claimNamespace);
	expect(JSON.stringify(page)).not.toContain("hr-owner");
	const astralName = "😀".repeat(512);
	const astralOrigin = "😀".repeat(128);
	await admin.query(
		`insert into imported_completion_event(id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,actor_namespace,actor_principal_id,actor_name,origin_kind,origin_label,action,before_due_all_day,before_done,after_done) values ('astral-claim','hr-task',$1,'source-astral',$2,'source_claim',$1,'raw-astral',$3,'source_claim',$4,'complete',false,false,true)`,
		[claimNamespace, new Date(at.getTime() - 1000), astralName, astralOrigin],
	);
	const fullClaims = await read();
	expect(historyPageSchema.safeParse(fullClaims).success).toBe(true);
	expect(fullClaims.rows[2]?.actor.displayName).toBe(astralName);
	expect(fullClaims.rows[2]?.origin.label).toBe(astralOrigin);
	await admin.query(`update "user" set deleted_at=now() where id='hr-owner'`);
	expect((await read()).rows[0]?.actor).toEqual({
		kind: "unknown",
		displayName: null,
	});
	expect((await read()).rows[1]?.actor.displayName).toBe("Claimed person");
});
test("native and imported IDs at the same time both use their source part of the cursor", async () => {
	await seed(1, 1);
	const first = await read();
	const native = first.rows[0];
	const imported = first.rows[1];
	if (!native || !imported) throw new Error("Missing history controls");
	expect(
		(
			await read({
				recordedAt: native.recordedAt,
				sourceKind: "native",
				id: native.id,
			})
		).rows.map((row) => row.sourceKind),
	).toEqual(["imported"]);
	expect(
		(
			await read({
				recordedAt: imported.recordedAt,
				sourceKind: "imported",
				id: imported.id,
			})
		).rows,
	).toEqual([]);
});
test("removed membership, missing task, and moved task all refuse without disclosure", async () => {
	await seed(1, 1);
	expect((await read()).rows).toHaveLength(2);
	await admin.query(`delete from membership where id='hr-viewer-seat'`);
	expect((await request()).status).toBe(404);
	expect((await request("taskId=not-a-task&workspaceId=hr-space")).status).toBe(
		404,
	);
	user = "hr-outsider";
	expect((await request()).status).toBe(404);
	await admin.query(
		`update task set list_id='hr-outside-list' where id='hr-task'`,
	);
	expect((await request()).status).toBe(404);
	expect((await request("taskId=hr-task&workspaceId=hr-outside")).status).toBe(
		200,
	);
});
test.each([
	"taskId=hr-task",
	"taskId=hr-task&workspaceId=hr-space&cursor=bad",
	"taskId=hr-task&workspaceId=hr-space&taskId=other",
	"taskId=hr-task&workspaceId=hr-space&limit=10000",
])("invalid bounded request refuses: %s", async (query) =>
	expect((await request(query)).status).toBe(400));
test("deleted callers are refused before returning any history", async () => {
	await seed(1, 1);
	await admin.query(`update "user" set deleted_at=now() where id='hr-viewer'`);
	const response = await request();
	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ code: "unauthorized" });
});

test.each([
	"move",
	"revoke",
])("a %s racing the reader scope is rechecked after its lock wait", async (change) => {
	await seed(1, 1);
	const blocker = await admin.connect();
	await blocker.query("begin");
	const pid = (
		await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
	).rows[0]?.pid;
	if (!pid) throw new Error("Missing owned blocker");
	await blocker.query(
		"select id from workspace where id='hr-space' for update",
	);
	const pending = request();
	try {
		const deadline = performance.now() + 2000;
		let blocked = false;
		while (performance.now() < deadline && !blocked) {
			const result = await admin.query(
				"select pid from pg_stat_activity where datname=current_database() and application_name='ditero-history-read-test' and $1=any(pg_blocking_pids(pid))",
				[pid],
			);
			blocked = result.rowCount === 1;
			if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(blocked).toBe(true);
		if (change === "move")
			await admin.query(
				"update task set list_id='hr-outside-list' where id='hr-task'",
			);
		else await admin.query("delete from membership where id='hr-viewer-seat'");
		await blocker.query("commit");
		expect((await pending).status).toBe(404);
	} finally {
		await blocker.query("rollback");
		blocker.release();
		await pending;
	}
});
