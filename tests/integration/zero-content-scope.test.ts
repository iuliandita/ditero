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
import { type PendingEvent, setEventSink } from "../../src/zero/event-sink.ts";
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
	actor = "cs-actor",
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, actor, () =>
			mutator.fn({ tx, ctx: { id: actor }, args }),
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
		('cs-actor','Actor','cs-actor@test.invalid'),('cs-owner','Owner','cs-owner@test.invalid'),
		('cs-outsider','Outsider','cs-outsider@test.invalid')`);
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

afterEach(() => setEventSink(null));

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
	["saved", "owner"],
	["inline", "owner"],
] as const)("%s list creation requires a fresh id for a %s caller", async (kind, seat) => {
	if (seat === "removed")
		await admin.query("delete from membership where id='cs-viewer-seat'");
	const targetList = seat === "owner" ? "cs-list" : "cs-other-list";
	const targetWorkspace = seat === "owner" ? "cs-own" : "cs-other";
	expect(
		(
			await admin.query(
				"select role from membership where user_id='cs-actor' and workspace_id=$1",
				[targetWorkspace],
			)
		).rows,
	).toEqual(seat === "removed" ? [] : [{ role: seat }]);
	if (seat !== "owner") {
		await expect(
			call(mutators.task.create, {
				id: "cs-control",
				listId: targetList,
				title: "Control",
				sortKey: "a0",
			}),
		).rejects.toThrow(/access denied/);
	}
	const actual = await runtime.query(
		"select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(actual.rows).toEqual([
		{ current_user: role, rolsuper: false, rolbypassrls: false },
	]);
	await expect(instantiateList(kind, targetList)).rejects.toThrow(
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
	"nonmember",
	"removed",
])("focus task references reject a %s caller", async (seat) => {
	if (seat === "removed")
		await admin.query("delete from membership where id='cs-viewer-seat'");
	await expect(
		call(
			mutators.focus.logSession,
			{
				taskId: "cs-other-task",
				kind: "work",
				startedAt: 0,
				endedAt: 1000,
				durationSec: 1,
			},
			seat === "nonmember" ? "cs-outsider" : "cs-actor",
		),
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

test.each([
	["create", "pending"],
	["create", "blocked"],
	["template", "pending"],
	["template", "blocked"],
] as const)("%s adds fresh content beside a %s import", async (kind, status) => {
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('cs-guarded','cs-list','Imported','a0')",
	);
	await admin.query(
		"insert into task_notification_activation (task_id,status,generation) values ('cs-guarded',$1,1)",
		[status],
	);
	if (kind === "create") {
		await call(mutators.task.create, {
			id: "cs-added",
			listId: "cs-list",
			title: "New",
			sortKey: "a1",
		});
	} else {
		await call(mutators.template.instantiateTask, {
			templateId: "cs-task-template",
			taskId: "cs-added",
			listId: "cs-list",
			sortKey: "a1",
		});
	}
	expect(
		(
			await admin.query(
				"select id,parent_id from task where list_id='cs-list' and id <> 'cs-guarded' order by id",
			)
		).rows,
	).toEqual(
		kind === "create"
			? [{ id: "cs-added", parent_id: null }]
			: [
					{ id: "cs-added", parent_id: null },
					{ id: "cs-added-1", parent_id: "cs-added" },
				],
	);
	expect(
		(
			await admin.query(
				"select status from task_notification_activation where task_id='cs-guarded'",
			)
		).rows,
	).toEqual([{ status }]);
});

test.each([
	"viewer",
	"downgraded",
])("a %s member retains a completed focus log", async (kind) => {
	if (kind === "downgraded")
		await admin.query(
			"update membership set role='member' where id='cs-viewer-seat'",
		);
	expect(
		(await admin.query("select role from membership where id='cs-viewer-seat'"))
			.rows,
	).toEqual([{ role: kind === "downgraded" ? "member" : "viewer" }]);
	const startedAt = Date.now() - 1000;
	if (kind === "downgraded")
		await admin.query(
			"update membership set role='viewer' where id='cs-viewer-seat'",
		);
	expect(
		(await admin.query("select role from membership where id='cs-viewer-seat'"))
			.rows,
	).toEqual([{ role: "viewer" }]);
	await call(mutators.focus.logSession, {
		taskId: "cs-other-task",
		kind: "work",
		startedAt,
		endedAt: startedAt + 1000,
		durationSec: 1,
	});
	expect(
		(
			await admin.query(
				"select user_id,task_id,duration_sec from focus_session",
			)
		).rows,
	).toEqual([
		{ user_id: "cs-actor", task_id: "cs-other-task", duration_sec: 1 },
	]);
});

test("a personal focus log coexists with a shared task lock", async () => {
	await call(mutators.task.create, {
		id: "cs-own-task",
		listId: "cs-list",
		title: "Task",
		sortKey: "a0",
	});
	const reader = await admin.connect();
	try {
		await reader.query("begin");
		await reader.query("select id from task where id='cs-own-task' for share");
		await zdb.transaction((tx) =>
			withZeroUserContext(tx, "cs-actor", async () => {
				if (tx.location !== "server")
					throw new Error("server transaction required");
				await tx.dbTransaction.query("set local lock_timeout='250ms'", []);
				await mutators.focus.logSession.fn({
					tx,
					ctx: { id: "cs-actor" },
					args: {
						taskId: "cs-own-task",
						kind: "work",
						startedAt: 0,
						endedAt: 1000,
						durationSec: 1,
					},
				});
			}),
		);
	} finally {
		await reader.query("rollback");
		reader.release();
	}
	expect((await admin.query("select task_id from focus_session")).rows).toEqual(
		[{ task_id: "cs-own-task" }],
	);
});

test.each([
	"cs-list",
	"cs-other-list",
])("list.create rejects the existing id %s", async (id) => {
	const before = (await admin.query("select * from list where id=$1", [id]))
		.rows;
	await expect(
		call(mutators.list.create, {
			id,
			workspaceId: "cs-own",
			title: "New",
			kind: "tasks",
			sortKey: "a1",
		}),
	).rejects.toThrow(/creation conflicts/);
	expect(
		(await admin.query("select * from list where id=$1", [id])).rows,
	).toEqual(before);
});

test("a repeated comment id cannot collect another mention", async () => {
	await call(mutators.task.create, {
		id: "cs-own-task",
		listId: "cs-list",
		title: "Task",
		sortKey: "a0",
	});
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ('cs-mention-seat','cs-owner','cs-own','member')",
	);
	const pending: PendingEvent[] = [];
	setEventSink((event) => pending.push(event));
	const args = {
		id: "cs-comment",
		taskId: "cs-own-task",
		body: "Hello @Owner",
	};
	await call(mutators.comment.add, args);
	expect(pending).toEqual([
		{
			recipientUserId: "cs-owner",
			event: {
				kind: "mention",
				commentId: "cs-comment",
				taskId: "cs-own-task",
				taskTitle: "Task",
				actorUserId: "cs-actor",
			},
		},
	]);
	await expect(call(mutators.comment.add, args)).rejects.toThrow(
		/creation conflicts/,
	);
	expect(pending).toHaveLength(1);
	expect(
		(await admin.query("select id,body from comment where id='cs-comment'"))
			.rows,
	).toEqual([{ id: "cs-comment", body: "Hello @Owner" }]);
});
