import { randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import {
	type AccountSetupRequest,
	accountSetupRequestSchema,
	planAccountSetupTransition,
} from "../../src/domain/account-setup.ts";
import { expandAccountSetupContent } from "../../src/domain/account-setup-content.ts";
import { accountSetupStoredStateSchema } from "../../src/domain/account-setup-storage.ts";
import {
	commitAccountSetupState,
	ensureAccountSetupWorkspace,
	insertAccountSetupContent,
	lockAccountSetupState,
} from "../../src/zero/account-setup-store.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString });
const role = `account_setup_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
const url = new URL(connectionString);
url.username = role;
url.password = password;
const runtime = new Pool({ connectionString: url.href });
const zdb = zeroNodePg(schema, runtime);
let alice: string;
let bob: string;
let third: string;
let users: string[] = [];

function request(
	mode: "basic" | "custom" | "skip" = "basic",
	expectedRevision = 0,
): AccountSetupRequest {
	return accountSetupRequestSchema.parse({
		requestId: randomUUID(),
		expectedRevision,
		catalogVersion: 1,
		locale: "en",
		mode,
	});
}
function apply(args: AccountSetupRequest, userId = alice) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, userId, () =>
			mutators.accountSetup.apply.fn({ tx, ctx: { id: userId }, args }),
		),
	);
}
async function stored(userId = alice) {
	const result = await admin.query(
		"select outcome,revision,catalog_version,locale,latest_receipt,generated_ids from account_setup where id=$1",
		[userId],
	);
	expect(result.rowCount).toBe(1);
	const row = result.rows[0];
	return accountSetupStoredStateSchema.parse({
		state: {
			outcome: row.outcome,
			revision: Number(row.revision),
			receipt: row.latest_receipt,
		},
		catalogVersion: row.catalog_version,
		locale: row.locale,
		generatedIds: row.generated_ids,
	});
}
async function counts(userId = alice) {
	return (
		await admin.query(
			`select
 (select count(*)::int from workspace where owner_id=$1) workspaces,
 (select count(*)::int from list where owner_id=$1) lists,
 (select count(*)::int from task t join list l on l.id=t.list_id where l.owner_id=$1) tasks,
 (select count(*)::int from dashboard where owner_id=$1) dashboards,
 (select coalesce(sum(jsonb_array_length(panels)),0)::int from dashboard where owner_id=$1) panels`,
			[userId],
		)
	).rows[0];
}
async function snapshot(userId: string) {
	return (
		await admin.query(
			`select
 (select jsonb_agg(to_jsonb(s) order by s.id) from account_setup s where s.id=$1) setup,
 (select jsonb_agg(to_jsonb(l) order by l.id) from list l where l.owner_id=$1) lists,
 (select jsonb_agg(to_jsonb(t) order by t.id) from task t join list l on l.id=t.list_id where l.owner_id=$1) tasks,
 (select jsonb_agg(to_jsonb(d) order by d.id) from dashboard d where d.owner_id=$1) dashboards`,
			[userId],
		)
	).rows[0];
}
beforeAll(async () => {
	const statement = await admin.query(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select current_user,session_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([
		{
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
		},
	]);
	expect(
		(
			await admin.query(
				"select relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) owner from pg_class where oid='account_setup'::regclass",
			)
		).rows,
	).toEqual([
		{
			relrowsecurity: true,
			relforcerowsecurity: true,
			owner: expect.not.stringMatching(`^${role}$`),
		},
	]);
});
beforeEach(async () => {
	[alice, bob, third] = [randomUUID(), randomUUID(), randomUUID()];
	users = [alice, bob, third];
	for (const id of users)
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
			[id, "Setup fixture", `${id}@setup.test`],
		);
});
afterEach(async () => {
	// Scope cleanup to this test's UUID users, including content whose IDs the server minted.
	await admin.query(
		"delete from task where list_id in (select id from list where owner_id=any($1::text[]))",
		[users],
	);
	await admin.query("delete from list where owner_id=any($1::text[])", [users]);
	await admin.query("delete from dashboard where owner_id=any($1::text[])", [
		users,
	]);
	await admin.query(
		"delete from membership where workspace_id in (select id from workspace where owner_id=any($1::text[]))",
		[users],
	);
	await admin.query("delete from workspace where owner_id=any($1::text[])", [
		users,
	]);
	await admin.query(
		"delete from managed_account where user_id=any($1::text[]) or guardian_id=any($1::text[])",
		[users],
	);
	await admin.query('delete from "user" where id=any($1::text[])', [users]);
});
afterAll(async () => {
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});

test("concurrent fresh requests admit one completed receipt and one content set", async () => {
	const first = request();
	const second = request();
	const results = await Promise.allSettled([apply(first), apply(second)]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const rejected = results.find((result) => result.status === "rejected");
	expect(
		rejected?.status === "rejected" ? String(rejected.reason) : "",
	).toContain("already-completed");
	const result = await stored();
	expect(result.state).toMatchObject({ outcome: "completed", revision: 1 });
	expect([first.requestId, second.requestId]).toContain(
		result.state.receipt?.request.requestId,
	);
	expect(await counts()).toEqual({
		workspaces: 1,
		lists: 2,
		tasks: 16,
		dashboards: 1,
		panels: 2,
	});
	expect(result.generatedIds?.listIds).toHaveLength(2);
	expect(result.generatedIds?.taskIds).toHaveLength(16);
	expect(result.generatedIds?.panelIds).toHaveLength(2);
	const ids = result.generatedIds;
	if (!ids) throw new Error("Completed setup fixture missing IDs");
	expect(
		(
			await admin.query("select id from list where owner_id=$1 order by id", [
				alice,
			])
		).rows.map((row) => row.id),
	).toEqual([...ids.listIds].sort());
	expect(
		(
			await admin.query(
				"select t.id from task t join list l on l.id=t.list_id where l.owner_id=$1 order by t.id",
				[alice],
			)
		).rows.map((row) => row.id),
	).toEqual([...ids.taskIds].sort());
	const dashboards = (
		await admin.query("select id,panels from dashboard where owner_id=$1", [
			alice,
		])
	).rows;
	expect(dashboards).toHaveLength(1);
	expect(dashboards[0].id).toBe(ids.dashboardId);
	expect(dashboards[0].panels.map((panel: { id: string }) => panel.id)).toEqual(
		ids.panelIds,
	);
});
test("exact replay retains the receipt and never repairs deleted content", async () => {
	const args = request();
	await apply(args);
	const original = await stored();
	expect(await counts()).toMatchObject({ lists: 2, tasks: 16, dashboards: 1 });
	const id = original.generatedIds?.listIds[0];
	expect(id).toBeDefined();
	await admin.query("delete from task where list_id=$1", [id]);
	await admin.query("delete from list where id=$1", [id]);
	const before = await snapshot(alice);
	await apply(args);
	expect(await snapshot(alice)).toEqual(before);
	expect(await stored()).toEqual(original);
	expect(await counts()).toMatchObject({ lists: 1, tasks: 8, dashboards: 1 });
});
test("the same UUID with a different canonical body conflicts without writes", async () => {
	const args = request();
	await apply(args);
	const before = await snapshot(alice);
	await expect(apply({ ...args, locale: "de" })).rejects.toThrow(
		"request-conflict",
	);
	expect(await snapshot(alice)).toEqual(before);
});
test.each([
	"custom",
	"skip",
] as const)("%s records an empty choice without a workspace or content", async (mode) => {
	const args = request(mode);
	await apply(args);
	expect((await stored()).state).toMatchObject({
		outcome: mode === "skip" ? "skipped" : "custom",
		revision: 1,
		receipt: { request: args },
	});
	expect(await counts()).toEqual({
		workspaces: 0,
		lists: 0,
		tasks: 0,
		dashboards: 0,
		panels: 0,
	});
	await expect(apply(request(mode, 1))).rejects.toThrow("apply-required");
	await apply(request("basic", 1));
	expect((await stored()).state).toMatchObject({
		outcome: "completed",
		revision: 2,
	});
	expect(await counts()).toMatchObject({ lists: 2, tasks: 16 });
});
test("an existing nonowner personal seat is refused without promotion or content", async () => {
	const workspace = randomUUID();
	const membership = randomUUID();
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Personal',$2,'personal')",
		[workspace, alice],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
		[membership, alice, workspace],
	);
	await expect(apply(request())).rejects.toThrow(
		"personal owner seat conflict",
	);
	expect(
		(await admin.query("select role from membership where id=$1", [membership]))
			.rows,
	).toEqual([{ role: "member" }]);
	expect(await counts()).toEqual({
		workspaces: 1,
		lists: 0,
		tasks: 0,
		dashboards: 0,
		panels: 0,
	});
	expect(
		(await admin.query("select id from account_setup where id=$1", [alice]))
			.rowCount,
	).toBe(0);
});
test.each([
	"deleted",
	"marker",
	"unrestricted-marker",
	"reserved-email",
])("%s actor cannot apply setup", async (kind) => {
	if (kind === "deleted")
		await admin.query('update "user" set deleted_at=now() where id=$1', [
			alice,
		]);
	else if (kind === "reserved-email")
		await admin.query('update "user" set email=$2 where id=$1', [
			alice,
			`${alice}@managed.invalid`,
		]);
	else
		await admin.query(
			"insert into managed_account(id,user_id,guardian_id,restricted) values($1,$2,$3,$4)",
			[randomUUID(), alice, bob, kind === "marker"],
		);
	await expect(apply(request())).rejects.toThrow(
		kind === "deleted" ? "no longer active" : "managed account",
	);
	expect(await counts()).toEqual({
		workspaces: 0,
		lists: 0,
		tasks: 0,
		dashboards: 0,
		panels: 0,
	});
	expect(
		(await admin.query("select id from account_setup where id=$1", [alice]))
			.rowCount,
	).toBe(0);
});
test("guardian rows do not mark their guardian as managed", async () => {
	await admin.query(
		"insert into managed_account(id,user_id,guardian_id,restricted) values($1,$2,$3,false)",
		[randomUUID(), bob, alice],
	);
	await apply(request());
	expect((await stored()).state.outcome).toBe("completed");
});
test.each([
	"receipt",
	"generated-ids",
])("malformed stored %s is rejected by the strict codec without repair", async (field) => {
	await apply(request());
	if (field === "receipt")
		await admin.query(
			"update account_setup set latest_receipt=jsonb_set(latest_receipt,'{request,unexpected}','true'::jsonb) where id=$1",
			[alice],
		);
	else
		await admin.query(
			"update account_setup set generated_ids=jsonb_set(generated_ids,'{listIds}','[\"invalid-uuid\"]'::jsonb) where id=$1",
			[alice],
		);
	const before = await snapshot(alice);
	await expect(apply(request("basic", 1))).rejects.toThrow();
	expect(await snapshot(alice)).toEqual(before);
});

test.each([
	"list",
	"task",
	"dashboard",
])("strict inserter helper: foreign %s collision rolls back the whole setup transaction", async (kind) => {
	await apply(request(), bob);
	const foreign = await stored(bob);
	const ids = foreign.generatedIds;
	expect(ids).not.toBeNull();
	if (!ids) throw new Error("Foreign setup fixture missing");
	const collision =
		kind === "list"
			? ids.listIds[0]
			: kind === "task"
				? ids.taskIds[0]
				: ids.dashboardId;
	if (!collision) throw new Error("Collision ID fixture missing");
	const before = await snapshot(bob);
	const args = request();
	const index = kind === "list" ? 0 : kind === "task" ? 1 : 18;
	await expect(
		zdb.transaction((tx) =>
			withZeroUserContext(tx, alice, async () => {
				const previous = await lockAccountSetupState(tx, alice);
				const transition = planAccountSetupTransition(previous, args);
				if (transition.kind !== "commit")
					throw new Error("Fresh transition fixture missing");
				const workspace = await ensureAccountSetupWorkspace(tx, alice);
				let n = 0;
				const content = expandAccountSetupContent(args, workspace, () =>
					n++ === index ? collision : randomUUID(),
				);
				expect(
					kind === "list"
						? content.lists[0]?.id
						: kind === "task"
							? content.tasks[0]?.id
							: content.dashboard?.id,
				).toBe(collision);
				await insertAccountSetupContent(tx, alice, workspace, content);
				await commitAccountSetupState(
					tx,
					alice,
					previous.revision,
					transition.state,
					{ version: 1, workspaceId: workspace, ...content.generatedIds },
				);
			}),
		),
	).rejects.toThrow(/duplicate key/i);
	expect(await snapshot(bob)).toEqual(before);
	expect(await counts()).toEqual({
		workspaces: 0,
		lists: 0,
		tasks: 0,
		dashboards: 0,
		panels: 0,
	});
	expect(
		(await admin.query("select id from account_setup where id=$1", [alice]))
			.rowCount,
	).toBe(0);
});

test("account_setup RLS permits own rows, hides foreign rows, and rejects forged ownership", async () => {
	await apply(request("custom"));
	await apply(request("skip"), bob);
	await withUserContext(runtime, alice, async (client) => {
		expect(
			(await client.query("select id from account_setup where id=$1", [alice]))
				.rows,
		).toEqual([{ id: alice }]);
		expect(
			(await client.query("select id from account_setup where id=$1", [bob]))
				.rowCount,
		).toBe(0);
		expect(
			(
				await client.query(
					"update account_setup set updated_at=now() where id=$1",
					[bob],
				)
			).rowCount,
		).toBe(0);
		await client.query("savepoint forged_insert");
		await expect(
			client.query("insert into account_setup(id) values($1)", [bob]),
		).rejects.toThrow(/row-level security/i);
		await client.query("rollback to savepoint forged_insert");
		await client.query("savepoint forged_update");
		await expect(
			client.query("update account_setup set id=$2 where id=$1", [
				alice,
				third,
			]),
		).rejects.toThrow(/row-level security/i);
		await client.query("rollback to savepoint forged_update");
		expect(
			(
				await client.query(
					"update account_setup set updated_at=now() where id=$1 returning id",
					[alice],
				)
			).rows,
		).toEqual([{ id: alice }]);
	});
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("select set_config('ditero.user_id','',true)");
		expect(
			(
				await client.query(
					"select id from account_setup where id=any($1::text[])",
					[users],
				)
			).rowCount,
		).toBe(0);
		await client.query("savepoint no_context");
		await expect(
			client.query("insert into account_setup(id) values($1)", [third]),
		).rejects.toThrow(/row-level security/i);
		await client.query("rollback to savepoint no_context");
		expect(
			(
				await client.query(
					"update account_setup set updated_at=now() where id=$1",
					[alice],
				)
			).rowCount,
		).toBe(0);
	} finally {
		await client.query("rollback");
		client.release();
	}
});
