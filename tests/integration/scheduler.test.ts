// Integration tests for the M3a scan tick (src/server/notifications/scheduler.ts).
// Everything here runs against real Postgres: the advisory lock, the
// ON CONFLICT insert, and the sweep are all database behaviors that a mock
// would assert away. Instants are pinned rather than relative to wall-clock
// now, so a DST-sensitive expansion is reproducible.
import { and, eq, inArray, sql } from "drizzle-orm";
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
import type { SchedulerTiming } from "../../src/config/scheduler.ts";
import * as tables from "../../src/db/schema.ts";
import {
	scanTick,
	withLeaderLock,
} from "../../src/server/notifications/scheduler.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 6 });
const db = drizzle(pool, { schema: tables });

// A second, independent pool: test 7 must run two scans that the leader lock
// is NOT mediating, which needs two real connections outside one transaction.
const otherPool = new Pool({ connectionString: databaseURL, max: 2 });
const otherDb = drizzle(otherPool, { schema: tables });

const LOCK_KEY = 918274;

const OWNER = "sched-owner";
const A = "sched-a";
const B = "sched-b";
const C = "sched-c";
const FALLBACK = "sched-fallback";
const OUTSIDER = "sched-outsider";
const userIds = [OWNER, A, B, C, FALLBACK, OUTSIDER] as const;
const WS = "sched-w";
const LIST = "sched-list";

// 2026-08-01 09:00 local, expanded in the LIST OWNER's zone.
const DUE_AT = new Date("2026-08-01T12:00:00Z");
const REMINDER_TIME = "09:00";
const OCCURRENCE = new Date("2026-08-01T09:00:00Z");
const ON_TIME = new Date("2026-08-01T09:00:30Z");
const LATE = new Date("2026-08-01T09:05:00Z");
const PAST_GRACE = new Date("2026-08-01T11:00:00Z");

const timing: SchedulerTiming = {
	tickMs: 1_000,
	graceMs: 3_600_000,
	lateThresholdMs: 60_000,
};

const tick = (now: Date, overrides: Partial<SchedulerTiming> = {}) =>
	scanTick(db, { now, timing: { ...timing, ...overrides } });

async function wipeVolatile() {
	await db.execute(sql`
		delete from notification_outbox
		where recipient_user_id in (${sql.join(
			userIds.map((id) => sql`${id}`),
			sql`, `,
		)})
	`);
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await db.execute(
		sql`delete from task_assignee where task_id like 'sched-t%'`,
	);
	await db.delete(tables.task).where(eq(tables.task.listId, LIST));
}

