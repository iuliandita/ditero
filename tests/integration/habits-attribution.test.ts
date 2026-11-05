import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const zdb = zeroNodePg(schema, runtime);
const role = "ditero_habit_attribution_test";
const owner = "ha-owner";
const member = "ha-member";
const viewer = "ha-viewer";
const outsider = "ha-outsider";
const date = "2026-11-05";
const args = { habitId: "ha-habit", date, status: "done" as const };

async function clean() {
	await admin.query("delete from task where id='ha-habit'");
	await admin.query("delete from list where id='ha-list'");
	await admin.query("delete from membership where workspace_id='ha-space'");
	await admin.query("delete from workspace where id='ha-space'");
	await admin.query('delete from "user" where id=any($1::text[])', [
		[owner, member, viewer, outsider],
	]);
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
	await admin.query(
		'insert into "user" (id,name,email) select id,id,id || $2 from unnest($1::text[]) id',
		[[owner, member, viewer, outsider], "@test.invalid"],
	);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('ha-space','Household',$1,'shared')",
		[owner],
	);
	await admin.query(
		`insert into membership (id,user_id,workspace_id,role) values
		('ha-owner-seat',$1,'ha-space','owner'),('ha-member-seat',$2,'ha-space','member'),('ha-viewer-seat',$3,'ha-space','viewer')`,
		[owner, member, viewer],
	);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,kind,sort_key) values ('ha-list','ha-space',$1,'Habits','habits','a0')",
		[owner],
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,rrule) values ('ha-habit','ha-list','Walk the dog','a0','FREQ=DAILY')",
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

async function log(userId: string, input = args) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, userId, () =>
			mutators.habit.log.fn({ tx, ctx: { id: userId }, args: input }),
		),
	);
}

async function logs() {
	return (
		await admin.query("select * from habit_log where habit_id='ha-habit'")
	).rows;
}

test("server derives the actor under a real non-owner, NOBYPASSRLS role and syncs the name only to members", async () => {
	const actualRole = await runtime.query(
		"select current_user, rolsuper, rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(actualRole.rows).toEqual([
		{ current_user: role, rolsuper: false, rolbypassrls: false },
	]);
	const spoofed = { ...args, completedBy: owner };
	await log(member, spoofed);
	expect(await logs()).toMatchObject([
		{ completed_by: member, status: "done" },
	]);
	const rows = await zdb.run(
		queries.habitLogs.mine.fn({ args: undefined, ctx: { id: owner } }),
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		completedBy: member,
		completer: { id: member, name: member },
	});
	expect(
		await zdb.run(
			queries.habitLogs.mine.fn({ args: undefined, ctx: { id: outsider } }),
		),
	).toEqual([]);
});

test("concurrent shared ticks retain one actor, one timestamp, and one Karma award", async () => {
	await Promise.all([log(member), log(owner)]);
	const first = (await logs())[0];
	expect(await logs()).toHaveLength(1);
	expect([member, owner]).toContain(first.completed_by);
	await log(first.completed_by === member ? owner : member);
	expect(await logs()).toEqual([first]);
	const karma = await admin.query(
		"select count(*)::int as awards, sum(delta)::int as points from karma_event where user_id=any($1::text[])",
		[[member, owner]],
	);
	expect(karma.rows).toEqual([{ awards: 1, points: 3 }]);
});

test.each([
	viewer,
	outsider,
])("%s cannot attribute a household completion", async (userId) => {
	await expect(log(userId)).rejects.toThrow(/access denied/);
	expect(await logs()).toEqual([]);
});

test("membership removal and user deletion preserve the completed occurrence", async () => {
	await log(member);
	await admin.query("delete from membership where id='ha-member-seat'");
	expect(await logs()).toMatchObject([
		{ completed_by: member, status: "done" },
	]);
	await admin.query('delete from "user" where id=$1', [member]);
	expect(await logs()).toMatchObject([
		{ completed_by: null, status: "done", karma_delta: 3 },
	]);
});
