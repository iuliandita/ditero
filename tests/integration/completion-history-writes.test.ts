import {
	mustGetMutator,
	type ReadonlyJSONValue,
	type Transaction,
} from "@rocicorp/zero";
import { handleMutateRequest } from "@rocicorp/zero/server";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import type { Schema } from "../../src/zero/schema.gen.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const zdb = zeroNodePg(schema, runtime);
const actor = "history-writer-owner";
const viewer = "history-writer-viewer";
const workspace = "history-writer-space";
const taskList = "history-writer-tasks";
const habitList = "history-writer-habits";
const taskId = "history-writer-task";
const habitId = "history-writer-habit";
const due = Date.parse("2026-09-25T12:00:00.000Z");
const upstream = "history_writer_upstream";

async function call<A>(
	mutator: {
		fn: (input: {
			tx: Parameters<Parameters<typeof zdb.transaction>[0]>[0];
			ctx: { id: string };
			args: A;
		}) => Promise<void>;
	},
	userId: string,
	args: A,
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, userId, () =>
			mutator.fn({ tx, ctx: { id: userId }, args }),
		),
	);
}

async function events(task = taskId) {
	const result = await admin.query(
		`select task_id,actor_user_id,recorded_at,origin,action,before_due_at,
		before_due_all_day,before_done,after_due_at,after_done,habit_date,
		before_habit_status,after_habit_status from task_completion_event
		where task_id=$1 order by recorded_at,id`,
		[task],
	);
	return result.rows;
}

async function clean() {
	await admin.query("delete from task where id = any($1::text[])", [
		[taskId, habitId],
	]);
	await admin.query("delete from list where id = any($1::text[])", [
		[taskList, habitList],
	]);
	await admin.query("delete from membership where workspace_id=$1", [
		workspace,
	]);
	await admin.query("delete from workspace where id=$1", [workspace]);
	await admin.query('delete from "user" where id = any($1::text[])', [
		[actor, viewer],
	]);
}

beforeAll(async () => {
	await admin.query(`do $$ begin if not exists (select from pg_roles where rolname='ditero_history_writer_test') then
		create role ditero_history_writer_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if; end $$`);
	await admin.query(
		"grant usage on schema public to ditero_history_writer_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_history_writer_test",
	);
	await admin.query(`create schema if not exists ${upstream}`);
	await admin.query(`create table if not exists ${upstream}.clients (
		"clientGroupID" text not null, "clientID" text not null,
		"lastMutationID" bigint not null,
		primary key ("clientGroupID", "clientID"))`);
	await admin.query(`create table if not exists ${upstream}.mutations (
		"clientGroupID" text not null, "clientID" text not null,
		"mutationID" bigint not null, result json not null,
		primary key ("clientGroupID", "clientID", "mutationID"))`);
	await admin.query(
		`grant usage on schema ${upstream} to ditero_history_writer_test`,
	);
	await admin.query(
		`grant select, insert, update, delete on all tables in schema ${upstream} to ditero_history_writer_test`,
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_history_writer_test");
	});
});

