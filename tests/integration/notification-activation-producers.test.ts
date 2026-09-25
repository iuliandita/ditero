import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	OVERDUE_LOOKBACK_MS,
	overdueSweep,
} from "../../src/server/notifications/events.ts";
import { scanTick } from "../../src/server/notifications/scheduler.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL, max: 5 });
const runtime = new Pool({ connectionString: databaseURL, max: 3 });
const db = drizzle(runtime, { schema: tables });
const zeroDb = zeroNodePg(schema, runtime);

const occurrence = new Date("2026-08-01T09:00:00.000Z");
const due = new Date("2026-08-01T12:00:00.000Z");
const firstTick = new Date("2026-08-01T09:00:30.000Z");
const timing = { tickMs: 1_000, graceMs: 3_600_000, lateThresholdMs: 60_000 };

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_notification_producer_test') then create role ditero_notification_producer_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_notification_producer_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_notification_producer_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_notification_producer_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at) values
		 ('owner', 'Owner', 'owner@example.test', false, now(), now()),
		 ('member', 'Member', 'member@example.test', false, now(), now()),
		 ('fallback', 'Fallback', 'fallback@example.test', false, now(), now()),
		 ('other', 'Other', 'other@example.test', false, now(), now())`,
	);
	await admin.query(
		"insert into workspace (id, name, owner_id, kind) values ('space', 'Space', 'owner', 'shared')",
	);
	await admin.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ('seat-owner', 'owner', 'space', 'owner'),
		 ('seat-member', 'member', 'space', 'member'),
		 ('seat-fallback', 'fallback', 'space', 'member')`,
	);
	await admin.query(
		"insert into list (id, workspace_id, owner_id, title, kind, sort_key) values ('list', 'space', 'owner', 'List', 'tasks', 'a0')",
	);
	await admin.query(
		"insert into user_pref (id, timezone) values ('owner', 'UTC'), ('member', 'UTC'), ('fallback', 'UTC')",
	);
	await admin.query(
		`insert into notification_channel (id, user_id, kind, config, enabled) values
		 ('channel-member', 'member', 'ntfy', '{}'::jsonb, true),
		 ('channel-fallback', 'fallback', 'ntfy', '{}'::jsonb, true),
		 ('channel-owner', 'owner', 'ntfy', '{}'::jsonb, true)`,
	);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

async function seedTask(
	id: string,
	options: {
		guarded?: "active" | "pending";
		cutoff?: Date;
		fallbackUserId?: string | null;
		assignee?: string | null;
		dueAt?: Date;
		reminderTime?: string | null;
		repeatEveryMin?: number | null;
		maxRepeats?: number | null;
		rrule?: string | null;
		recurrenceRelative?: boolean;
	} = {},
) {
	await admin.query(
		`insert into task (id, list_id, title, sort_key, due_at, reminder_time, repeat_every_min, max_repeats, fallback_user_id, rrule, recurrence_relative)
		 values ($1, 'list', $2, $1, $3, $4, $5, $6, $7, $8, $9)`,
		[
			id,
			`Task ${id}`,
			options.dueAt ?? due,
			options.reminderTime === undefined ? "09:00" : options.reminderTime,
			options.repeatEveryMin ?? null,
			options.maxRepeats ?? null,
			options.fallbackUserId ?? null,
			options.rrule ?? null,
			options.recurrenceRelative ?? false,
		],
	);
	if (options.assignee !== null) {
		const userId = options.assignee ?? "member";
		await admin.query(
			"insert into task_assignee (id, task_id, user_id) values ($1, $2, $3)",
			[`${id}:${userId}`, id, userId],
		);
	}
	if (options.guarded) {
		const cutoff = options.cutoff ?? new Date("2026-07-01T00:00:00.000Z");
		if (options.guarded === "active") {
			await admin.query(
				`insert into task_notification_activation (task_id, status, generation, import_occurrence_cutoff, recipient_generation_cutoff, completion_mode)
				 values ($1, 'active', 1, $2, $2, 'import')`,
				[id, cutoff],
			);
			await admin.query(
				"insert into task_notification_recipient (task_id, user_id, active, generation, cutoff) values ($1, $2, true, 1, $3)",
				[id, options.assignee ?? "member", cutoff],
			);
		} else {
			await admin.query(
				"insert into task_notification_activation (task_id, status, generation) values ($1, 'pending', 1)",
				[id],
			);
		}
	}
}

