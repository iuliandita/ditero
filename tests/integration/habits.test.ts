// M2 habit/recurrence/focus/karma tests. Two halves:
//  1. Read-permission isolation for the synced queries (queries.ts) -- zero-cache
//     only syncs rows they return, so a gap leaks another tenant's habit history
//     or another user's karma/focus data. Rows seeded via Drizzle, compiled ZQL
//     run against Postgres through zeroNodePg (mirrors views.test.ts).
//  2. Write-permission mutators (mutators.ts): task.complete/skipOccurrence,
//     habit.log/unlog, focus.logSession, userPref.set caps -- the milestone's
//     server-authoritative write boundary (role matrix, Karma idempotency,
//     fail-closed on malformed input).
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { type Schema, schema } from "../../src/zero/schema.gen.ts";

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

// --- M2 write mutators: task.complete / skipOccurrence, habit.log / unlog,
// focus.logSession, userPref.set caps. These are the server-authoritative write
// boundary; the milestone's most security-sensitive surface, so the role matrix,
// Karma idempotency, and fail-closed (malformed input -> zero writes) are the spec.
type Ctx = { id: string };
async function call<A>(
	mutator: {
		fn: (a: { tx: Transaction<Schema>; ctx: Ctx; args: A }) => Promise<void>;
	},
	c: Ctx,
	args: A,
) {
	return zdb.transaction((tx) => mutator.fn({ tx, ctx: c, args }));
}

const DAY = 86_400_000;
const ANCHOR = Date.UTC(2026, 0, 1); // fixed due-date anchor for recurring tasks

const mUsers = [
	"hm-owner",
	"hm-admin",
	"hm-member",
	"hm-viewer",
	"hm-out",
] as const;
const mTaskIds = [
	"hm-t-plain",
	"hm-t-fixed",
	"hm-t-rel",
	"hm-t-exhausted",
	"hm-t-bad",
	"hm-habit",
] as const;

async function mWipe() {
	await db
		.delete(tables.focusSession)
		.where(inArray(tables.focusSession.userId, [...mUsers]));
	await db
		.delete(tables.karmaEvent)
		.where(inArray(tables.karmaEvent.userId, [...mUsers]));
	await db
		.delete(tables.karma)
		.where(inArray(tables.karma.userId, [...mUsers]));
	await db
		.delete(tables.habitLog)
		.where(inArray(tables.habitLog.habitId, [...mTaskIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, [...mTaskIds]));
	await db
		.delete(tables.list)
		.where(inArray(tables.list.id, ["hm-l", "hm-lh"]));
	await db
		.delete(tables.userPref)
		.where(inArray(tables.userPref.id, [...mUsers]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...mUsers]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, ["hm-w", "hm-wo"]));
	await db.delete(tables.user).where(inArray(tables.user.id, [...mUsers]));
}

