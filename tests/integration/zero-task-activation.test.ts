import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const zdb = zeroNodePg(schema, runtime);
const oldDue = new Date("2026-09-20T10:00:00.000Z");
const cutoff = new Date("2026-09-21T10:00:00.000Z");

async function call<A>(
	mutator: {
		fn: (input: {
			tx: Parameters<Parameters<typeof zdb.transaction>[0]>[0];
			ctx: { id: string };
			args: A;
		}) => Promise<void>;
	},
	actor: string,
	args: A,
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, actor, () =>
			mutator.fn({ tx, ctx: { id: actor }, args }),
		),
	);
}

async function guard(status: "pending" | "blocked" | "active") {
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
		values ('task',$1,1,$2,$2,$3)`,
		[
			status,
			status === "active" ? cutoff : null,
			status === "active" ? "import" : null,
		],
	);
}

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_zero_activation_test') then
		create role ditero_zero_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_zero_activation_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_zero_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_zero_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email,email_verified) values
		('alice','Alice','alice@example.test',false),
		('bob','Bob','bob@example.test',false),
		('cara','Cara','cara@example.test',false)`);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('ws','Shared','alice','shared')",
	);
	await admin.query(`insert into membership (id,user_id,workspace_id,role) values
		('ma','alice','ws','owner'),('mb','bob','ws','member'),('mc','cara','ws','member')`);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('list','ws','alice','List','tasks','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,due_at) values ('task','list','Task','a0',$1)",
		[oldDue],
	);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

test("native empty-ID children remain included in parent deletion", async () => {
	await call(mutators.task.create, "alice", {
		id: "",
		listId: "list",
		title: "Child",
		sortKey: "a1",
		parentId: "task",
	});
	await call(mutators.task.delete, "alice", { id: "task" });
	expect((await admin.query("select id from task")).rows).toEqual([]);
});

test("native empty-ID lists and tasks remain editable and deletable", async () => {
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('','ws','alice','Empty ID','tasks','a1')",
	);
	await call(mutators.task.create, "alice", {
		id: "",
		listId: "",
		title: "Native",
		sortKey: "a0",
	});
	await call(mutators.task.update, "alice", { id: "", title: "Edited" });
	await call(mutators.list.update, "alice", { id: "", title: "Edited list" });
	await call(mutators.list.delete, "alice", { id: "" });
	expect((await admin.query("select id from task where id='' ")).rows).toEqual(
		[],
	);
	expect((await admin.query("select id from list where id='' ")).rows).toEqual(
		[],
	);
});

test.each([
	"pending",
	"blocked",
] as const)("%s guard rejects task edits and assignment before writes", async (status) => {
	await guard(status);
	await expect(
		call(mutators.task.update, "alice", { id: "task", title: "Changed" }),
	).rejects.toThrow(/waiting for import activation/);
	await expect(
		call(mutators.task.assign, "alice", { taskId: "task", userId: "bob" }),
	).rejects.toThrow(/waiting for import activation/);
	await expect(
		call(mutators.task.complete, "alice", { id: "task" }),
	).rejects.toThrow(/waiting for import activation/);
	const task = await admin.query("select title,done from task where id='task'");
	expect(task.rows[0]).toMatchObject({ title: "Task", done: false });
	expect(
		(await admin.query("select 1 from task_assignee where task_id='task'"))
			.rowCount,
	).toBe(0);
});

test("active assignment advances generation and returning recipient keeps cleared suppression", async () => {
	await guard("active");
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','alice',true,1,$1,$2),('task','bob',false,1,$1,null)`,
		[cutoff, oldDue],
	);
	await call(mutators.task.assign, "alice", { taskId: "task", userId: "bob" });
	let rows = await admin.query(
		"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='task' order by user_id",
	);
	expect(rows.rows).toMatchObject([
		{ user_id: "alice", active: false, generation: 1 },
		{
			user_id: "bob",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: null,
		},
	]);
	await call(mutators.task.unassign, "alice", {
		taskId: "task",
		userId: "bob",
	});
	rows = await admin.query(
		"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='task' order by user_id",
	);
	expect(rows.rows).toMatchObject([
		{
			user_id: "alice",
			active: true,
			generation: 3,
			overdue_suppressed_due_at: oldDue,
		},
		{
			user_id: "bob",
			active: false,
			generation: 2,
			overdue_suppressed_due_at: null,
		},
	]);
	expect(
		(
			await admin.query(
				"select generation from task_notification_activation where task_id='task'",
			)
		).rows[0].generation,
	).toBe(3);
});