async function states(taskId: string) {
	return (
		await admin.query<{
			id: string;
			recipient_user_id: string;
			status: string;
			fire_count: number;
		}>(
			"select id, recipient_user_id, status, fire_count from reminder_state where task_id = $1 order by recipient_user_id",
			[taskId],
		)
	).rows;
}

async function outbox(taskId: string) {
	return (
		await admin.query<{
			idempotency_key: string;
			payload: { taskTitle: string };
		}>(
			"select idempotency_key, payload from notification_outbox where payload->>'taskId' = $1 order by idempotency_key",
			[taskId],
		)
	).rows;
}

test("restricted producer scan admits native and active guard, excludes pending and pre-cutoff", async () => {
	const identity = await db.execute<{
		role: string;
		rolbypassrls: boolean;
	}>(sql`
		select current_user as role, rolbypassrls from pg_roles where rolname = current_user
	`);
	expect(identity.rows[0]).toEqual({
		role: "ditero_notification_producer_test",
		rolbypassrls: false,
	});
	await seedTask("native");
	await seedTask("active", { guarded: "active" });
	await seedTask("pending", { guarded: "pending" });
	await seedTask("old", {
		guarded: "active",
		cutoff: new Date("2026-08-02T00:00:00Z"),
	});
	const result = await scanTick(db, { now: firstTick, timing });
	expect(result.created).toBe(2);
	expect((await states("native")).map((row) => row.recipient_user_id)).toEqual([
		"member",
	]);
	expect((await states("active")).map((row) => row.recipient_user_id)).toEqual([
		"member",
	]);
	expect(await states("pending")).toEqual([]);
	expect(await states("old")).toEqual([]);
	expect(await outbox("active")).toHaveLength(1);
});

test("native empty and whitespace task IDs still create reminders", async () => {
	for (const id of ["", "  "]) await seedTask(id);
	const result = await scanTick(db, { now: firstTick, timing });
	expect(result.created).toBe(2);
	for (const id of ["", "  "]) {
		expect((await states(id)).map((row) => row.recipient_user_id)).toEqual([
			"member",
		]);
		expect(await outbox(id)).toHaveLength(1);
	}
});

test("native empty and whitespace task IDs still enqueue overdue events", async () => {
	for (const id of ["", "  "])
		await seedTask(id, {
			dueAt: new Date("2026-08-01T08:00:00Z"),
			reminderTime: null,
		});
	const result = await overdueSweep(db, { now: firstTick });
	expect(result).toEqual({ scanned: 2, enqueued: 2 });
	for (const id of ["", "  "]) expect(await outbox(id)).toHaveLength(1);
});

test("guarded fixed and relative recurrences fire from historical anchors but not future anchors", async () => {
	await seedTask("fixed-history", {
		guarded: "active",
		dueAt: new Date("2026-01-05T12:00:00Z"),
		rrule: "FREQ=DAILY",
	});
	await seedTask("fixed-future", {
		guarded: "active",
		dueAt: new Date("2026-08-02T12:00:00Z"),
		rrule: "FREQ=DAILY",
	});
	await seedTask("relative-history", {
		guarded: "active",
		dueAt: new Date("2026-01-05T12:00:00Z"),
		rrule: "FREQ=DAILY",
		recurrenceRelative: true,
	});
	await seedTask("relative-future", {
		guarded: "active",
		dueAt: new Date("2026-08-02T12:00:00Z"),
		rrule: "FREQ=DAILY",
		recurrenceRelative: true,
	});
	const summary = await scanTick(db, { now: firstTick, timing });
	expect(summary.created).toBe(2);
	for (const id of ["fixed-history", "relative-history"]) {
		expect(await states(id)).toHaveLength(1);
		expect(await outbox(id)).toHaveLength(1);
	}
	for (const id of ["fixed-future", "relative-future"]) {
		expect(await states(id)).toEqual([]);
		expect(await outbox(id)).toEqual([]);
	}
});