// Re-seed the mutable rows (tasks, lists) that individual tests write to; leaves
// users/workspaces/memberships (static) in place. Clears the Karma ledger, logs
// and focus rows so every test starts from a known zero state.
async function mSeedTasks() {
	await db
		.delete(tables.focusSession)
		.where(inArray(tables.focusSession.userId, [...mUsers]));
	await db
		.delete(tables.karmaEvent)
		.where(inArray(tables.karmaEvent.userId, [...mUsers]));
	await db
		.delete(tables.karma)
		.where(inArray(tables.karma.userId, [...mUsers]));
	await db
		.delete(tables.habitLog)
		.where(inArray(tables.habitLog.habitId, [...mTaskIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, [...mTaskIds]));
	await db.insert(tables.task).values([
		{ id: "hm-t-plain", listId: "hm-l", title: "plain", sortKey: "a0" },
		{
			id: "hm-t-fixed",
			listId: "hm-l",
			title: "fixed daily",
			sortKey: "a1",
			rrule: "FREQ=DAILY",
			recurrenceRelative: false,
			dueAt: new Date(ANCHOR),
		},
		{
			id: "hm-t-rel",
			listId: "hm-l",
			title: "relative every 2d",
			sortKey: "a2",
			rrule: "FREQ=DAILY;INTERVAL=2",
			recurrenceRelative: true,
			dueAt: new Date(ANCHOR),
		},
		{
			id: "hm-t-exhausted",
			listId: "hm-l",
			title: "one-shot",
			sortKey: "a3",
			rrule: "FREQ=DAILY;COUNT=1",
			recurrenceRelative: false,
			dueAt: new Date(ANCHOR),
		},
		{
			id: "hm-t-bad",
			listId: "hm-l",
			title: "malformed rule",
			sortKey: "a4",
			rrule: "FREQ=BOGUS",
			dueAt: new Date(ANCHOR),
		},
		{
			id: "hm-habit",
			listId: "hm-lh",
			title: "walk dog",
			sortKey: "a0",
			priority: 1,
			rrule: "FREQ=DAILY",
		},
	]);
}

async function taskRow(id: string) {
	return (await db.select().from(tables.task).where(eq(tables.task.id, id)))[0];
}
async function karmaRow(userId: string) {
	return (
		await db.select().from(tables.karma).where(eq(tables.karma.userId, userId))
	)[0];
}
async function eventCount(userId: string) {
	return (
		await db
			.select()
			.from(tables.karmaEvent)
			.where(eq(tables.karmaEvent.userId, userId))
	).length;
}
async function logRow(habitId: string, date: string) {
	return (
		await db
			.select()
			.from(tables.habitLog)
			.where(
				and(
					eq(tables.habitLog.habitId, habitId),
					eq(tables.habitLog.date, date),
				),
			)
	)[0];
}

describe("M2 habit/recurrence/focus/karma mutators", () => {
	beforeAll(async () => {
		await mWipe();
		await db
			.insert(tables.user)
			.values(
				mUsers.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
			);
		await db.insert(tables.workspace).values([
			{ id: "hm-w", name: "MW", ownerId: "hm-owner", kind: "shared" },
			{ id: "hm-wo", name: "MWO", ownerId: "hm-out", kind: "shared" },
		]);
		await db.insert(tables.membership).values([
			{ id: "hm-m-o", userId: "hm-owner", workspaceId: "hm-w", role: "owner" },
			{ id: "hm-m-a", userId: "hm-admin", workspaceId: "hm-w", role: "admin" },
			{
				id: "hm-m-m",
				userId: "hm-member",
				workspaceId: "hm-w",
				role: "member",
			},
			{
				id: "hm-m-v",
				userId: "hm-viewer",
				workspaceId: "hm-w",
				role: "viewer",
			},
			{ id: "hm-m-out", userId: "hm-out", workspaceId: "hm-wo", role: "owner" },
		]);
		await db.insert(tables.list).values([
			{
				id: "hm-l",
				workspaceId: "hm-w",
				ownerId: "hm-owner",
				title: "tasks",
				kind: "tasks",
				sortKey: "a0",
			},
			{
				id: "hm-lh",
				workspaceId: "hm-w",
				ownerId: "hm-owner",
				title: "habits",
				kind: "habits",
				sortKey: "a1",
			},
		]);
	});

	afterAll(mWipe);
	beforeEach(mSeedTasks);

	describe("task.complete", () => {
		test("non-recurring -> done + completedAt + Karma", async () => {
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-plain" },
			);
			const t = await taskRow("hm-t-plain");
			expect(t.done).toBe(true);
			expect(t.completedAt).not.toBeNull();
			const k = await karmaRow("hm-owner");
			expect(k.points).toBe(5); // task base, priority 0
			expect(await eventCount("hm-owner")).toBe(1);
		});

		test("recurring fixed -> dueAt advances one day, done stays false", async () => {
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-fixed" },
			);
			const t = await taskRow("hm-t-fixed");
			expect(t.done).toBe(false);
			expect(t.completedAt).toBeNull();
			expect(t.dueAt?.getTime()).toBe(ANCHOR + DAY);
			expect((await karmaRow("hm-owner")).points).toBe(5); // awarded per occurrence
		});

		test("recurring relative -> dueAt = completedAt + interval (ignores due anchor)", async () => {
			const t0 = Date.now();
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-rel" },
			);
			const t1 = Date.now();
			const t = await taskRow("hm-t-rel");
			expect(t.done).toBe(false);
			const due = t.dueAt?.getTime() ?? 0;
			expect(due).toBeGreaterThanOrEqual(t0 + 2 * DAY);
			expect(due).toBeLessThanOrEqual(t1 + 2 * DAY);
		});

		test("exhausted series -> done true", async () => {
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-exhausted" },
			);
			const t = await taskRow("hm-t-exhausted");
			expect(t.done).toBe(true);
			expect(t.completedAt).not.toBeNull();
		});

		test("malformed rrule -> throws, task unchanged, no Karma", async () => {
			await expect(
				call(mutators.task.complete, { id: "hm-owner" }, { id: "hm-t-bad" }),
			).rejects.toThrow();
			const t = await taskRow("hm-t-bad");
			expect(t.done).toBe(false);
			expect(t.dueAt?.getTime()).toBe(ANCHOR);
			expect(await karmaRow("hm-owner")).toBeUndefined();
		});

		test("viewer is denied", async () => {
			await expect(
				call(mutators.task.complete, { id: "hm-viewer" }, { id: "hm-t-plain" }),
			).rejects.toThrow(/access denied/);
		});

		// A habit is a task row in a kind=habits list; it completes only via
		// habit.log. task.complete must reject it before any write so it cannot
		// double-award task Karma or advance the habit's dueAt.
		test("habit-kind task is rejected and writes nothing", async () => {
			await expect(
				call(mutators.task.complete, { id: "hm-owner" }, { id: "hm-habit" }),
			).rejects.toThrow(/habit\.log/);
			const t = await taskRow("hm-habit");
			expect(t.done).toBe(false);
			expect(t.completedAt).toBeNull();
			expect(t.dueAt ?? null).toBeNull(); // dueAt not advanced
			expect(await karmaRow("hm-owner")).toBeUndefined();
			expect(await eventCount("hm-owner")).toBe(0);
		});
	});

	describe("task.skipOccurrence", () => {
		test("advances dueAt, no done, no Karma", async () => {
			await call(
				mutators.task.skipOccurrence,
				{ id: "hm-member" },
				{ id: "hm-t-fixed" },
			);
			const t = await taskRow("hm-t-fixed");
			expect(t.done).toBe(false);
			expect(t.dueAt?.getTime()).toBe(ANCHOR + DAY);
			expect(await karmaRow("hm-member")).toBeUndefined();
		});

		test("throws on a non-recurring task", async () => {
			await expect(
				call(
					mutators.task.skipOccurrence,
					{ id: "hm-owner" },
					{ id: "hm-t-plain" },
				),
			).rejects.toThrow(/not a recurring task/);
		});
	});

	// task.update must not be able to disagree with task.complete about what
	// `done` means on a recurring task: `done && rrule` is reserved for an
	// exhausted series (issue #24). Guards mutators.ts task.update's live-series
	// rejection.
	describe("task.update recurrence-done invariant", () => {
		test("rejects done:true on a live fixed recurring task, writes nothing", async () => {
			await expect(
				call(
					mutators.task.update,
					{ id: "hm-owner" },
					{ id: "hm-t-fixed", done: true },
				),
			).rejects.toThrow(/task\.complete/);
			const t = await taskRow("hm-t-fixed");
			expect(t.done).toBe(false);
			expect(t.completedAt).toBeNull();
			expect(t.dueAt?.getTime()).toBe(ANCHOR);
		});

		test("rejects done:true on a live relative recurring task", async () => {
			await expect(
				call(
					mutators.task.update,
					{ id: "hm-owner" },
					{ id: "hm-t-rel", done: true },
				),
			).rejects.toThrow(/task\.complete/);
			expect((await taskRow("hm-t-rel")).done).toBe(false);
		});

		test("rejects adding a live rrule to an already-done task", async () => {
			await call(
				mutators.task.update,
				{ id: "hm-owner" },
				{ id: "hm-t-plain", done: true },
			);
			await expect(
				call(
					mutators.task.update,
					{ id: "hm-owner" },
					{ id: "hm-t-plain", rrule: "FREQ=DAILY", dueAt: ANCHOR },
				),
			).rejects.toThrow(/task\.complete/);
			const t = await taskRow("hm-t-plain");
			expect(t.rrule).toBeNull();
		});

		test("allows done:true on an exhausted series (valid terminal state)", async () => {
			await call(
				mutators.task.update,
				{ id: "hm-owner" },
				{ id: "hm-t-exhausted", done: true },
			);
			const t = await taskRow("hm-t-exhausted");
			expect(t.done).toBe(true);
			expect(t.completedAt).not.toBeNull();
		});

		test("allows done:true when the same write clears the rrule", async () => {
			await call(
				mutators.task.update,
				{ id: "hm-owner" },
				{ id: "hm-t-fixed", done: true, rrule: null },
			);
			const t = await taskRow("hm-t-fixed");
			expect(t.done).toBe(true);
			expect(t.rrule).toBeNull();
		});

		test("allows done:true on a plain non-recurring task", async () => {
			await call(
				mutators.task.update,
				{ id: "hm-owner" },
				{ id: "hm-t-plain", done: true },
			);
			expect((await taskRow("hm-t-plain")).done).toBe(true);
		});
	});

	describe("habit.log", () => {
		const DATE = "2026-07-14";

		test.each([
			["hm-owner", "owner"],
			["hm-admin", "admin"],
			["hm-member", "member"],
		])("%s (%s) may log", async (uid) => {
			await call(
				mutators.habit.log,
				{ id: uid },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await logRow("hm-habit", DATE)).status).toBe("done");
		});

		test.each([["hm-viewer"], ["hm-out"]])("%s is denied", async (uid) => {
			await expect(
				call(
					mutators.habit.log,
					{ id: uid },
					{ habitId: "hm-habit", date: DATE, status: "done" },
				),
			).rejects.toThrow(/access denied/);
		});

		test("done awards Karma once; re-log done does not re-award", async () => {
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(4); // habit base 3 + priority 1
			expect(await eventCount("hm-owner")).toBe(1);
			// Re-log the same (habitId, date) done: idempotent, no second award.
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(4);
			expect(await eventCount("hm-owner")).toBe(1);
		});

		test("skipped awards nothing; upsert flips status", async () => {
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "skipped" },
			);
			expect((await logRow("hm-habit", DATE)).status).toBe("skipped");
			expect(await karmaRow("hm-owner")).toBeUndefined();
			// Upsert to done on the same date now awards.
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await logRow("hm-habit", DATE)).status).toBe("done");
			expect((await karmaRow("hm-owner")).points).toBe(4);
		});

		test("bad date rejected", async () => {
			await expect(
				call(
					mutators.habit.log,
					{ id: "hm-owner" },
					{ habitId: "hm-habit", date: "2026-7-1", status: "done" },
				),
			).rejects.toThrow();
		});

		test("bad status rejected", async () => {
			await expect(
				call(
					mutators.habit.log,
					{ id: "hm-owner" },
					{
						habitId: "hm-habit",
						date: DATE,
						status: "maybe" as "done",
					},
				),
			).rejects.toThrow();
		});
	});

	describe("habit.unlog", () => {
		const DATE = "2026-07-14";

		test("previously-done unlog balances the ledger and removes the row", async () => {
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(4);
			await call(
				mutators.habit.unlog,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE },
			);
			expect(await logRow("hm-habit", DATE)).toBeUndefined();
			expect((await karmaRow("hm-owner")).points).toBe(0); // 4 award + -4 compensation
			expect(await eventCount("hm-owner")).toBe(2); // award + compensating event
		});

		test("no row -> no-op", async () => {
			await call(
				mutators.habit.unlog,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE },
			);
			expect(await karmaRow("hm-owner")).toBeUndefined();
		});
	});

	describe("focus.logSession", () => {
		test("writes an own-user row keyed to ctx.id", async () => {
			await call(
				mutators.focus.logSession,
				{ id: "hm-member" },
				{
					kind: "work",
					startedAt: ANCHOR,
					endedAt: ANCHOR + 1500_000,
					durationSec: 1500,
				},
			);
			const rows = await db
				.select()
				.from(tables.focusSession)
				.where(eq(tables.focusSession.userId, "hm-member"));
			expect(rows).toHaveLength(1);
			expect(rows[0].userId).toBe("hm-member");
			expect(rows[0].kind).toBe("work");
		});

		test("rejects durationSec <= 0 and > 24h", async () => {
			await expect(
				call(
					mutators.focus.logSession,
					{ id: "hm-member" },
					{ kind: "work", startedAt: ANCHOR, endedAt: ANCHOR, durationSec: 0 },
				),
			).rejects.toThrow();
			await expect(
				call(
					mutators.focus.logSession,
					{ id: "hm-member" },
					{
						kind: "work",
						startedAt: ANCHOR,
						endedAt: ANCHOR + DAY * 2,
						durationSec: 24 * 60 * 60 + 1,
					},
				),
			).rejects.toThrow();
		});

		test("rejects endedAt before startedAt", async () => {
			await expect(
				call(
					mutators.focus.logSession,
					{ id: "hm-member" },
					{
						kind: "work",
						startedAt: ANCHOR + 1000,
						endedAt: ANCHOR,
						durationSec: 100,
					},
				),
			).rejects.toThrow(/endedAt before startedAt/);
		});
	});

	describe("userPref.set M2 caps", () => {
		test("accepts valid karmaGoals / vacation / focus", async () => {
			await call(
				mutators.userPref.set,
				{ id: "hm-owner" },
				{
					karmaGoals: { daily: 5, weekly: 20 },
					vacation: { active: true, until: "2026-08-01" },
					focus: {
						workMin: 25,
						breakMin: 5,
						longBreakMin: 15,
						roundsPerLongBreak: 4,
						autoCycle: true,
					},
				},
			);
			const p = (
				await db
					.select()
					.from(tables.userPref)
					.where(eq(tables.userPref.id, "hm-owner"))
			)[0];
			expect(p.karmaGoals).toEqual({ daily: 5, weekly: 20 });
			expect(p.focus).toMatchObject({ workMin: 25, autoCycle: true });
		});

		test("rejects out-of-cap values with no row change", async () => {
			await call(
				mutators.userPref.set,
				{ id: "hm-member" },
				{ karmaGoals: { daily: 5, weekly: 20 } },
			);
			await expect(
				call(
					mutators.userPref.set,
					{ id: "hm-member" },
					{ karmaGoals: { daily: 5000, weekly: 20 } },
				),
			).rejects.toThrow();
			const p = (
				await db
					.select()
					.from(tables.userPref)
					.where(eq(tables.userPref.id, "hm-member"))
			)[0];
			expect(p.karmaGoals).toEqual({ daily: 5, weekly: 20 });
		});
	});

	// Regressions for the karma-inflation bugs: award-once-per-done, compensation
	// from the RECORDED delta (immune to priority change), and non-recurring
	// task.complete idempotency.
	describe("karma-inflation regressions", () => {
		const DATE = "2026-07-14";

		test("done -> skipped revokes the award, then done re-awards exactly once", async () => {
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(4);
			// Flip to skipped: award revoked, points return to the pre-award value.
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "skipped" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(0);
			expect((await logRow("hm-habit", DATE)).karmaDelta).toBe(0);
			// Flip back to done: awards once more, not doubled.
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(4);
			// Ledger: +4, -4, +4 = 4 (net one award).
			const events = await db
				.select()
				.from(tables.karmaEvent)
				.where(eq(tables.karmaEvent.userId, "hm-owner"));
			expect(events.reduce((sum, e) => sum + e.delta, 0)).toBe(4);
			expect(events).toHaveLength(3);
		});

		test("unlog compensates the recorded delta, immune to a priority change", async () => {
			// Log done at priority 3 -> award 3 base + 4 bonus = 7.
			await db
				.update(tables.task)
				.set({ priority: 3 })
				.where(eq(tables.task.id, "hm-habit"));
			await call(
				mutators.habit.log,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE, status: "done" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(7);
			expect((await logRow("hm-habit", DATE)).karmaDelta).toBe(7);
			// Priority later drops to 0; a recompute would compensate only 5 and leave
			// 2 phantom points. The recorded delta compensates the exact 7.
			await db
				.update(tables.task)
				.set({ priority: 0 })
				.where(eq(tables.task.id, "hm-habit"));
			await call(
				mutators.habit.unlog,
				{ id: "hm-owner" },
				{ habitId: "hm-habit", date: DATE },
			);
			expect((await karmaRow("hm-owner")).points).toBe(0);
			const events = await db
				.select()
				.from(tables.karmaEvent)
				.where(eq(tables.karmaEvent.userId, "hm-owner"));
			expect(events.reduce((sum, e) => sum + e.delta, 0)).toBe(0); // balanced
		});

		test("double task.complete on a non-recurring task awards exactly once", async () => {
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-plain" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(5);
			expect(await eventCount("hm-owner")).toBe(1);
			// Second call is a no-op: already done, no re-award.
			await call(
				mutators.task.complete,
				{ id: "hm-owner" },
				{ id: "hm-t-plain" },
			);
			expect((await karmaRow("hm-owner")).points).toBe(5);
			expect(await eventCount("hm-owner")).toBe(1);
		});

		test("focus.logSession rejects a duration far exceeding the timestamp span", async () => {
			await expect(
				call(
					mutators.focus.logSession,
					{ id: "hm-member" },
					{
						kind: "work",
						startedAt: ANCHOR,
						endedAt: ANCHOR + 1000, // 1s span
						durationSec: 500, // claims 500s
					},
				),
			).rejects.toThrow();
		});
	});
});
