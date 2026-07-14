// Isolation tests for the M2 habit-log / karma / focus read queries (queries.ts).
// These synced queries are the read-permission boundary: zero-cache only syncs
// rows they return, so a gap leaks another tenant's habit history or another
// user's karma/focus data. Mirrors views.test.ts: rows are seeded via Drizzle,
// then the compiled ZQL runs against Postgres through zeroNodePg.
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

// Two isolated tenants: a in workspace WA, b in workspace WB. Each has a habits
// list with a habit task, a habit_log row, plus own karma/karma_event/focus rows.
const userIds = ["hz-a", "hz-b"] as const;
const wsIds = ["hz-wa", "hz-wb"] as const;
const listIds = ["hz-la", "hz-lb"] as const;
const taskIds = ["hz-ha", "hz-hb"] as const;
const logIds = ["hz-log-a", "hz-log-b"] as const;
const eventIds = ["hz-ke-a", "hz-ke-b"] as const;
const focusIds = ["hz-fs-a", "hz-fs-b"] as const;

// FK order: focus_session/karma_event/karma -> habit_log -> task -> list ->
// membership -> workspace -> user. Scope every delete to this file's own rows.
async function wipe() {
	await db
		.delete(tables.focusSession)
		.where(inArray(tables.focusSession.id, [...focusIds]));
	await db
		.delete(tables.karmaEvent)
		.where(inArray(tables.karmaEvent.id, [...eventIds]));
	await db
		.delete(tables.karma)
		.where(inArray(tables.karma.userId, [...userIds]));
	await db
		.delete(tables.habitLog)
		.where(inArray(tables.habitLog.id, [...logIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, [...taskIds]));
	await db.delete(tables.list).where(inArray(tables.list.id, [...listIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, [...wsIds]));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

beforeAll(async () => {
	await wipe();
	await db
		.insert(tables.user)
		.values(
			userIds.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
		);
	await db.insert(tables.workspace).values([
		{ id: "hz-wa", name: "WA", ownerId: "hz-a", kind: "shared" },
		{ id: "hz-wb", name: "WB", ownerId: "hz-b", kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{ id: "hz-m-a", userId: "hz-a", workspaceId: "hz-wa", role: "owner" },
		{ id: "hz-m-b", userId: "hz-b", workspaceId: "hz-wb", role: "owner" },
	]);
	await db.insert(tables.list).values([
		{
			id: "hz-la",
			workspaceId: "hz-wa",
			ownerId: "hz-a",
			title: "A habits",
			kind: "habits",
			sortKey: "a0",
		},
		{
			id: "hz-lb",
			workspaceId: "hz-wb",
			ownerId: "hz-b",
			title: "B habits",
			kind: "habits",
			sortKey: "a0",
		},
	]);
	await db.insert(tables.task).values([
		{
			id: "hz-ha",
			listId: "hz-la",
			title: "A walk dog",
			sortKey: "a0",
			rrule: "FREQ=DAILY",
			reminderTime: "08:30",
		},
		{ id: "hz-hb", listId: "hz-lb", title: "B walk dog", sortKey: "a0" },
	]);
	await db.insert(tables.habitLog).values([
		{ id: "hz-log-a", habitId: "hz-ha", date: "2026-07-14", status: "done" },
		{ id: "hz-log-b", habitId: "hz-hb", date: "2026-07-14", status: "done" },
	]);
	await db.insert(tables.karma).values([
		{ userId: "hz-a", points: 10, level: 1 },
		{ userId: "hz-b", points: 20, level: 2 },
	]);
	await db.insert(tables.karmaEvent).values([
		{
			id: "hz-ke-a",
			userId: "hz-a",
			date: "2026-07-14",
			delta: 5,
			reason: "habit.complete",
		},
		{
			id: "hz-ke-b",
			userId: "hz-b",
			date: "2026-07-14",
			delta: 5,
			reason: "habit.complete",
		},
	]);
	const started = new Date("2026-07-14T09:00:00Z");
	const ended = new Date("2026-07-14T09:25:00Z");
	await db.insert(tables.focusSession).values([
		{
			id: "hz-fs-a",
			userId: "hz-a",
			kind: "work",
			startedAt: started,
			endedAt: ended,
			durationSec: 1500,
		},
		{
			id: "hz-fs-b",
			userId: "hz-b",
			kind: "work",
			startedAt: started,
			endedAt: ended,
			durationSec: 1500,
		},
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

// Filter the synced set to this file's own ids: sibling files share the DB.
function only<T extends { id: string }>(
	rows: readonly T[],
	ids: readonly string[],
) {
	return rows
		.map((r) => r.id)
		.filter((id) => ids.includes(id))
		.sort();
}

describe("habit_log read-permission isolation", () => {
	test("member of WA reads WA's habit log, not WB's", async () => {
		const rows = await zdb.run(queries.habitLogs.mine.fn(ctx("hz-a")));
		expect(only(rows, logIds)).toEqual(["hz-log-a"]);
	});

	test("member of WB reads WB's habit log, not WA's", async () => {
		const rows = await zdb.run(queries.habitLogs.mine.fn(ctx("hz-b")));
		expect(only(rows, logIds)).toEqual(["hz-log-b"]);
	});
});

describe("karma read-permission isolation", () => {
	test("each user reads only their own karma row", async () => {
		const a = await zdb.run(queries.karma.mine.fn(ctx("hz-a")));
		expect(a.map((r) => r.userId)).toEqual(["hz-a"]);
		const b = await zdb.run(queries.karma.mine.fn(ctx("hz-b")));
		expect(b.map((r) => r.userId)).toEqual(["hz-b"]);
	});
});

describe("karma_event read-permission isolation", () => {
	test("each user reads only their own karma events", async () => {
		const a = await zdb.run(queries.karmaEvents.mine.fn(ctx("hz-a")));
		expect(only(a, eventIds)).toEqual(["hz-ke-a"]);
		const b = await zdb.run(queries.karmaEvents.mine.fn(ctx("hz-b")));
		expect(only(b, eventIds)).toEqual(["hz-ke-b"]);
	});
});

describe("focus_session read-permission isolation", () => {
	test("each user reads only their own focus sessions", async () => {
		const a = await zdb.run(queries.focusSessions.mine.fn(ctx("hz-a")));
		expect(only(a, focusIds)).toEqual(["hz-fs-a"]);
		const b = await zdb.run(queries.focusSessions.mine.fn(ctx("hz-b")));
		expect(only(b, focusIds)).toEqual(["hz-fs-b"]);
	});
});

describe("new recurrence task columns flow through tasks.mine", () => {
	test("a visible habit task exposes rrule + reminderTime", async () => {
		const rows = await zdb.run(queries.tasks.mine.fn(ctx("hz-a")));
		const habit = rows.find((r) => r.id === "hz-ha");
		expect(habit?.rrule).toBe("FREQ=DAILY");
		expect(habit?.reminderTime).toBe("08:30");
	});
});