test("guarded recurrence keeps a DST fall-back occurrence at the grace boundary", async () => {
	await admin.query(
		"update user_pref set timezone = 'Europe/Bucharest' where id = 'owner'",
	);
	for (const [id, relative] of [
		["dst-fixed", false],
		["dst-relative", true],
	] as const) {
		await seedTask(id, {
			guarded: "active",
			dueAt: new Date("2026-10-24T21:00:00Z"),
			reminderTime: "23:59",
			rrule: "FREQ=WEEKLY",
			recurrenceRelative: relative,
			cutoff: new Date("2026-10-01T00:00:00Z"),
		});
	}
	const now = new Date("2026-10-25T21:59:30Z");
	const summary = await scanTick(db, {
		now,
		timing: { ...timing, graceMs: 30_000 },
	});
	expect(summary.created).toBe(2);
	for (const id of ["dst-fixed", "dst-relative"]) {
		const row = (
			await admin.query<{ occurrence_at: Date }>(
				"select occurrence_at from reminder_state where task_id = $1",
				[id],
			)
		).rows[0];
		expect(row.occurrence_at.toISOString()).toBe("2026-10-25T21:59:00.000Z");
		expect(await outbox(id)).toHaveLength(1);
	}
});

test("creation retries a changed unseen preference target inside the same grace window", async () => {
	await seedTask("retry-grace", { guarded: "active" });
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"fallback\"}'::jsonb where id = 'member'",
	);
	let discoveries = 0;
	const summary = await scanTick(db, {
		now: firstTick,
		timing: { ...timing, graceMs: 30_000 },
		onAfterAuthorityDiscovery: async () => {
			if (++discoveries === 1) {
				await admin.query(
					"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
				);
			}
		},
	});
	expect(discoveries).toBe(2);
	expect(summary).toMatchObject({
		created: 1,
		fired: 1,
		enqueued: 1,
		skippedRecipients: 0,
	});
	expect(await outbox("retry-grace")).toHaveLength(1);
});

test("overdue retries a changed unseen preference target at the lookback boundary", async () => {
	const lastEligibleDue = new Date(firstTick.getTime() - OVERDUE_LOOKBACK_MS);
	await seedTask("retry-lookback", {
		guarded: "active",
		dueAt: lastEligibleDue,
		reminderTime: null,
	});
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"fallback\"}'::jsonb where id = 'member'",
	);
	let discoveries = 0;
	const summary = await overdueSweep(db, {
		now: firstTick,
		onAfterAuthorityDiscovery: async () => {
			if (++discoveries === 1) {
				await admin.query(
					"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
				);
			}
		},
	});
	expect(discoveries).toBe(2);
	expect(summary).toEqual({ scanned: 1, enqueued: 1 });
	expect(await outbox("retry-lookback")).toHaveLength(1);
});

test("guarded quiet-hours wake and self-heal use current preference", async () => {
	await seedTask("quiet", { guarded: "active" });
	await admin.query(
		'update user_pref set quiet_hours = \'{"start":"08:00","end":"10:00"}\'::jsonb where id = \'member\'',
	);
	await scanTick(db, { now: firstTick, timing });
	expect((await states("quiet"))[0]?.status).toBe("deferred");
	await admin.query(
		"update user_pref set quiet_hours = null where id = 'member'",
	);
	await scanTick(db, { now: new Date("2026-08-01T10:00:01Z"), timing });
	expect((await states("quiet"))[0]).toMatchObject({
		status: "pending",
		fire_count: 1,
	});
	expect(await outbox("quiet")).toHaveLength(1);
	await seedTask("heal", { guarded: "active" });
	await admin.query(
		"insert into reminder_state (id, task_id, occurrence_at, recipient_user_id, status, fire_count, next_attempt_at) values ('heal-state', 'heal', $1, 'member', 'pending', 0, $2)",
		[occurrence, firstTick],
	);
	await scanTick(db, { now: new Date("2026-08-01T09:01:00Z"), timing });
	expect((await states("heal"))[0]).toMatchObject({
		status: "pending",
		fire_count: 1,
	});
});

test("a recipient generation cutoff suppresses a previously deferred occurrence", async () => {
	await seedTask("cutoff-wake", { guarded: "active" });
	await admin.query(
		"insert into reminder_state (id, task_id, occurrence_at, recipient_user_id, status, fire_count, deferred_until) values ('cutoff-state', 'cutoff-wake', $1, 'member', 'deferred', 0, $2)",
		[occurrence, firstTick],
	);
	await admin.query(
		"update task_notification_recipient set cutoff = '2026-08-02T00:00:00Z' where task_id = 'cutoff-wake' and user_id = 'member'",
	);
	await scanTick(db, { now: firstTick, timing });
	expect((await states("cutoff-wake"))[0]).toMatchObject({
		status: "deferred",
		fire_count: 0,
	});
	expect(await outbox("cutoff-wake")).toEqual([]);
});

