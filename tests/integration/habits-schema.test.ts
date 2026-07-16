// Schema round-trip for the M2 habits/karma/focus tables (migration 0008).
// Asserts the four new tables + three new task columns exist with correct
// types, the (habit_id, date) unique constraint holds, and FK cascade/set-null
// behavior applies. Domain logic + authorization are later tasks.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

// Scope cleanup to this file's own rows: sibling files share the DB.
async function wipe() {
	await db
		.delete(tables.focusSession)
		.where(eq(tables.focusSession.userId, "habit-user"));
	await db
		.delete(tables.karmaEvent)
		.where(eq(tables.karmaEvent.userId, "habit-user"));
	await db.delete(tables.karma).where(eq(tables.karma.userId, "habit-user"));
	await db.delete(tables.task).where(eq(tables.task.listId, "habit-list"));
	await db.delete(tables.list).where(eq(tables.list.id, "habit-list"));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, "habit-ws"));
	await db.delete(tables.user).where(eq(tables.user.id, "habit-user"));
}

beforeAll(async () => {
	await wipe();
	await db.insert(tables.user).values({
		id: "habit-user",
		name: "Habit User",
		email: "habit-user@test.invalid",
	});
	await db.insert(tables.workspace).values({
		id: "habit-ws",
		name: "Habit WS",
		ownerId: "habit-user",
		kind: "shared",
	});
	await db.insert(tables.list).values({
		id: "habit-list",
		workspaceId: "habit-ws",
		ownerId: "habit-user",
		title: "Habits",
		kind: "habits",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "habit-task",
		listId: "habit-list",
		title: "Walk the dog",
		sortKey: "a0",
	});
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

async function columnType(table: string, column: string) {
	const { rows } = await pool.query(
		`SELECT data_type, is_nullable, column_default
		 FROM information_schema.columns
		 WHERE table_name = $1 AND column_name = $2`,
		[table, column],
	);
	return rows[0] as
		| { data_type: string; is_nullable: string; column_default: string | null }
		| undefined;
}

describe("habits / karma / focus schema", () => {
	test("four new tables exist", async () => {
		const { rows } = await pool.query(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_name = ANY($1)`,
			[["habit_log", "karma", "karma_event", "focus_session"]],
		);
		const names = rows.map((r) => r.table_name).sort();
		expect(names).toEqual([
			"focus_session",
			"habit_log",
			"karma",
			"karma_event",
		]);
	});

	test("new task columns exist with correct types", async () => {
		const rrule = await columnType("task", "rrule");
		expect(rrule?.data_type).toBe("text");
		expect(rrule?.is_nullable).toBe("YES");

		const relative = await columnType("task", "recurrence_relative");
		expect(relative?.data_type).toBe("boolean");
		expect(relative?.is_nullable).toBe("NO");
		expect(relative?.column_default).toContain("false");

		const reminder = await columnType("task", "reminder_time");
		expect(reminder?.data_type).toBe("text");
		expect(reminder?.is_nullable).toBe("YES");
	});

	test("(habit_id, date) unique constraint present", async () => {
		const { rows } = await pool.query(
			`SELECT tc.constraint_type
			 FROM information_schema.table_constraints tc
			 WHERE tc.table_name = 'habit_log'
			   AND tc.constraint_type = 'UNIQUE'
			   AND tc.constraint_name = 'habit_log_habit_date'`,
		);
		expect(rows).toHaveLength(1);

		await db.insert(tables.habitLog).values({
			id: "log-1",
			habitId: "habit-task",
			date: "2026-07-14",
			status: "done",
			completedAt: new Date(),
		});
		await expect(
			db.insert(tables.habitLog).values({
				id: "log-2",
				habitId: "habit-task",
				date: "2026-07-14",
				status: "skipped",
			}),
		).rejects.toThrow();
	});

	test("habit_log cascades on task delete", async () => {
		await db.insert(tables.task).values({
			id: "habit-task-2",
			listId: "habit-list",
			title: "Water plants",
			sortKey: "a1",
		});
		await db.insert(tables.habitLog).values({
			id: "log-3",
			habitId: "habit-task-2",
			date: "2026-07-14",
			status: "done",
		});
		await db.delete(tables.task).where(eq(tables.task.id, "habit-task-2"));
		const rows = await db
			.select()
			.from(tables.habitLog)
			.where(eq(tables.habitLog.id, "log-3"));
		expect(rows).toHaveLength(0);
	});

	test("karma defaults + karma_event round-trip", async () => {
		await db.insert(tables.karma).values({ userId: "habit-user" });
		const karmaRows = await db
			.select()
			.from(tables.karma)
			.where(eq(tables.karma.userId, "habit-user"));
		expect(karmaRows[0]?.points).toBe(0);
		expect(karmaRows[0]?.level).toBe(1);

		await db.insert(tables.karmaEvent).values({
			id: "ke-1",
			userId: "habit-user",
			date: "2026-07-14",
			delta: 5,
			reason: "habit.complete",
		});
		const eventRows = await db
			.select()
			.from(tables.karmaEvent)
			.where(eq(tables.karmaEvent.id, "ke-1"));
		expect(eventRows[0]?.delta).toBe(5);
		expect(eventRows[0]?.reason).toBe("habit.complete");
	});

	test("focus_session round-trip + task set-null on delete", async () => {
		await db.insert(tables.task).values({
			id: "focus-task",
			listId: "habit-list",
			title: "Deep work",
			sortKey: "a2",
		});
		const started = new Date("2026-07-14T09:00:00Z");
		const ended = new Date("2026-07-14T09:25:00Z");
		await db.insert(tables.focusSession).values({
			id: "fs-1",
			userId: "habit-user",
			taskId: "focus-task",
			kind: "work",
			startedAt: started,
			endedAt: ended,
			durationSec: 1500,
		});
		await db.delete(tables.task).where(eq(tables.task.id, "focus-task"));
		const rows = await db
			.select()
			.from(tables.focusSession)
			.where(eq(tables.focusSession.id, "fs-1"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.taskId).toBeNull();
		expect(rows[0]?.durationSec).toBe(1500);
	});
});