test("new recipient suppresses old due date and an idempotent assignment leaves generation unchanged", async () => {
	await guard("active");
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','alice',true,1,$1,null)`,
		[cutoff],
	);
	await call(mutators.task.assign, "alice", { taskId: "task", userId: "cara" });
	const first = await admin.query(
		"select generation,recipient_generation_cutoff from task_notification_activation where task_id='task'",
	);
	const recipient = await admin.query(
		"select active,generation,cutoff,overdue_suppressed_due_at from task_notification_recipient where task_id='task' and user_id='cara'",
	);
	expect(first.rows[0].generation).toBe(2);
	expect(recipient.rows[0]).toMatchObject({
		active: true,
		generation: 2,
		overdue_suppressed_due_at: oldDue,
	});
	expect(recipient.rows[0].cutoff.getTime()).toBe(
		first.rows[0].recipient_generation_cutoff.getTime(),
	);
	await call(mutators.task.assign, "alice", { taskId: "task", userId: "cara" });
	expect(
		(
			await admin.query(
				"select generation from task_notification_activation where task_id='task'",
			)
		).rows[0].generation,
	).toBe(2);
});

test("explicit changed due date clears active and inactive suppression; identical date does not", async () => {
	await guard("active");
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','alice',true,1,$1,$2),('task','bob',false,1,$1,$2)`,
		[cutoff, oldDue],
	);
	await call(mutators.task.update, "alice", {
		id: "task",
		dueAt: oldDue.getTime(),
	});
	expect(
		(
			await admin.query(
				"select count(*)::int as count from task_notification_recipient where overdue_suppressed_due_at is not null",
			)
		).rows[0].count,
	).toBe(2);
	await call(mutators.task.update, "alice", {
		id: "task",
		dueAt: oldDue.getTime() - 86_400_000,
	});
	expect(
		(
			await admin.query(
				"select count(*)::int as count from task_notification_recipient where overdue_suppressed_due_at is not null",
			)
		).rows[0].count,
	).toBe(0);
});

test("explicit due edit rejects oversized inactive recipient evidence atomically", async () => {
	await guard("active");
	await admin.query(`insert into "user" (id,name,email,email_verified)
		select 'retained-' || n, 'Retained', 'retained-' || n || '@example.test', false
		from generate_series(1,50001) n`);
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,overdue_suppressed_due_at)
		select 'task', 'retained-' || n, false, 1, $1
		from generate_series(1,50001) n`,
		[oldDue],
	);
	await expect(
		call(mutators.task.update, "alice", {
			id: "task",
			title: "Changed",
			dueAt: oldDue.getTime() - 86_400_000,
		}),
	).rejects.toThrow(/evidence exceeds import limit/);
	const task = await admin.query(
		"select title,due_at from task where id='task'",
	);
	expect(task.rows[0]).toMatchObject({ title: "Task", due_at: oldDue });
	expect(
		(
			await admin.query(
				`select count(*)::int as count from task_notification_recipient
		where task_id='task' and overdue_suppressed_due_at=$1`,
				[oldDue],
			)
		).rows[0].count,
	).toBe(50001);
}, 20_000);

test("native task edits and absent preference insertion remain available", async () => {
	await call(mutators.task.update, "alice", {
		id: "task",
		title: "Native edit",
	});
	await call(mutators.userPref.set, "alice", { timezone: "UTC" });
	expect(
		(await admin.query("select title from task where id='task'")).rows[0].title,
	).toBe("Native edit");
	expect(
		(await admin.query("select id from user_pref where id='alice'")).rows[0].id,
	).toBe("alice");
});

test("moving an active parent updates child owner fallback and retains assigned recipient", async () => {
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('ws2','Other','cara','shared')",
	);
	await admin.query(`insert into membership (id,user_id,workspace_id,role) values
		('ma2','alice','ws2','member'),('mb2','bob','ws2','member'),('mc2','cara','ws2','owner')`);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('list2','ws2','cara','Other list','tasks','b0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,parent_id,due_at) values ('child','list','Child','a1','task',$1)",
		[oldDue],
	);
	await admin.query(
		"insert into task_assignee (id,task_id,user_id) values ('task:bob','task','bob')",
	);
	await guard("active");
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
		values ('child','active',1,$1,$1,'import')`,
		[cutoff],
	);
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','bob',true,1,$1,$2),('child','alice',true,1,$1,$2)`,
		[cutoff, oldDue],
	);
	await call(mutators.task.move, "alice", {
		id: "task",
		listId: "list2",
		sortKey: "b1",
	});
	const tasks = await admin.query(
		"select id,list_id from task where id in ('task','child') order by id",
	);
	expect(tasks.rows).toMatchObject([
		{ id: "child", list_id: "list2" },
		{ id: "task", list_id: "list2" },
	]);
	const guards = await admin.query(
		"select task_id,generation from task_notification_activation order by task_id",
	);
	expect(guards.rows).toMatchObject([
		{ task_id: "child", generation: 2 },
		{ task_id: "task", generation: 2 },
	]);
	const childRows = await admin.query(
		"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='child' order by user_id",
	);
	expect(childRows.rows).toMatchObject([
		{ user_id: "alice", active: false, generation: 1 },
		{
			user_id: "cara",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: oldDue,
		},
	]);
	const parentRows = await admin.query(
		"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='task'",
	);
	expect(parentRows.rows).toMatchObject([
		{
			user_id: "bob",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: oldDue,
		},
	]);
});

