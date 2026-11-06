import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const zdb = zeroNodePg(schema, runtime);
const role = "ditero_content_scope_test";
const content = {
	kind: "list" as const,
	listKind: "tasks" as const,
	tasks: [{ title: "Parent", subtasks: [{ title: "Child" }] }],
};
const listArgs = {
	workspaceId: "cs-own",
	listId: "cs-new",
	sortKey: "a0",
};

async function call<A>(
	mutator: {
		fn: (input: {
			tx: Parameters<Parameters<typeof zdb.transaction>[0]>[0];
			ctx: { id: string };
			args: A;
		}) => Promise<unknown>;
	},
	args: A,
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, "cs-actor", () =>
			mutator.fn({ tx, ctx: { id: "cs-actor" }, args }),
		),
	);
}

async function clean() {
	await admin.query("delete from task where parent_id like 'cs-%'");
	await admin.query("delete from task where id like 'cs-%'");
	await admin.query("delete from template where id like 'cs-%'");
	await admin.query("delete from list where id like 'cs-%'");
	await admin.query("delete from folder where id like 'cs-%'");
	await admin.query("delete from membership where workspace_id like 'cs-%'");
	await admin.query("delete from workspace where id like 'cs-%'");
	await admin.query("delete from \"user\" where id like 'cs-%'");
}

beforeAll(async () => {
	await admin.query(`do $$ begin if not exists (select from pg_roles where rolname='${role}') then
		create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if; end $$`);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => {
		void client.query(`set role ${role}`);
	});
});

beforeEach(async () => {
	await clean();
	await admin.query(`insert into "user" (id,name,email) values
		('cs-actor','Actor','cs-actor@test.invalid'),('cs-owner','Owner','cs-owner@test.invalid')`);
	await admin.query(`insert into workspace (id,name,owner_id,kind) values
		('cs-own','Own','cs-actor','personal'),('cs-other','Other','cs-owner','shared')`);
	await admin.query(`insert into membership (id,user_id,workspace_id,role) values
		('cs-own-seat','cs-actor','cs-own','owner'),('cs-other-seat','cs-owner','cs-other','owner'),
		('cs-viewer-seat','cs-actor','cs-other','viewer')`);
	await admin.query(`insert into folder (id,workspace_id,name,sort_key) values
		('cs-folder','cs-own','Own','a0'),('cs-other-folder','cs-other','Other','a0')`);
	await admin.query(`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values
		('cs-list','cs-own','cs-actor','Own','tasks','a0'),
		('cs-other-list','cs-other','cs-owner','Other','tasks','a0')`);
	await admin.query(`insert into task (id,list_id,title,sort_key) values
		('cs-other-task','cs-other-list','Other task','a0')`);
	await admin.query(
		`insert into template (id,workspace_id,created_by,name,kind,content) values
		('cs-list-template','cs-own','cs-actor','List','list',$1),
		('cs-task-template','cs-own','cs-actor','Task','task',$2)`,
		[content, { kind: "task", task: content.tasks[0] }],
	);
});

afterAll(async () => {
	try {
		await clean();
	} finally {
		await runtime.end();
		await admin.end();
	}
});

async function instantiateList(kind: "saved" | "inline", listId: string) {
	if (kind === "saved")
		return call(mutators.template.instantiateList, {
			...listArgs,
			listId,
			templateId: "cs-list-template",
		});
	return call(mutators.template.instantiateContent, {
		...listArgs,
		listId,
		content,
		name: "New list",
	});
}

test.each([
	["saved", "viewer"],
	["inline", "viewer"],
	["saved", "removed"],
	["inline", "removed"],
] as const)("%s list creation requires a fresh id for a %s caller", async (kind, seat) => {
	if (seat === "removed")
		await admin.query("delete from membership where id='cs-viewer-seat'");
	const actual = await runtime.query(
		"select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(actual.rows).toEqual([
		{ current_user: role, rolsuper: false, rolbypassrls: false },
	]);
	await expect(instantiateList(kind, "cs-other-list")).rejects.toThrow(
		/creation conflicts/,
	);
	expect((await admin.query("select id from task order by id")).rows).toEqual([
		{ id: "cs-other-task" },
	]);
});

test.each([
	"root",
	"child",
])("task templates reject a reused %s id atomically", async (which) => {
	const taskId = which === "root" ? "cs-other-task" : "cs-root";
	if (which === "child")
		await admin.query(`insert into task (id,list_id,title,sort_key) values
			('cs-root-1','cs-other-list','Existing child id','a1')`);
	await expect(
		call(mutators.template.instantiateTask, {
			templateId: "cs-task-template",
			taskId,
			listId: "cs-list",
			sortKey: "a0",
		}),
	).rejects.toThrow(/creation conflicts/);
	expect(
		(await admin.query("select id from task where list_id='cs-list'")).rows,
	).toEqual([]);
});

test.each([
	"create",
	"inline",
	"update",
])("%s requires a folder in the list workspace", async (kind) => {
	const folderId = "cs-other-folder";
	const result =
		kind === "create"
			? call(mutators.list.create, {
					id: "cs-new",
					workspaceId: "cs-own",
					title: "New",
					kind: "tasks",
					sortKey: "a0",
					folderId,
				})
			: kind === "inline"
				? call(mutators.template.instantiateContent, {
						...listArgs,
						content,
						name: "New",
						folderId,
					})
				: call(mutators.list.update, { id: "cs-list", folderId });
	await expect(result).rejects.toThrow(/folder not in list workspace/);
	expect(
		(await admin.query("select id from list where folder_id=$1", [folderId]))
			.rows,
	).toEqual([]);
});

test.each([
	"viewer",
	"removed",
])("focus task references require write access for a %s caller", async (seat) => {
	if (seat === "removed")
		await admin.query("delete from membership where id='cs-viewer-seat'");
	await expect(
		call(mutators.focus.logSession, {
			taskId: "cs-other-task",
			kind: "work",
			startedAt: 0,
			endedAt: 1000,
			durationSec: 1,
		}),
	).rejects.toThrow(/access denied/);
	expect((await admin.query("select id from focus_session")).rows).toEqual([]);
});

test("fresh content, local folders, and writable focus tasks persist", async () => {
	await call(mutators.template.instantiateContent, {
		...listArgs,
		content,
		name: "New",
		folderId: "cs-folder",
	});
	await call(mutators.focus.logSession, {
		taskId: "cs-new-1",
		kind: "work",
		startedAt: 0,
		endedAt: 1000,
		durationSec: 1,
	});
	expect(
		(
			await admin.query(
				"select id,list_id,parent_id from task where list_id='cs-new' order by id",
			)
		).rows,
	).toEqual([
		{ id: "cs-new-1", list_id: "cs-new", parent_id: null },
		{ id: "cs-new-2", list_id: "cs-new", parent_id: "cs-new-1" },
	]);
	expect(
		(
			await admin.query(
				"select task_id from focus_session where user_id='cs-actor'",
			)
		).rows,
	).toEqual([{ task_id: "cs-new-1" }]);
});