beforeEach(async () => {
	await clean();
	await admin.query(`delete from ${upstream}.mutations`);
	await admin.query(`delete from ${upstream}.clients`);
	await admin.query(
		`insert into "user" (id,name,email,email_verified) values
		($1,'Writer','history-writer-owner@example.test',false),
		($2,'Viewer','history-writer-viewer@example.test',false)`,
		[actor, viewer],
	);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ($1,'History writer',$2,'shared')",
		[workspace, actor],
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values
		('history-writer-owner-seat',$1,$3,'owner'),
		('history-writer-viewer-seat',$2,$3,'viewer')`,
		[actor, viewer, workspace],
	);
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,kind,sort_key) values
		($1,$3,$4,'Tasks','tasks','a0'),($2,$3,$4,'Habits','habits','a1')`,
		[taskList, habitList, workspace, actor],
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key,due_at,due_all_day) values
		($1,$3,'Task','a0',$5,true),($2,$4,'Habit','a0',$5,false)`,
		[taskId, habitId, taskList, habitList, new Date(due)],
	);
});

afterAll(async () => {
	try {
		await clean();
		await admin.query(`drop schema ${upstream} cascade`);
	} finally {
		await runtime.end();
		await admin.end();
	}
});

async function push(mutationId: number, name: string, args: ReadonlyJSONValue) {
	return handleMutateRequest({
		dbProvider: zdb,
		handler: (transact) =>
			transact(async (tx, key, input) => {
				const mutator = mustGetMutator(mutators, key) as {
					fn: (entry: {
						tx: Transaction<Schema>;
						ctx: { id: string };
						args: unknown;
					}) => Promise<void>;
				};
				await withZeroUserContext(tx as Transaction<Schema>, actor, () =>
					mutator.fn({
						tx: tx as Transaction<Schema>,
						ctx: { id: actor },
						args: input,
					}),
				);
			}),
		query: { schema: upstream, appID: "ditero" },
		body: {
			clientGroupID: "history-writer-group",
			mutations: [
				{
					type: "custom",
					id: mutationId,
					clientID: "history-writer-client",
					name,
					args: [args],
					timestamp: Date.now(),
				},
			],
			pushVersion: 1,
			timestamp: Date.now(),
			requestID: `history-writer-${mutationId}`,
		},
		userID: actor,
		logLevel: "error",
	});
}

test("native completion records locked pre-state once, while reopening and due edits retain exact payload", async () => {
	await call(mutators.task.complete, actor, { id: taskId });
	await call(mutators.task.complete, actor, { id: taskId });
	let rows = await events();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		task_id: taskId,
		actor_user_id: actor,
		origin: "member_mutation",
		action: "complete",
		before_due_all_day: true,
		before_done: false,
		after_done: true,
	});
	expect(rows[0].before_due_at.getTime()).toBe(due);
	expect(rows[0].after_due_at.getTime()).toBe(due);
	await call(mutators.task.update, actor, {
		id: taskId,
		title: "Changed",
		done: true,
	});
	expect(await events()).toHaveLength(1);
	await call(mutators.task.update, actor, {
		id: taskId,
		done: false,
		dueAt: null,
	});
	rows = await events();
	expect(rows).toHaveLength(2);
	expect(rows[1]).toMatchObject({
		action: "reopen",
		before_done: true,
		after_done: false,
		after_due_at: null,
	});
	expect(rows[1].before_due_at.getTime()).toBe(due);
});

test("habit transitions record status changes only, including undo", async () => {
	const date = "2026-09-25";
	await call(mutators.habit.log, actor, {
		habitId,
		date,
		status: "done" as const,
	});
	await call(mutators.habit.log, actor, {
		habitId,
		date,
		status: "done" as const,
	});
	await call(mutators.habit.log, actor, {
		habitId,
		date,
		status: "skipped" as const,
	});
	await call(mutators.habit.unlog, actor, { habitId, date });
	await call(mutators.habit.unlog, actor, { habitId, date });
	expect(
		(await events(habitId)).map(
			({ action, before_habit_status, after_habit_status, habit_date }) => ({
				action,
				before_habit_status,
				after_habit_status,
				habit_date,
			}),
		),
	).toEqual([
		{
			action: "habit_set",
			before_habit_status: null,
			after_habit_status: "done",
			habit_date: date,
		},
		{
			action: "habit_set",
			before_habit_status: "done",
			after_habit_status: "skipped",
			habit_date: date,
		},
		{
			action: "habit_unlog",
			before_habit_status: "skipped",
			after_habit_status: null,
			habit_date: date,
		},
	]);
});

test("separate recurring completions and skip each record their own due transition", async () => {
	await admin.query("update task set rrule='FREQ=DAILY' where id=$1", [taskId]);
	await call(mutators.task.complete, actor, { id: taskId });
	await call(mutators.task.complete, actor, { id: taskId });
	await call(mutators.task.skipOccurrence, actor, { id: taskId });
	const rows = await events();
	expect(rows).toHaveLength(3);
	expect(rows.map(({ action }) => action).sort()).toEqual([
		"complete",
		"complete",
		"skip",
	]);
	const ordered = rows.sort(
		(a, b) => a.before_due_at.getTime() - b.before_due_at.getTime(),
	);
	expect(ordered.map(({ before_due_at }) => before_due_at.getTime())).toEqual([
		due,
		due + 86_400_000,
		due + 2 * 86_400_000,
	]);
	expect(ordered.map(({ after_due_at }) => after_due_at.getTime())).toEqual([
		due + 86_400_000,
		due + 2 * 86_400_000,
		due + 3 * 86_400_000,
	]);
	expect(ordered.map(({ after_done }) => after_done)).toEqual([
		false,
		false,
		false,
	]);
	const karma = await admin.query(
		"select count(*)::int as count from karma_event where user_id=$1",
		[actor],
	);
	expect(karma.rows[0].count).toBe(2);
});

test("denied viewer and pending activation write neither domain nor event", async () => {
	await expect(
		call(mutators.task.complete, viewer, { id: taskId }),
	).rejects.toThrow();
	await admin.query(
		`insert into task_notification_activation (task_id,status,generation)
		values ($1,'pending',1)`,
		[taskId],
	);
	await expect(
		call(mutators.task.complete, actor, { id: taskId }),
	).rejects.toThrow(/waiting for import activation/);
	expect(await events()).toHaveLength(0);
	expect(
		(await admin.query("select done from task where id=$1", [taskId])).rows[0]
			.done,
	).toBe(false);
});

test("event append failure rolls back task, Karma, and the event together", async () => {
	await admin.query(
		"revoke insert on task_completion_event from ditero_history_writer_test",
	);
	try {
		await expect(
			call(mutators.task.complete, actor, { id: taskId }),
		).rejects.toThrow();
		const task = (
			await admin.query("select done,completed_at from task where id=$1", [
				taskId,
			])
		).rows[0];
		expect(task).toMatchObject({ done: false, completed_at: null });
		expect(
			(
				await admin.query(
					"select count(*)::int as count from karma_event where user_id=$1",
					[actor],
				)
			).rows[0].count,
		).toBe(0);
		expect(await events()).toHaveLength(0);
	} finally {
		await admin.query(
			"grant insert on task_completion_event to ditero_history_writer_test",
		);
	}
});

test("real Zero push replay does not duplicate history; failed push rolls domain back but advances cursor", async () => {
	await admin.query(
		`insert into task_notification_activation (task_id,status,generation)
		values ($1,'pending',1)`,
		[taskId],
	);
	const failed = await push(1, "task.complete", { id: taskId });
	expect(JSON.stringify(failed)).toMatch(/application|error/i);
	expect(await events()).toHaveLength(0);
	expect(
		(await admin.query("select done from task where id=$1", [taskId])).rows[0]
			.done,
	).toBe(false);
	expect(
		(await admin.query(`select "lastMutationID" from ${upstream}.clients`))
			.rows[0].lastMutationID,
	).toBe("1");
	await admin.query(
		"delete from task_notification_activation where task_id=$1",
		[taskId],
	);
	const replay = await push(1, "task.complete", { id: taskId });
	expect(JSON.stringify(replay)).toMatch(/alreadyProcessed/);
	expect(await events()).toHaveLength(0);
	const retried = await push(2, "task.complete", { id: taskId });
	expect(JSON.stringify(retried)).not.toMatch(/error/i);
	expect(await events()).toHaveLength(1);
	const secondReplay = await push(2, "task.complete", { id: taskId });
	expect(JSON.stringify(secondReplay)).toMatch(/alreadyProcessed/);
	expect(await events()).toHaveLength(1);
	await push(3, "task.complete", { id: taskId });
	expect(await events()).toHaveLength(1);
});