test("repeat and preference fallback use locked policy; old target stops after preference change", async () => {
	await seedTask("repeat", {
		guarded: "active",
		repeatEveryMin: 1,
		maxRepeats: 2,
	});
	await scanTick(db, { now: firstTick, timing });
	await scanTick(db, { now: new Date("2026-08-01T09:01:31Z"), timing });
	expect((await states("repeat"))[0]?.fire_count).toBe(2);
	expect(await outbox("repeat")).toHaveLength(2);
	await seedTask("fallback", {
		guarded: "active",
		repeatEveryMin: 1,
		maxRepeats: 1,
	});
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"fallback\"}'::jsonb where id = 'member'",
	);
	await scanTick(db, { now: firstTick, timing });
	await scanTick(db, { now: new Date("2026-08-01T09:01:31Z"), timing });
	expect(
		(await states("fallback")).map((row) => [
			row.recipient_user_id,
			row.status,
		]),
	).toEqual([
		["fallback", "pending"],
		["member", "escalated"],
	]);
	expect(await outbox("fallback")).toHaveLength(2);
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
	);
	await scanTick(db, { now: new Date("2026-08-01T09:02:32Z"), timing });
	expect(await outbox("fallback")).toHaveLength(2);
});

test("fallback handoff revalidates preference changes between its two transactions", async () => {
	await seedTask("handoff", {
		guarded: "active",
		repeatEveryMin: 1,
		maxRepeats: 1,
	});
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"fallback\"}'::jsonb where id = 'member'",
	);
	await scanTick(db, { now: firstTick, timing });
	await scanTick(db, {
		now: new Date("2026-08-01T09:01:31Z"),
		timing,
		onBeforeFallbackHandoff: async () => {
			await admin.query(
				"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
			);
		},
	});
	expect(
		(await states("handoff")).map((row) => [row.recipient_user_id, row.status]),
	).toEqual([["member", "pending"]]);
	expect(await outbox("handoff")).toHaveLength(1);
});

test("task-level fallback overrides a different preference target", async () => {
	await seedTask("task-fallback", {
		guarded: "active",
		repeatEveryMin: 1,
		maxRepeats: 1,
		fallbackUserId: "fallback",
	});
	await admin.query(
		"update user_pref set escalation_defaults = '{\"fallbackUserId\":\"other\"}'::jsonb where id = 'member'",
	);
	await scanTick(db, { now: firstTick, timing });
	await scanTick(db, { now: new Date("2026-08-01T09:01:31Z"), timing });
	expect(
		(await states("task-fallback")).map((row) => row.recipient_user_id),
	).toEqual(["fallback", "member"]);
});

test("overdue suppression precedes scan limit and a changed due instant becomes eligible", async () => {
	await seedTask("overdue", {
		guarded: "active",
		dueAt: new Date("2026-08-01T08:00:00Z"),
		reminderTime: null,
	});
	await admin.query(
		"update task_notification_recipient set overdue_suppressed_due_at = '2026-08-01T08:00:00Z' where task_id = 'overdue'",
	);
	await seedTask("native-overdue", {
		dueAt: new Date("2026-08-01T08:00:00Z"),
		reminderTime: null,
	});
	const first = await overdueSweep(db, { now: firstTick });
	expect(first.scanned).toBe(1);
	expect(await outbox("overdue")).toEqual([]);
	expect(await outbox("native-overdue")).toHaveLength(1);
	await admin.query(
		"update task set due_at = '2026-08-01T08:30:00Z' where id = 'overdue'",
	);
	const second = await overdueSweep(db, { now: firstTick });
	expect(second.scanned).toBe(2);
	expect(await outbox("overdue")).toHaveLength(1);
});