test("pending child blocks parent move and pending task blocks list and folder edits", async () => {
	await admin.query(
		"insert into folder (id,workspace_id,name,sort_key) values ('folder','ws','Folder','a0')",
	);
	await admin.query("update list set folder_id='folder' where id='list'");
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('list2','ws','alice','Second','tasks','b0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,parent_id) values ('child','list','Child','a1','task')",
	);
	await admin.query(
		"insert into task_notification_activation (task_id,status,generation) values ('child','pending',1)",
	);
	await expect(
		call(mutators.task.move, "alice", {
			id: "task",
			listId: "list2",
			sortKey: "b1",
		}),
	).rejects.toThrow(/waiting for import activation/);
	await expect(
		call(mutators.list.update, "alice", { id: "list", title: "Changed" }),
	).rejects.toThrow(/waiting for import activation/);
	await expect(
		call(mutators.folder.update, "alice", { id: "folder", name: "Changed" }),
	).rejects.toThrow(/waiting for import activation/);
	await call(mutators.list.update, "alice", { id: "list", title: "List" });
	expect(
		(await admin.query("select list_id from task where id='child'")).rows[0]
			.list_id,
	).toBe("list");
});

test("native folder edit stays available above the import evidence limit", async () => {
	await admin.query(
		"insert into folder (id,workspace_id,name,sort_key) values ('folder','ws','Folder','a0')",
	);
	await admin.query(`insert into list (id,workspace_id,owner_id,folder_id,title,kind,sort_key)
		select 'bulk-list-' || n, 'ws', 'alice', 'folder', 'List', 'tasks', n::text
		from generate_series(1,50001) n`);
	await call(mutators.folder.update, "alice", {
		id: "folder",
		name: "Changed",
		sortKey: "b0",
	});
	expect(
		(await admin.query("select name,sort_key from folder where id='folder'"))
			.rows[0],
	).toMatchObject({ name: "Changed", sort_key: "b0" });
	expect(
		(
			await admin.query(
				"select count(*)::int as count from list where folder_id='folder'",
			)
		).rows[0].count,
	).toBe(50001);
}, 20_000);

test("pending habit refuses log before Karma or habit-log writes", async () => {
	await admin.query("update list set kind='habits' where id='list'");
	await guard("pending");
	await expect(
		call(mutators.habit.log, "alice", {
			habitId: "task",
			date: "2026-09-25",
			status: "done",
		}),
	).rejects.toThrow(/waiting for import activation/);
	expect(
		(await admin.query("select count(*)::int as count from habit_log")).rows[0]
			.count,
	).toBe(0);
});

test("pending reminder refuses in-app ack before reminder or task writes", async () => {
	await guard("pending");
	await admin.query(
		`insert into reminder_state
		(id,task_id,occurrence_at,recipient_user_id,status,fire_count,next_attempt_at)
		values ('reminder','task',$1,'bob','pending',1,now())`,
		[oldDue],
	);
	await expect(
		call(mutators.reminder.ack, "bob", { id: "reminder" }),
	).rejects.toThrow(/waiting for import activation/);
	expect(
		(await admin.query("select status from reminder_state where id='reminder'"))
			.rows[0].status,
	).toBe("pending");
	expect(
		(await admin.query("select done from task where id='task'")).rows[0].done,
	).toBe(false);
});

test("pending task can still be deleted with its guard", async () => {
	await guard("pending");
	await call(mutators.task.delete, "alice", { id: "task" });
	expect(
		(await admin.query("select 1 from task where id='task'")).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select 1 from task_notification_activation where task_id='task'",
			)
		).rowCount,
	).toBe(0);
});

test("automatic recurrence advancement retains old overdue suppression", async () => {
	await admin.query("update task set rrule='FREQ=DAILY' where id='task'");
	await guard("active");
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','alice',true,1,$1,$2)`,
		[cutoff, oldDue],
	);
	await call(mutators.task.skipOccurrence, "alice", { id: "task" });
	const recipient = await admin.query(
		"select overdue_suppressed_due_at from task_notification_recipient where task_id='task'",
	);
	expect(recipient.rows[0].overdue_suppressed_due_at).toEqual(oldDue);
});

test("over-limit assignment evidence is refused before materialization while deletion stays available", async () => {
	await admin.query(`insert into "user" (id,name,email,email_verified)
		select 'bulk-' || n, 'Bulk', 'bulk-' || n || '@example.test', false
		from generate_series(1,50001) n`);
	await admin.query(`insert into task_assignee (id,task_id,user_id)
		select 'task:bulk-' || n, 'task', 'bulk-' || n
		from generate_series(1,50001) n`);
	await expect(
		call(mutators.task.update, "alice", { id: "task", title: "Changed" }),
	).rejects.toThrow(/evidence exceeds import limit/);
	expect(
		(await admin.query("select title from task where id='task'")).rows[0].title,
	).toBe("Task");
	await call(mutators.task.delete, "alice", { id: "task" });
	expect(
		(await admin.query("select 1 from task where id='task'")).rowCount,
	).toBe(0);
}, 20_000);