async function wipe() {
	await wipeVolatile();
	await db.delete(tables.list).where(eq(tables.list.id, LIST));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	await db
		.delete(tables.userPref)
		.where(inArray(tables.userPref.id, [...userIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

async function setPref(
	id: string,
	fields: Partial<typeof tables.userPref.$inferInsert>,
) {
	await db
		.update(tables.userPref)
		.set(fields)
		.where(eq(tables.userPref.id, id));
}

type TaskFields = Partial<typeof tables.task.$inferInsert>;

async function seedTask(
	id: string,
	fields: TaskFields = {},
	assignees?: string[],
) {
	await db.insert(tables.task).values({
		id,
		listId: LIST,
		title: `Task ${id}`,
		sortKey: id,
		dueAt: DUE_AT,
		reminderTime: REMINDER_TIME,
		...fields,
	});
	for (const userId of assignees ?? []) {
		await db
			.insert(tables.taskAssignee)
			.values({ id: `${id}:${userId}`, taskId: id, userId });
	}
	return id;
}

const remindersFor = (taskId: string) =>
	db
		.select()
		.from(tables.reminderState)
		.where(eq(tables.reminderState.taskId, taskId));

async function outboxFor(reminderStateId: string) {
	return await db
		.select()
		.from(tables.notificationOutbox)
		.where(eq(tables.notificationOutbox.reminderStateId, reminderStateId));
}

async function advisoryHolders(key: number) {
	const { rows } = await pool.query<{ pid: number }>(
		"select pid from pg_locks where locktype = 'advisory' and classid = 0 and objid = $1 and granted",
		[key],
	);
	return rows.map((r) => r.pid);
}

beforeAll(async () => {
	await wipe();
	await db
		.insert(tables.user)
		.values(
			userIds.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
		);
	await db.insert(tables.workspace).values({
		id: WS,
		name: "Scheduler WS",
		ownerId: OWNER,
		kind: "shared",
	});
	// OUTSIDER is deliberately not a member: the escalate branch must re-check.
	await db.insert(tables.membership).values(
		[OWNER, A, B, C, FALLBACK].map((userId, index) => ({
			id: `sched-m-${userId}`,
			userId,
			workspaceId: WS,
			role: index === 0 ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: OWNER,
		title: "Scheduler list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db
		.insert(tables.userPref)
		.values(userIds.map((id) => ({ id, timezone: "UTC" })));
	await db.insert(tables.notificationChannel).values(
		userIds.map((id) => ({
			id: `sched-chan-${id}`,
			userId: id,
			kind: "ntfy" as const,
			config: { topic: `topic-${id}`, server: "https://ntfy.invalid" },
		})),
	);
});

beforeEach(async () => {
	await wipeVolatile();
	for (const id of userIds) {
		await setPref(id, {
			timezone: "UTC",
			quietHours: null,
			escalationDefaults: null,
		});
	}
});

afterAll(async () => {
	await wipe();
	await pool.end();
	await otherPool.end();
});

describe("withLeaderLock", () => {
	test("two concurrent calls produce exactly one leader", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = 0;
		const leader = withLeaderLock(pool, LOCK_KEY, async () => {
			entered++;
			await held;
			return "leader";
		});
		// Wait for the first call to be inside its callback before racing it.
		while (entered === 0) await new Promise((r) => setTimeout(r, 5));
		const loser = await withLeaderLock(pool, LOCK_KEY, async () => {
			entered++;
			return "loser";
		});
		expect(loser).toBeNull();
		release();
		expect(await leader).toBe("leader");
		expect(entered).toBe(1);
	});

	test("a throwing callback releases the lock and propagates its own error", async () => {
		await expect(
			withLeaderLock(pool, LOCK_KEY, async () => {
				throw new Error("scan blew up");
			}),
		).rejects.toThrow("scan blew up");
		expect(await advisoryHolders(LOCK_KEY)).toEqual([]);
	});

	test("the lock is held on exactly one connection for the whole section", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let observed: number[] = [];
		const running = withLeaderLock(pool, LOCK_KEY, async () => {
			observed = await advisoryHolders(LOCK_KEY);
			await held;
			return true;
		});
		release();
		await running;
		expect(observed).toHaveLength(1);
	});

	test("a completed call leaves no lock and a later call acquires", async () => {
		expect(await withLeaderLock(pool, LOCK_KEY, async () => 1)).toBe(1);
		expect(await advisoryHolders(LOCK_KEY)).toEqual([]);
		expect(await withLeaderLock(pool, LOCK_KEY, async () => 2)).toBe(2);
		expect(await advisoryHolders(LOCK_KEY)).toEqual([]);
	});
});

describe("reminder creation", () => {
	test("a due occurrence creates one reminder row and one outbox row", async () => {
		await seedTask("sched-t1", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);

		const rows = await remindersFor("sched-t1");
		expect(rows).toHaveLength(1);
		expect(rows[0].recipientUserId).toBe(OWNER);
		expect(rows[0].status).toBe("pending");
		expect(rows[0].fireCount).toBe(1);
		expect(rows[0].nextAttemptAt).not.toBeNull();
		expect(await outboxFor(rows[0].id)).toHaveLength(1);
	});

	test("a second tick over the same window is a no-op", async () => {
		await seedTask("sched-t2", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);
		const before = (await remindersFor("sched-t2"))[0];
		await tick(ON_TIME);

		const after = await remindersFor("sched-t2");
		expect(after).toHaveLength(1);
		expect(after[0].fireCount).toBe(before.fireCount);
		expect(await outboxFor(before.id)).toHaveLength(1);
	});

	test("two concurrent scans bypassing the lock still create one row", async () => {
		await seedTask("sched-t3", { repeatEveryMin: 10, maxRepeats: 2 });
		await Promise.all([
			scanTick(db, { now: ON_TIME, timing }),
			scanTick(otherDb, { now: ON_TIME, timing }),
		]);
		const rows = await remindersFor("sched-t3");
		expect(rows).toHaveLength(1);
		expect(await outboxFor(rows[0].id)).toHaveLength(1);
	});

	test("a crash between insert and enqueue leaves neither row", async () => {
		await seedTask("sched-t4", { repeatEveryMin: 10, maxRepeats: 2 });
		await scanTick(db, {
			now: ON_TIME,
			timing,
			onBeforeEnqueue: () => {
				throw new Error("simulated crash");
			},
		});
		expect(await remindersFor("sched-t4")).toHaveLength(0);
		const orphans = await db
			.select()
			.from(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.recipientUserId, OWNER));
		expect(orphans).toHaveLength(0);
	});
});

describe("quiet hours and the sweep", () => {
	test("a recipient in quiet hours is deferred, not fired", async () => {
		await setPref(OWNER, { quietHours: { start: "08:00", end: "10:00" } });
		await seedTask("sched-q1", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);

		const rows = await remindersFor("sched-q1");
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("deferred");
		expect(rows[0].deferredUntil?.toISOString()).toBe(
			"2026-08-01T10:00:00.000Z",
		);
		expect(rows[0].nextAttemptAt).toBeNull();
		expect(rows[0].fireCount).toBe(0);
		expect(await outboxFor(rows[0].id)).toHaveLength(0);
	});

	// C2 regression. The defect this replaces deleted the reminder instead.
	test("a deferred reminder fires after the window, with no escalation policy", async () => {
		await setPref(OWNER, { quietHours: { start: "08:00", end: "10:00" } });
		await seedTask("sched-q2");
		await tick(ON_TIME);
		expect((await remindersFor("sched-q2"))[0].status).toBe("deferred");

		await tick(new Date("2026-08-01T10:00:30Z"));

		const rows = await remindersFor("sched-q2");
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
		expect(rows[0].fireCount).toBe(1);
		expect(rows[0].deferredUntil).toBeNull();
		expect(await outboxFor(rows[0].id)).toHaveLength(1);
	});

	test("a reminder still in quiet hours at wake time has its deferral extended", async () => {
		await setPref(OWNER, { quietHours: { start: "08:00", end: "10:00" } });
		await seedTask("sched-q3");
		await tick(ON_TIME);

		await setPref(OWNER, { quietHours: { start: "08:00", end: "12:00" } });
		await tick(new Date("2026-08-01T10:00:30Z"));

		const rows = await remindersFor("sched-q3");
		expect(rows[0].status).toBe("deferred");
		expect(rows[0].fireCount).toBe(0);
		expect(rows[0].deferredUntil?.toISOString()).toBe(
			"2026-08-01T12:00:00.000Z",
		);
		expect(await outboxFor(rows[0].id)).toHaveLength(0);
	});

	test("an unacked reminder repeats and increments fire_count each time", async () => {
		await seedTask("sched-e1", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);
		await tick(new Date("2026-08-01T09:10:31Z"));

		const rows = await remindersFor("sched-e1");
		expect(rows).toHaveLength(1);
		expect(rows[0].fireCount).toBe(2);
		expect(rows[0].status).toBe("pending");
		const outbox = await outboxFor(rows[0].id);
		expect(outbox).toHaveLength(2);
		expect(new Set(outbox.map((o) => o.idempotencyKey)).size).toBe(2);
	});

	test("escalation hands off to the fallback exactly once, then terminates", async () => {
		await seedTask("sched-e2", {
			repeatEveryMin: 10,
			maxRepeats: 1,
			fallbackUserId: FALLBACK,
		});
		await tick(ON_TIME);
		await tick(new Date("2026-08-01T09:10:31Z"));

		const rows = await remindersFor("sched-e2");
		expect(rows).toHaveLength(2);
		const original = rows.find((r) => r.recipientUserId === OWNER);
		const sibling = rows.find((r) => r.recipientUserId === FALLBACK);
		expect(original?.status).toBe("escalated");
		expect(original?.nextAttemptAt).toBeNull();
		expect(sibling?.status).toBe("pending");
		expect(sibling?.occurrenceAt.toISOString()).toBe(OCCURRENCE.toISOString());

		// The sibling must not escalate onward to the same person.
		await tick(new Date("2026-08-01T09:30:00Z"));
		await tick(new Date("2026-08-01T09:50:00Z"));
		const after = await remindersFor("sched-e2");
		expect(after).toHaveLength(2);
		expect(after.find((r) => r.recipientUserId === FALLBACK)?.status).not.toBe(
			"escalated",
		);
	});

	// S1: memberships change between writing the preference and firing it.
	test("escalating to a non-member creates no sibling row", async () => {
		await seedTask("sched-e3", {
			repeatEveryMin: 10,
			maxRepeats: 1,
			fallbackUserId: OUTSIDER,
		});
		await tick(ON_TIME);
		await tick(new Date("2026-08-01T09:10:31Z"));

		const rows = await remindersFor("sched-e3");
		expect(rows).toHaveLength(1);
		expect(rows[0].recipientUserId).toBe(OWNER);
		expect(rows.some((r) => r.recipientUserId === OUTSIDER)).toBe(false);
		expect(rows[0].nextAttemptAt).toBeNull();
	});

	test("an acked row with a stale next_attempt_at is not swept", async () => {
		await seedTask("sched-e4", { repeatEveryMin: 10, maxRepeats: 5 });
		await tick(ON_TIME);
		const [row] = await remindersFor("sched-e4");
		await db
			.update(tables.reminderState)
			.set({
				status: "acked",
				ackedAt: ON_TIME,
				ackedVia: "in_app",
				nextAttemptAt: new Date("2026-08-01T09:01:00Z"),
			})
			.where(eq(tables.reminderState.id, row.id));

		await tick(new Date("2026-08-01T09:30:00Z"));

		const [after] = await remindersFor("sched-e4");
		expect(after.status).toBe("acked");
		expect(after.fireCount).toBe(row.fireCount);
		expect(await outboxFor(row.id)).toHaveLength(1);
	});
});

describe("late detection", () => {
	test("an occurrence older than the late threshold is flagged", async () => {
		await seedTask("sched-l1");
		await tick(LATE);
		expect((await remindersFor("sched-l1"))[0].firedLate).toBe(true);
	});

	test("an on-time occurrence is not flagged", async () => {
		await seedTask("sched-l2");
		await tick(ON_TIME);
		expect((await remindersFor("sched-l2"))[0].firedLate).toBe(false);
	});

	test("an occurrence older than the grace window is skipped entirely", async () => {
		await seedTask("sched-l3");
		await tick(PAST_GRACE);
		expect(await remindersFor("sched-l3")).toHaveLength(0);
	});
});

describe("recipients", () => {
	test("a task with no assignees notifies the list owner", async () => {
		await seedTask("sched-r1");
		await tick(ON_TIME);
		const rows = await remindersFor("sched-r1");
		expect(rows.map((r) => r.recipientUserId)).toEqual([OWNER]);
	});

	test("three assignees get three rows sharing one occurrence", async () => {
		await seedTask("sched-r2", {}, [A, B, C]);
		await tick(ON_TIME);
		const rows = await remindersFor("sched-r2");
		expect(rows.map((r) => r.recipientUserId).sort()).toEqual([A, B, C]);
		expect(new Set(rows.map((r) => r.occurrenceAt.toISOString())).size).toBe(1);
	});

	test("assignees in three zones share the list owner's occurrence", async () => {
		await setPref(OWNER, { timezone: "Pacific/Auckland" });
		await setPref(A, { timezone: "UTC" });
		await setPref(B, { timezone: "America/New_York" });
		await setPref(C, { timezone: "Asia/Tokyo" });
		await seedTask("sched-r3", {}, [A, B, C]);

		// dueAt is 12:00Z, which is already 2026-08-02 in Auckland (UTC+12), so
		// the occurrence is 09:00 on 08-02 NZST == 21:00Z on 08-01.
		const expected = "2026-08-01T21:00:00.000Z";
		await tick(new Date("2026-08-01T21:00:30Z"));

		const rows = await remindersFor("sched-r3");
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((r) => r.occurrenceAt.toISOString()))).toEqual(
			new Set([expected]),
		);
	});

	// S2: without the client-side timezone write-back, every non-UTC user's
	// reminders fire at the wrong instant, and every other test in this file
	// sets the zone directly in a fixture -- so only an explicit
	// wrong-time-must-not-fire assertion catches it.
	test("a Pacific/Auckland 08:00 reminder fires at 20:00Z, not 08:00Z", async () => {
		await setPref(OWNER, { timezone: "Pacific/Auckland" });
		await seedTask("sched-r3b", { reminderTime: "08:00" });

		// dueAt is 12:00Z == 2026-08-02 00:00 NZST, so the occurrence is
		// 2026-08-02 08:00 NZST == 2026-08-01T20:00Z. A UTC-computed expansion
		// would instead land on 2026-08-01T08:00Z, inside this first window.
		await tick(new Date("2026-08-01T08:00:30Z"));
		expect(await remindersFor("sched-r3b")).toHaveLength(0);

		await tick(new Date("2026-08-01T20:00:30Z"));
		const rows = await remindersFor("sched-r3b");
		expect(rows).toHaveLength(1);
		expect(rows[0].occurrenceAt.toISOString()).toBe("2026-08-01T20:00:00.000Z");
	});

	test("one malformed reminderTime does not stop the other tasks", async () => {
		await seedTask("sched-r4-bad", { reminderTime: "9am" });
		await seedTask("sched-r4-a");
		await seedTask("sched-r4-b");
		await seedTask("sched-r4-c");
		await tick(ON_TIME);

		expect(await remindersFor("sched-r4-bad")).toHaveLength(0);
		for (const id of ["sched-r4-a", "sched-r4-b", "sched-r4-c"]) {
			expect(await remindersFor(id)).toHaveLength(1);
		}
	});

	test("one recipient's malformed quiet hours does not stop the others", async () => {
		await setPref(B, { quietHours: { start: "notatime", end: "10:00" } });
		await seedTask("sched-r5", {}, [A, B, C]);
		await tick(ON_TIME);

		const rows = await remindersFor("sched-r5");
		expect(rows).toHaveLength(3);
		// A broken preference must never silently suppress a reminder.
		for (const row of rows) {
			expect(row.status).toBe("pending");
			expect(row.fireCount).toBe(1);
			expect(await outboxFor(row.id)).toHaveLength(1);
		}
	});

	// The third isolation point: one unresolvable escalation policy must not
	// abort the rest of the sweep.
	test("one unresolvable policy does not stop the rest of the sweep", async () => {
		await seedTask("sched-r6", { repeatEveryMin: 10, maxRepeats: 2 }, [
			A,
			B,
			C,
		]);
		await tick(ON_TIME);
		// Written straight to the column, bypassing the mutator's validation, to
		// stand in for a pref that predates it or was corrupted.
		await db
			.update(tables.userPref)
			.set({ escalationDefaults: { repeatEveryMin: "soon" } })
			.where(eq(tables.userPref.id, B));

		await tick(new Date("2026-08-01T09:10:31Z"));

		const rows = await remindersFor("sched-r6");
		const byUser = new Map(rows.map((r) => [r.recipientUserId, r]));
		expect(byUser.get(A)?.fireCount).toBe(2);
		expect(byUser.get(C)?.fireCount).toBe(2);
		expect(byUser.get(B)?.fireCount).toBe(1);
	});

	test("a recipient with no enabled channel still gets a reminder row", async () => {
		await db
			.update(tables.notificationChannel)
			.set({ enabled: false })
			.where(eq(tables.notificationChannel.userId, OWNER));
		await seedTask("sched-r7", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);

		const rows = await remindersFor("sched-r7");
		expect(rows).toHaveLength(1);
		expect(rows[0].fireCount).toBe(1);
		expect(await outboxFor(rows[0].id)).toHaveLength(0);

		await db
			.update(tables.notificationChannel)
			.set({ enabled: true })
			.where(eq(tables.notificationChannel.userId, OWNER));
	});

	test("the self-heal branch recovers a stranded row", async () => {
		await seedTask("sched-r8", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);
		const [row] = await remindersFor("sched-r8");
		await db
			.delete(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.reminderStateId, row.id));
		// The exact shape a crash between insert and enqueue would leave behind.
		await db
			.update(tables.reminderState)
			.set({ status: "pending", fireCount: 0, nextAttemptAt: null })
			.where(eq(tables.reminderState.id, row.id));

		await tick(new Date("2026-08-01T09:20:00Z"));

		const [healed] = await remindersFor("sched-r8");
		expect(healed.status).toBe("pending");
		expect(healed.fireCount).toBe(1);
		expect(await outboxFor(row.id)).toHaveLength(1);
	});

	// The insert writes next_attempt_at = now as a placeholder, so a strand can
	// carry a stale schedule rather than a null one. fire_count = 0 is what
	// makes both shapes reachable; the escalate branch requires fire_count > 0.
	test("the self-heal branch recovers a strand that kept its placeholder schedule", async () => {
		await seedTask("sched-r8b", { repeatEveryMin: 10, maxRepeats: 2 });
		await tick(ON_TIME);
		const [row] = await remindersFor("sched-r8b");
		await db
			.delete(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.reminderStateId, row.id));
		await db
			.update(tables.reminderState)
			.set({ status: "pending", fireCount: 0, nextAttemptAt: ON_TIME })
			.where(eq(tables.reminderState.id, row.id));

		await tick(new Date("2026-08-01T09:20:00Z"));

		const [healed] = await remindersFor("sched-r8b");
		expect(healed.fireCount).toBe(1);
		expect(await outboxFor(row.id)).toHaveLength(1);
	});

	test("idempotency keys carry the fire count so repeats do not collide", async () => {
		await seedTask("sched-r9", { repeatEveryMin: 10, maxRepeats: 3 });
		await tick(ON_TIME);
		const [row] = await remindersFor("sched-r9");
		await tick(new Date("2026-08-01T09:10:31Z"));
		await tick(new Date("2026-08-01T09:21:00Z"));

		const outbox = await outboxFor(row.id);
		expect(outbox.map((o) => o.idempotencyKey).sort()).toEqual([
			`${row.id}:ntfy:1`,
			`${row.id}:ntfy:2`,
			`${row.id}:ntfy:3`,
		]);
	});

	test("a done non-recurring task raises nothing", async () => {
		await seedTask("sched-r10", { done: true, completedAt: DUE_AT });
		await tick(ON_TIME);
		expect(await remindersFor("sched-r10")).toHaveLength(0);
	});

	test("a task with no reminderTime raises nothing", async () => {
		await seedTask("sched-r11", { reminderTime: null });
		await tick(ON_TIME);
		expect(await remindersFor("sched-r11")).toHaveLength(0);
	});

	test("a recurring task fires on an occurrence far from its dueAt anchor", async () => {
		await seedTask("sched-r12", {
			dueAt: new Date("2026-01-05T12:00:00Z"),
			rrule: "FREQ=DAILY",
		});
		await tick(ON_TIME);
		const rows = await remindersFor("sched-r12");
		expect(rows).toHaveLength(1);
		expect(rows[0].occurrenceAt.toISOString()).toBe(OCCURRENCE.toISOString());
	});
});

describe("scan isolation from unrelated rows", () => {
	test("a reminder in another workspace's list is untouched by role", async () => {
		await seedTask("sched-x1", { repeatEveryMin: 10, maxRepeats: 2 });
		const summary = await tick(ON_TIME);
		expect(summary.created).toBeGreaterThan(0);
		const rows = await db
			.select()
			.from(tables.reminderState)
			.where(
				and(
					eq(tables.reminderState.taskId, "sched-x1"),
					eq(tables.reminderState.recipientUserId, OUTSIDER),
				),
			);
		expect(rows).toHaveLength(0);
	});

	// task_assignee survives a membership removal, so an ex-member would keep
	// receiving reminders carrying the task title on their own push channel.
	test("an assignee who is not a member gets no reminder, their co-assignee still does", async () => {
		await seedTask("sched-x2", { repeatEveryMin: 10, maxRepeats: 2 }, [
			A,
			OUTSIDER,
		]);
		await tick(ON_TIME);

		const rows = await remindersFor("sched-x2");
		expect(rows.map((r) => r.recipientUserId)).toEqual([A]);
		expect(await outboxFor(rows[0].id)).toHaveLength(1);
	});

	// The owner fallback is the other route into the same leak: a list whose
	// owner left the workspace has no assignees to fall back from.
	test("a list owner who is not a member gets no reminder", async () => {
		await db
			.delete(tables.membership)
			.where(eq(tables.membership.userId, OWNER));
		try {
			await seedTask("sched-x3", { repeatEveryMin: 10, maxRepeats: 2 });
			await tick(ON_TIME);
			expect(await remindersFor("sched-x3")).toHaveLength(0);
		} finally {
			await db.insert(tables.membership).values({
				id: `sched-m-${OWNER}`,
				userId: OWNER,
				workspaceId: WS,
				role: "owner",
			});
		}
	});
});

// C13, corrected: a refused enqueue must terminate its reminder_state row, but
// only when the whole channel loop enqueued nothing. Marking it failed while a
// sibling channel holds a live queued row inverts the lie -- reporting a
// failure for a reminder the user is about to receive.
describe("outbox capacity refusal", () => {
	const capTick = (now: Date, maxQueuedPerUser: number) =>
		scanTick(db, { now, timing, maxQueuedPerUser });

	test("a reminder refused on every channel is terminated, not left pending", async () => {
		await seedTask("sched-cap1", {}, [A]);
		await db.insert(tables.notificationOutbox).values({
			id: "sched-cap-filler",
			recipientUserId: A,
			channelKind: "ntfy",
			payload: {},
			idempotencyKey: "sched-cap-filler",
			status: "queued",
		});

		await capTick(ON_TIME, 1);

		const [reminder] = await remindersFor("sched-cap1");
		expect(reminder.status).toBe("failed");
		expect(reminder.nextAttemptAt).toBeNull();
		expect(await outboxFor(reminder.id)).toEqual([]);
	});

	test("a reminder that reached one channel stays pending even if another is refused", async () => {
		await db.insert(tables.notificationChannel).values({
			id: "sched-chan2-a",
			userId: A,
			kind: "telegram",
			config: {},
		});
		try {
			await seedTask("sched-cap2", {}, [A]);

			await capTick(ON_TIME, 1);

			const [reminder] = await remindersFor("sched-cap2");
			expect(reminder.status).toBe("pending");
			expect(await outboxFor(reminder.id)).toHaveLength(1);
		} finally {
			await db
				.delete(tables.notificationChannel)
				.where(eq(tables.notificationChannel.id, "sched-chan2-a"));
		}
	});

	// At the cap the insert is suppressed before ON CONFLICT can fire, so a
	// re-enqueue of rows that already exist reports `refused`, not `duplicate`.
	// Deciding on the counters alone would mark this reminder failed while its
	// outbox row is queued and about to deliver.
	test("a reminder whose rows already exist is not failed by a refusal at the cap", async () => {
		await seedTask("sched-cap3", {}, [A]);
		await capTick(ON_TIME, 500);
		const [fired] = await remindersFor("sched-cap3");
		expect(await outboxFor(fired.id)).toHaveLength(1);

		// Put the reminder back into the shape the self-heal branch re-fires
		// with the same fire_count, and therefore the same idempotency key.
		await db
			.update(tables.reminderState)
			.set({ status: "pending", fireCount: 0, nextAttemptAt: ON_TIME })
			.where(eq(tables.reminderState.id, fired.id));
		await db.insert(tables.notificationOutbox).values({
			id: "sched-cap3-filler",
			recipientUserId: A,
			channelKind: "ntfy",
			payload: {},
			idempotencyKey: "sched-cap3-filler",
			status: "queued",
		});

		await capTick(ON_TIME, 2);

		const [reminder] = await remindersFor("sched-cap3");
		expect(reminder.status).not.toBe("failed");
		expect(await outboxFor(reminder.id)).toHaveLength(1);
	});
});