test("5,000 earlier suppressed guards do not consume the overdue scan limit", async () => {
	await admin.query(`insert into task (id, list_id, title, sort_key, due_at)
		select 'bulk-' || i, 'list', 'Suppressed', 'bulk-' || i, '2026-08-01T07:00:00Z'::timestamptz
		from generate_series(1, 5000) i`);
	await admin.query(`insert into task_assignee (id, task_id, user_id)
		select id || ':member', id, 'member' from task where id like 'bulk-%'`);
	await admin.query(`insert into task_notification_activation
		(task_id, status, generation, import_occurrence_cutoff, recipient_generation_cutoff, completion_mode)
		select id, 'active', 1, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'import'
		from task where id like 'bulk-%'`);
	await admin.query(`insert into task_notification_recipient
		(task_id, user_id, active, generation, cutoff, overdue_suppressed_due_at)
		select id, 'member', true, 1, '2026-07-01T00:00:00Z', due_at
		from task where id like 'bulk-%'`);
	await seedTask("eligible-after-bulk", {
		dueAt: new Date("2026-08-01T08:00:00Z"),
		reminderTime: null,
	});
	const summary = await overdueSweep(db, { now: firstTick });
	expect(summary.scanned).toBe(1);
	expect(await outbox("eligible-after-bulk")).toHaveLength(1);
}, 30_000);

test("an unassigned former list owner cannot receive overdue task details", async () => {
	await seedTask("unassigned", {
		assignee: null,
		dueAt: new Date("2026-08-01T08:00:00Z"),
		reminderTime: null,
	});
	await admin.query("delete from membership where id = 'seat-owner'");
	const summary = await overdueSweep(db, { now: firstTick });
	expect(summary.scanned).toBe(0);
	expect(await outbox("unassigned")).toEqual([]);
});

type ProducerPath = "create" | "wake" | "repeat" | "fallback" | "overdue";

async function setupPath(path: ProducerPath) {
	await seedTask(path, {
		guarded: "active",
		dueAt: path === "overdue" ? new Date("2026-08-01T08:00:00Z") : due,
		reminderTime: path === "overdue" ? null : "09:00",
		repeatEveryMin: path === "repeat" || path === "fallback" ? 1 : null,
		maxRepeats: path === "repeat" ? 2 : path === "fallback" ? 1 : null,
		fallbackUserId: path === "fallback" ? "fallback" : null,
	});
	if (path === "wake") {
		await admin.query(
			"insert into reminder_state (id, task_id, occurrence_at, recipient_user_id, status, fire_count, deferred_until) values ('wake-state', 'wake', $1, 'member', 'deferred', 0, $2)",
			[occurrence, firstTick],
		);
	} else if (path === "repeat" || path === "fallback") {
		await admin.query(
			"insert into reminder_state (id, task_id, occurrence_at, recipient_user_id, status, fire_count, next_attempt_at) values ($1, $2, $3, 'member', 'pending', 1, $4)",
			[`${path}-state`, path, occurrence, firstTick],
		);
	}
}

async function runPath(
	path: ProducerPath,
	barrier?: (
		tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	) => Promise<void>,
) {
	if (path === "overdue")
		return overdueSweep(db, {
			now: firstTick,
			onBeforeOverdueEnqueue: barrier,
		});
	return scanTick(db, { now: firstTick, timing, onBeforeEnqueue: barrier });
}

async function blockingPids(pid: number): Promise<number[]> {
	return (
		(
			await admin.query<{ blockers: number[] }>(
				"select pg_blocking_pids($1) as blockers",
				[pid],
			)
		).rows[0]?.blockers ?? []
	);
}

async function waitForBlocker(pid: number, expected: number) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if ((await blockingPids(pid)).includes(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`PID ${pid} was not blocked by ${expected}`);
}

async function activeProducerPid(blockedBy: number): Promise<number> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const result = await admin.query<{ pid: number; blockers: number[] }>(
			`select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
			 where state = 'active'`,
		);
		const found = result.rows.find((row) => row.blockers.includes(blockedBy));
		if (found) return found.pid;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`No producer was blocked by PID ${blockedBy}`);
}

