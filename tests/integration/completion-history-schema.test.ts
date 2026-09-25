import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = "ditero_completion_history_test";
const users = ["ch-owner", "ch-member", "ch-viewer", "ch-outsider"];
const tasks = ["ch-task", "ch-old-done", "ch-other-task", ""];
const recordedAt = new Date("2026-09-25T12:34:56.123Z");
const ownTaskHistory =
	"select * from task_completion_event where task_id = 'ch-task'";

type Scope = {
	present?: string;
	actorId?: string;
	taskId?: string;
	origin?: string;
	activation?: string;
};

async function withRuntime<T>(
	userId: string | null,
	scope: Scope,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await runtime.connect();
	try {
		await client.query(`set role ${role}`);
		await client.query("begin");
		const settings: [string, string | undefined][] = [
			["ditero.user_id", userId ?? undefined],
			["ditero.completion_history_scope_present", scope.present],
			["ditero.completion_history_actor_id", scope.actorId],
			["ditero.completion_history_task_id", scope.taskId],
			["ditero.completion_history_origin", scope.origin],
			["ditero.activation_scope", scope.activation],
		];
		for (const [key, value] of settings) {
			if (value !== undefined)
				await client.query("select set_config($1,$2,true)", [key, value]);
		}
		const result = await callback(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		await client.query("reset role");
		client.release();
	}
}

type EventRow = {
	id: string;
	taskId: string;
	actorUserId: string;
	recordedAt: Date;
	origin: string;
	action: string;
	beforeDueAt: Date | null;
	beforeDueAllDay: boolean | null;
	beforeDone: boolean | null;
	afterDueAt: Date | null;
	afterDone: boolean | null;
	habitDate: string | null;
	beforeHabitStatus: string | null;
	afterHabitStatus: string | null;
};

function event(fields: Partial<EventRow> = {}): EventRow {
	return {
		id: crypto.randomUUID(),
		taskId: "ch-task",
		actorUserId: "ch-member",
		recordedAt,
		origin: "member_mutation",
		action: "complete",
		beforeDueAt: null,
		beforeDueAllDay: false,
		beforeDone: false,
		afterDueAt: null,
		afterDone: true,
		habitDate: null,
		beforeHabitStatus: null,
		afterHabitStatus: null,
		...fields,
	};
}

async function insertEvent(client: PoolClient | Pool, row: EventRow) {
	return client.query(
		`insert into task_completion_event
		 (id,task_id,actor_user_id,recorded_at,origin,action,before_due_at,
		  before_due_all_day,before_done,after_due_at,after_done,habit_date,
		  before_habit_status,after_habit_status)
		 values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		[
			row.id,
			row.taskId,
			row.actorUserId,
			row.recordedAt,
			row.origin,
			row.action,
			row.beforeDueAt,
			row.beforeDueAllDay,
			row.beforeDone,
			row.afterDueAt,
			row.afterDone,
			row.habitDate,
			row.beforeHabitStatus,
			row.afterHabitStatus,
		],
	);
}

async function wipe() {
	await admin.query("delete from task where id = any($1::text[])", [tasks]);
	await admin.query(
		"delete from list where id in ('ch-list', 'ch-other-list')",
	);
	await admin.query("delete from membership where user_id = any($1::text[])", [
		users,
	]);
	await admin.query(
		"delete from workspace where id in ('ch-space', 'ch-other')",
	);
	await admin.query('delete from "user" where id = any($1::text[])', [users]);
}

beforeAll(async () => {
	await admin.query(`do $$ begin
		if not exists (select from pg_roles where rolname = '${role}') then
			create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select on task, list, membership, "user" to ${role}`,
	);
	await admin.query(
		`grant select, insert, update, delete on task_completion_event to ${role}`,
	);
});

beforeEach(async () => {
	await wipe();
	for (const id of users) {
		await admin.query(
			`insert into "user" (id,name,email,email_verified,created_at,updated_at)
			 values ($1,$1,$2,false,now(),now())`,
			[id, `${id}@example.test`],
		);
	}
	await admin.query(
		`insert into workspace (id,name,owner_id,kind) values
		 ('ch-space','Shared','ch-owner','shared'),
		 ('ch-other','Other','ch-outsider','shared')`,
	);
	for (const [userId, workspaceId, memberRole] of [
		["ch-owner", "ch-space", "owner"],
		["ch-member", "ch-space", "member"],
		["ch-viewer", "ch-space", "viewer"],
		["ch-outsider", "ch-other", "owner"],
	]) {
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,$4)",
			[`ch-m-${userId}`, userId, workspaceId, memberRole],
		);
	}
	await admin.query(
		`insert into list (id,workspace_id,owner_id,title,sort_key) values
		 ('ch-list','ch-space','ch-owner','Shared','a0'),
		 ('ch-other-list','ch-other','ch-outsider','Other','a0')`,
	);
	await admin.query(
		`insert into task (id,list_id,title,sort_key,done,completed_at) values
		 ('ch-task','ch-list','Task','a0',false,null),
		 ('ch-old-done','ch-list','Old done','a1',true,$1),
		 ('ch-other-task','ch-other-list','Other task','a0',false,null),
		 ('','ch-list','Empty ID task','a2',false,null)`,
		[recordedAt],
	);
});

afterAll(async () => {
	await wipe();
	await runtime.end();
	await admin.end();
});

test("generated table has millisecond precision, page index, and no inferred old history", async () => {
	const columns = await admin.query<{
		column_name: string;
		datetime_precision: number;
	}>(
		`select column_name, datetime_precision from information_schema.columns
		 where table_name = 'task_completion_event'
		   and column_name in ('recorded_at','before_due_at','after_due_at')`,
	);
	expect(columns.rows).toHaveLength(3);
	expect(columns.rows.every((row) => row.datetime_precision === 3)).toBe(true);
	const indexes = await admin.query<{ indexdef: string }>(
		"select indexdef from pg_indexes where indexname = 'task_completion_event_page_idx'",
	);
	expect(indexes.rows[0].indexdef).toMatch(
		/\(task_id, recorded_at DESC NULLS LAST, id DESC NULLS LAST\)/,
	);
	expect(
		(
			await admin.query(
				"select id from task_completion_event where task_id = 'ch-old-done'",
			)
		).rows,
	).toEqual([]);
	const policy = await admin.query<{
		relrowsecurity: boolean;
		relforcerowsecurity: boolean;
	}>(
		"select relrowsecurity, relforcerowsecurity from pg_class where oid = 'task_completion_event'::regclass",
	);
	expect(policy.rows[0]).toEqual({
		relrowsecurity: true,
		relforcerowsecurity: true,
	});
});

test("constraints accept unknown due dates and a skip whose prior done flag is true", async () => {
	await insertEvent(admin, event());
	await insertEvent(
		admin,
		event({
			action: "skip",
			beforeDone: true,
			afterDone: false,
			afterDueAt: recordedAt,
		}),
	);
	await insertEvent(
		admin,
		event({ action: "reopen", beforeDone: true, afterDone: false }),
	);
	await insertEvent(
		admin,
		event({
			action: "habit_set",
			habitDate: "2026-09-25",
			beforeDueAllDay: null,
			beforeDone: null,
			afterDone: null,
			beforeHabitStatus: null,
			afterHabitStatus: "done",
		}),
	);
	await insertEvent(
		admin,
		event({
			action: "habit_unlog",
			habitDate: "2026-09-25",
			beforeDueAllDay: null,
			beforeDone: null,
			afterDone: null,
			beforeHabitStatus: "skipped",
			afterHabitStatus: null,
		}),
	);
	const rows = await admin.query<{
		recorded_at: Date;
		before_due_at: Date | null;
	}>(
		"select recorded_at,before_due_at from task_completion_event where task_id = 'ch-task' order by id",
	);
	expect(rows.rows).toHaveLength(5);
	expect(rows.rows[0].recorded_at.getTime()).toBe(recordedAt.getTime());
	expect(rows.rows.every((row) => row.before_due_at === null)).toBe(true);
});

test.each([
	[
		{ action: "complete", beforeDone: true },
		"task_completion_event_transition",
	],
	[{ action: "reopen", beforeDone: false }, "task_completion_event_transition"],
	[{ action: "skip", afterDueAt: null }, "task_completion_event_transition"],
	[
		{
			action: "habit_set",
			habitDate: "2026-09-25",
			beforeDueAllDay: null,
			beforeDone: null,
			afterDone: null,
			beforeHabitStatus: "done",
			afterHabitStatus: "done",
		},
		"task_completion_event_transition",
	],
	[
		{
			action: "habit_unlog",
			habitDate: "2026-09-25",
			beforeDueAllDay: null,
			beforeDone: null,
			afterDone: null,
			beforeHabitStatus: null,
			afterHabitStatus: null,
		},
		"task_completion_event_transition",
	],
	[
		{ action: "complete", habitDate: "2026-09-25" },
		"task_completion_event_payload",
	],
	[{ origin: "untrusted" }, "task_completion_event_origin"],
	[{ id: "not-a-uuid" }, "task_completion_event_id_uuid"],
] as const)("invalid payload %j fails its check", async (fields, constraint) => {
	await expect(insertEvent(admin, event(fields))).rejects.toMatchObject({
		code: "23514",
		constraint,
	});
});

test("live members see only current workspace history; revocation and deletion hide it", async () => {
	await insertEvent(admin, event());
	for (const userId of ["ch-owner", "ch-member", "ch-viewer"]) {
		await withRuntime(userId, {}, async (client) => {
			expect((await client.query(ownTaskHistory)).rowCount).toBe(1);
		});
	}
	for (const userId of [null, "ch-outsider"]) {
		await withRuntime(userId, {}, async (client) => {
			expect((await client.query(ownTaskHistory)).rows).toEqual([]);
		});
	}
	await admin.query(
		"update task set list_id = 'ch-other-list' where id = 'ch-task'",
	);
	await withRuntime("ch-member", {}, async (client) => {
		expect((await client.query(ownTaskHistory)).rows).toEqual([]);
	});
	await withRuntime("ch-outsider", {}, async (client) => {
		expect((await client.query(ownTaskHistory)).rowCount).toBe(1);
	});
	await admin.query("update task set list_id = 'ch-list' where id = 'ch-task'");
	await admin.query("delete from membership where user_id = 'ch-viewer'");
	await withRuntime("ch-viewer", {}, async (client) => {
		expect((await client.query(ownTaskHistory)).rows).toEqual([]);
	});
	await admin.query(
		"update \"user\" set deleted_at = now() where id = 'ch-member'",
	);
	await withRuntime("ch-member", {}, async (client) => {
		expect((await client.query(ownTaskHistory)).rows).toEqual([]);
	});
});

test("insert needs exact actor, task, origin and explicit scope, including empty task ID", async () => {
	const valid: Scope = {
		present: "1",
		actorId: "ch-member",
		taskId: "ch-task",
		origin: "member_mutation",
	};
	for (const [userId, scope, row] of [
		["ch-member", {}, event()],
		["ch-member", { ...valid, present: "" }, event()],
		["ch-member", { ...valid, actorId: "ch-owner" }, event()],
		["ch-owner", valid, event()],
		["ch-member", { ...valid, taskId: "ch-other-task" }, event()],
		[
			"ch-member",
			{ ...valid, taskId: "ch-other-task" },
			event({ taskId: "ch-other-task" }),
		],
		["ch-member", { ...valid, origin: "capability_recipient" }, event()],
		[
			"ch-viewer",
			{ ...valid, actorId: "ch-viewer" },
			event({ actorUserId: "ch-viewer" }),
		],
		[
			"ch-outsider",
			{ ...valid, actorId: "ch-outsider" },
			event({ actorUserId: "ch-outsider" }),
		],
		["ch-member", { ...valid, activation: "ack" }, event()],
	] as const) {
		await expect(
			withRuntime(userId, scope, (client) => insertEvent(client, row)),
		).rejects.toMatchObject({ code: "42501" });
	}
	await withRuntime("ch-member", valid, (client) =>
		insertEvent(client, event()),
	);
	await withRuntime(
		"ch-member",
		{ ...valid, origin: "capability_recipient" },
		(client) => insertEvent(client, event({ origin: "capability_recipient" })),
	);
	await expect(
		withRuntime("ch-member", { ...valid, present: "", taskId: "" }, (client) =>
			insertEvent(client, event({ taskId: "" })),
		),
	).rejects.toMatchObject({ code: "42501" });
	await withRuntime("ch-member", { ...valid, taskId: "" }, (client) =>
		insertEvent(client, event({ taskId: "" })),
	);
	const count = await admin.query<{ count: string }>(
		"select count(*)::text as count from task_completion_event where task_id in ('ch-task', '')",
	);
	expect(count.rows[0].count).toBe("3");
	await admin.query("delete from membership where user_id = 'ch-member'");
	await expect(
		withRuntime("ch-member", valid, (client) => insertEvent(client, event())),
	).rejects.toMatchObject({ code: "42501" });
});

test("member scopes cannot update or delete; task cascade and anonymized actor stay intact", async () => {
	const row = event();
	await insertEvent(admin, row);
	const scope: Scope = {
		present: "1",
		actorId: "ch-member",
		taskId: "ch-task",
		origin: "member_mutation",
	};
	await withRuntime("ch-member", scope, async (client) => {
		expect(
			(
				await client.query(
					"update task_completion_event set action = 'skip' where id = $1",
					[row.id],
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await client.query("delete from task_completion_event where id = $1", [
					row.id,
				])
			).rowCount,
		).toBe(0);
	});
	await admin.query("delete from membership where user_id = 'ch-member'");
	await expect(
		admin.query('delete from "user" where id = $1', ["ch-member"]),
	).rejects.toMatchObject({ code: "23503" });
	await admin.query(
		`update "user" set name = 'Deleted user', email = 'deleted-ch@example.test',
		 deleted_at = now() where id = 'ch-member'`,
	);
	expect(
		(
			await admin.query(
				"select actor_user_id from task_completion_event where id = $1",
				[row.id],
			)
		).rows[0].actor_user_id,
	).toBe("ch-member");
	await admin.query("delete from task where id = 'ch-task'");
	expect(
		(
			await admin.query("select id from task_completion_event where id = $1", [
				row.id,
			])
		).rows,
	).toEqual([]);
});