for (const path of [
	"create",
	"wake",
	"repeat",
	"fallback",
	"overdue",
] as const) {
	test(`${path} waits behind an earlier task writer and rechecks done`, async () => {
		await setupPath(path);
		const writer = await admin.connect();
		let running: Promise<unknown> | undefined;
		try {
			await writer.query("begin");
			const writerPid = (
				await writer.query<{ pid: number }>("select pg_backend_pid() as pid")
			).rows[0].pid;
			await writer.query("update task set done = true where id = $1", [path]);
			running = runPath(path);
			const producerPid = await activeProducerPid(writerPid);
			expect(await blockingPids(producerPid)).toContain(writerPid);
			await writer.query("commit");
			await running;
			expect(await outbox(path)).toEqual([]);
		} finally {
			await writer.query("rollback").catch(() => {});
			writer.release();
			await running?.catch(() => {});
		}
	});

	test(`${path} holds task authority through enqueue while a later writer waits`, async () => {
		await setupPath(path);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: (pid: number) => void;
		const started = new Promise<number>((resolve) => {
			entered = resolve;
		});
		const producer = runPath(path, async (tx) => {
			const pid = (
				await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
			).rows[0]?.pid;
			if (!pid) throw new Error("Missing producer PID");
			entered(pid);
			await held;
		});
		const writer = await admin.connect();
		let writing: Promise<unknown> | undefined;
		try {
			const producerPid = await Promise.race([
				started,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("Producer did not reach enqueue")),
						5_000,
					),
				),
			]);
			await writer.query("begin");
			const writerPid = (
				await writer.query<{ pid: number }>("select pg_backend_pid() as pid")
			).rows[0].pid;
			writing = writer.query("update task set done = true where id = $1", [
				path,
			]);
			await waitForBlocker(writerPid, producerPid);
			release();
			await producer;
			await writing;
			await writer.query("commit");
			expect(await outbox(path)).toHaveLength(1);
		} finally {
			release();
			await writing?.catch(() => {});
			await writer.query("rollback").catch(() => {});
			writer.release();
			await producer.catch(() => {});
		}
	});
}

type ActualWriter = "complete" | "assign" | "remove-member";
async function actualWriter(
	kind: ActualWriter,
	holding?: (pid: number) => Promise<void>,
) {
	return zeroDb.transaction((tx) =>
		withZeroUserContext(tx, "owner", async () => {
			if (kind === "complete") {
				await mutators.task.complete.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "actual" },
				});
			} else if (kind === "assign") {
				await mutators.task.assign.fn({
					tx,
					ctx: { id: "owner" },
					args: { taskId: "actual", userId: "fallback" },
				});
			} else {
				await mutators.membership.remove.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "seat-member" },
				});
			}
			if (holding) {
				const rows = Array.from(
					await tx.dbTransaction.query("select pg_backend_pid() as pid", []),
				);
				await holding(Number(rows[0]?.pid));
			}
		}),
	);
}

function transactionBarrier() {
	let release!: () => void;
	let entered!: (pid: number) => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<number>((resolve) => {
		entered = resolve;
	});
	return {
		release,
		async hold(pid: number) {
			entered(pid);
			await held;
		},
		async pid() {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					started,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error("Transaction did not reach its barrier")),
							5000,
						);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

for (const kind of ["complete", "assign", "remove-member"] as const) {
	test(`actual ${kind} commits before scanTick rechecks eligibility`, async () => {
		await seedTask("actual", { guarded: "active" });
		const barrier = transactionBarrier();
		const writing = actualWriter(kind, barrier.hold);
		let producing: Promise<unknown> | undefined;
		try {
			const writerPid = await barrier.pid();
			producing = scanTick(db, { now: firstTick, timing });
			const producerPid = await activeProducerPid(writerPid);
			expect(await blockingPids(producerPid)).toContain(writerPid);
			barrier.release();
			await writing;
			await producing;
			expect(await outbox("actual")).toEqual([]);
		} finally {
			barrier.release();
			await writing.catch(() => {});
			await producing?.catch(() => {});
		}
	});

	test(`scanTick enqueue commits before actual ${kind} invalidates its evidence`, async () => {
		await seedTask("actual", { guarded: "active" });
		const barrier = transactionBarrier();
		const producing = scanTick(db, {
			now: firstTick,
			timing,
			onBeforeEnqueue: async (tx) => {
				const rows = await tx.execute<{ pid: number }>(
					sql`select pg_backend_pid() as pid`,
				);
				await barrier.hold(rows.rows[0].pid);
			},
		});
		let writing: Promise<unknown> | undefined;
		try {
			const producerPid = await barrier.pid();
			writing = actualWriter(kind);
			const writerPid = await activeProducerPid(producerPid);
			expect(await blockingPids(writerPid)).toContain(producerPid);
			barrier.release();
			await producing;
			await writing;
			expect(await outbox("actual")).toHaveLength(1);
		} finally {
			barrier.release();
			await producing.catch(() => {});
			await writing?.catch(() => {});
		}
	});
}
