// Integration tests for the M3a event notifications (assignment, @-mention,
// overdue). Everything asserted here is database behavior: the outbox unique
// constraint is what makes the overdue sweep idempotent per local day, the
// worker's claim is what makes a quiet-hours deferral a real deferral, and the
// ack_capability NOT NULL foreign key is what an event row must never touch.
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq, inArray } from "drizzle-orm";
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
import type { WorkerTiming } from "../../src/config/worker.ts";
import * as tables from "../../src/db/schema.ts";
import type { ProviderResult } from "../../src/domain/notification-retry.ts";
import type {
	ChannelAdapter,
	ChannelPayload,
} from "../../src/server/notifications/adapters/types.ts";
import { createSendFn } from "../../src/server/notifications/dispatch.ts";
import {
	type CollectedEvent,
	enqueueEvents,
	eventMutateSession,
	OVERDUE_LOOKBACK_MS,
	overdueSweep,
	withEventCollector,
} from "../../src/server/notifications/events.ts";
import { scanTick } from "../../src/server/notifications/scheduler.ts";
import { workerTick } from "../../src/server/notifications/worker.ts";
import { collectEvent } from "../../src/zero/event-sink.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { type Schema, schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 6 });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const OWNER = "ev-owner";
const A = "ev-a";
const B = "ev-b";
const OUT = "ev-out"; // deliberately not a member of the workspace
const EX = "ev-ex"; // a member whose membership is removed mid-test
// MULTI's display name contains a space, which a parsed handle never can: the
// common real-world case, and the one a single-token fixture hides entirely.
const MULTI = "ev-multi";
const userIds = [OWNER, A, B, OUT, EX, MULTI] as const;
const NAMES: Record<string, string> = {
	[OWNER]: "evowner",
	[A]: "eva",
	[B]: "evb",
	[OUT]: "evout",
	[EX]: "evex",
	[MULTI]: "Alice Smith",
};
const WS = "ev-w";
const LIST = "ev-list";
const HABIT_LIST = "ev-habits";
const TASK = "ev-task";
const REPLICA = "ev-replica";
const CAP = 100;

// Relative, not pinned: the worker's claim compares next_attempt_at against the
// database's own now(), so a row enqueued "now" must be genuinely due for the
// delivery tests to claim it. Tests that need a specific wall clock (quiet
// hours, the overdue local date) pass their own instant.
const NOW = new Date(Date.now() - 3_600_000);

const schedulerTiming: SchedulerTiming = {
	tickMs: 1_000,
	graceMs: 3_600_000,
	lateThresholdMs: 60_000,
};

const workerTiming: WorkerTiming = {
	tickMs: 50,
	leaseMs: 60_000,
	adapterDeadlineMs: 5_000,
	batchSize: 20,
	sendConcurrency: 10,
	retentionMs: 30 * 24 * 3_600_000,
	pruneCadenceTicks: 60,
	pruneBatchSize: 1_000,
	maxQueuedPerUser: CAP,
};

async function wipeAssignees() {
	await db
		.delete(tables.taskAssignee)
		.where(inArray(tables.taskAssignee.userId, [...userIds]));
}

async function wipeComments() {
	await db
		.delete(tables.comment)
		.where(inArray(tables.comment.authorId, [...userIds]));
}

async function wipe() {
	await db
		.delete(tables.notificationOutbox)
		.where(inArray(tables.notificationOutbox.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await wipeComments();
	await wipeAssignees();
	await db
		.delete(tables.task)
		.where(inArray(tables.task.listId, [LIST, HABIT_LIST]));
	await db
		.delete(tables.list)
		.where(inArray(tables.list.id, [LIST, HABIT_LIST]));
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

async function seedChannel(userId: string, kind: "ntfy" | "telegram") {
	await db
		.insert(tables.notificationChannel)
		.values({
			id: `ev-ch-${userId}-${kind}`,
			userId,
			kind,
			config: { serverUrl: "https://ntfy.example.test", topic: "t" },
			enabled: true,
		})
		.onConflictDoNothing();
}

async function dropChannels(userId: string) {
	await db
		.delete(tables.notificationChannel)
		.where(eq(tables.notificationChannel.userId, userId));
}

async function seedTask(
	id: string,
	fields: Partial<typeof tables.task.$inferInsert> = {},
) {
	await db
		.insert(tables.task)
		.values({ id, listId: LIST, title: `Task ${id}`, sortKey: id, ...fields })
		.onConflictDoNothing();
	return id;
}

async function setMembership(userId: string, present: boolean) {
	if (present) {
		await db
			.insert(tables.membership)
			.values({ id: `ev-m-${userId}`, userId, workspaceId: WS, role: "member" })
			.onConflictDoNothing();
	} else {
		await db
			.delete(tables.membership)
			.where(eq(tables.membership.userId, userId));
	}
}

async function outboxFor(userId: string) {
	return await db
		.select()
		.from(tables.notificationOutbox)
		.where(eq(tables.notificationOutbox.recipientUserId, userId))
		.orderBy(tables.notificationOutbox.idempotencyKey);
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

type MutCtx = { id: string };

// Exercises the collector seam only. The commit boundary and the post-request
// drain -- the parts /api/zero/mutate actually wires -- are covered against the
// production `eventMutateSession` in their own describe block below.
async function mutate<Args>(
	mutator: {
		fn: (a: {
			tx: Transaction<Schema>;
			ctx: MutCtx;
			args: Args;
		}) => Promise<void>;
	},
	callerId: string,
	args: Args,
): Promise<CollectedEvent[]> {
	const collected: CollectedEvent[] = [];
	await withEventCollector(collected, () =>
		zdb.transaction((tx) => mutator.fn({ tx, ctx: { id: callerId }, args })),
	);
	return collected;
}

// The client path: the mutator runs with no collector installed, exactly as it
// does in the browser bundle where no sink exists.
async function mutateWithoutCollector<Args>(
	mutator: {
		fn: (a: {
			tx: Transaction<Schema>;
			ctx: MutCtx;
			args: Args;
		}) => Promise<void>;
	},
	callerId: string,
	args: Args,
): Promise<void> {
	await zdb.transaction((tx) =>
		mutator.fn({ tx, ctx: { id: callerId }, args }),
	);
}

const enqueue = (collected: CollectedEvent[], now: Date = NOW) =>
	enqueueEvents(db, collected, { now, maxQueuedPerUser: CAP });

function stubAdapter(
	kind: ChannelAdapter["kind"],
	behavior: () => Promise<ProviderResult> = async () => ({
		ok: true,
		status: 200,
	}),
): { adapter: ChannelAdapter; sent: ChannelPayload[] } {
	const sent: ChannelPayload[] = [];
	return {
		sent,
		adapter: {
			kind,
			async send(_config, payload) {
				sent.push(payload);
				return await behavior();
			},
		},
	};
}

beforeAll(async () => {
	await wipe();
	await db.insert(tables.user).values(
		userIds.map((id) => ({
			id,
			name: NAMES[id],
			email: `${id}@test.invalid`,
		})),
	);
	await db.insert(tables.workspace).values({
		id: WS,
		name: "Events WS",
		ownerId: OWNER,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		[OWNER, A, B, EX, MULTI].map((userId, index) => ({
			id: `ev-m-${userId}`,
			userId,
			workspaceId: WS,
			role: index === 0 ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values([
		{
			id: LIST,
			workspaceId: WS,
			ownerId: OWNER,
			title: "Events list",
			kind: "tasks",
			sortKey: "a0",
		},
		{
			id: HABIT_LIST,
			workspaceId: WS,
			ownerId: OWNER,
			title: "Events habits",
			kind: "habits",
			sortKey: "a1",
		},
	]);
	await db
		.insert(tables.userPref)
		.values(userIds.map((id) => ({ id, timezone: "UTC" })));
});

beforeEach(async () => {
	await db
		.delete(tables.notificationOutbox)
		.where(inArray(tables.notificationOutbox.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await wipeComments();
	await wipeAssignees();
	await db
		.delete(tables.task)
		.where(inArray(tables.task.listId, [LIST, HABIT_LIST]));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	for (const id of userIds) {
		await setPref(id, { timezone: "UTC", quietHours: null, locale: null });
		await setMembership(id, id !== OUT);
	}
	await seedTask(TASK);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("assignment notifications", () => {
	test("task.assign enqueues an outbox row for the new assignee", async () => {
		await seedChannel(B, "ntfy");
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(await enqueue(collected)).toBe(1);

		const rows = await outboxFor(B);
		expect(rows).toHaveLength(1);
		expect(rows[0].reminderStateId).toBeNull();
		expect(rows[0].channelKind).toBe("ntfy");
		expect(rows[0].idempotencyKey.startsWith(`assign:${TASK}:${B}:ntfy:`)).toBe(
			true,
		);
		expect(rows[0].payload).toMatchObject({
			kind: "assign",
			taskId: TASK,
			actorUserId: A,
		});
	});

	// The recipient's stored language rides on the payload so the send path
	// renders in it without a second lookup. Only en.json exists, so every locale
	// still renders the same text: what is asserted is the locale that was
	// actually carried, not the rendered string.
	test.each([
		["a supported stored locale", "de", "de"],
		["an unsupported stored locale", "kl", "en"],
		["no stored locale", null, "en"],
	])("carries the recipient's locale on the payload for %s", async (_label, stored, expected) => {
		await seedChannel(B, "ntfy");
		await setPref(B, { locale: stored });
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(await enqueue(collected)).toBe(1);
		expect((await outboxFor(B))[0].payload).toMatchObject({
			locale: expected,
		});
	});

	test("self-assignment enqueues nothing", async () => {
		await seedChannel(A, "ntfy");
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: A,
		});
		expect(collected).toEqual([]);
		expect(await enqueue(collected)).toBe(0);
		expect(await outboxFor(A)).toEqual([]);
	});

	test("a user with two enabled channels gets two notifications", async () => {
		await seedChannel(B, "ntfy");
		await seedChannel(B, "telegram");
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(await enqueue(collected)).toBe(2);
		const rows = await outboxFor(B);
		expect(rows.map((r) => r.channelKind).sort()).toEqual(["ntfy", "telegram"]);
		expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
	});

	test("unassign then re-assign notifies again", async () => {
		await seedChannel(B, "ntfy");
		await enqueue(
			await mutate(mutators.task.assign, A, { taskId: TASK, userId: B }),
		);
		await mutate(mutators.task.unassign, A, { taskId: TASK, userId: B });
		// The first outbox row is deliberately left in place: it is retained for
		// up to 30 days and must not suppress the second assignment.
		expect(await outboxFor(B)).toHaveLength(1);

		const second = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(await enqueue(second)).toBe(1);
		expect(await outboxFor(B)).toHaveLength(2);
	});

	test("events for a user with no enabled channels enqueue nothing", async () => {
		await dropChannels(B);
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(collected).toHaveLength(1);
		expect(await enqueue(collected)).toBe(0);
		expect(await outboxFor(B)).toEqual([]);
	});

	test("a rejected assign enqueues nothing; the optimistic path is unaffected", async () => {
		await seedChannel(B, "ntfy");
		// OUT is not a member: requireWrite rejects before any write.
		const collected: CollectedEvent[] = [];
		await expect(
			withEventCollector(collected, () =>
				zdb.transaction((tx) =>
					mutators.task.assign.fn({
						tx,
						ctx: { id: OUT },
						args: { taskId: TASK, userId: B },
					}),
				),
			),
		).rejects.toThrow();
		expect(collected).toEqual([]);
		expect(await enqueue(collected)).toBe(0);
		expect(await outboxFor(B)).toEqual([]);

		// Client path: same mutator, no collector, write still applies.
		await mutateWithoutCollector(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(
			await db
				.select()
				.from(tables.taskAssignee)
				.where(eq(tables.taskAssignee.id, `${TASK}:${B}`)),
		).toHaveLength(1);
		expect(await outboxFor(B)).toEqual([]);
	});
});

describe("mention notifications", () => {
	test("an @-mention in a comment enqueues a row for the mentioned user", async () => {
		await seedChannel(B, "ntfy");
		const collected = await mutate(mutators.comment.add, A, {
			id: "ev-c1",
			taskId: TASK,
			body: `hey @${NAMES[B]} look`,
		});
		expect(await enqueue(collected)).toBe(1);
		const rows = await outboxFor(B);
		expect(rows).toHaveLength(1);
		expect(rows[0].idempotencyKey).toBe(`mention:ev-c1:${B}:ntfy`);
		expect(rows[0].payload).toMatchObject({ kind: "mention", taskId: TASK });
	});

	test("a mention of a non-member enqueues nothing", async () => {
		await seedChannel(OUT, "ntfy");
		const collected = await mutate(mutators.comment.add, A, {
			id: "ev-c2",
			taskId: TASK,
			body: `hey @${NAMES[OUT]}`,
		});
		expect(collected).toEqual([]);
		expect(await enqueue(collected)).toBe(0);
		expect(await outboxFor(OUT)).toEqual([]);
	});

	test.each([
		["first name token", "Alice"],
		["whitespace-stripped full name", "AliceSmith"],
	])("resolves a multi-word display name by %s", async (_label, handle) => {
		await seedChannel(MULTI, "ntfy");
		const collected = await mutate(mutators.comment.add, A, {
			id: `ev-cm-${handle}`,
			taskId: TASK,
			body: `ping @${handle} please`,
		});
		expect(collected.map((c) => c.recipientUserId)).toEqual([MULTI]);
		expect(await enqueue(collected)).toBe(1);
		expect(await outboxFor(MULTI)).toHaveLength(1);
	});

	test("a self-mention enqueues nothing", async () => {
		await seedChannel(A, "ntfy");
		const collected = await mutate(mutators.comment.add, A, {
			id: "ev-c3",
			taskId: TASK,
			body: `note to self @${NAMES[A]}`,
		});
		expect(collected).toEqual([]);
		expect(await outboxFor(A)).toEqual([]);
	});
});

describe("event rows and the reminder machinery", () => {
	test("the scan's sweep branches select nothing for event-only rows", async () => {
		await seedChannel(B, "ntfy");
		await enqueue(
			await mutate(mutators.task.assign, A, { taskId: TASK, userId: B }),
		);
		const before = await outboxFor(B);
		expect(before).toHaveLength(1);

		await scanTick(db, {
			now: new Date(NOW.getTime() + 3_600_000),
			timing: schedulerTiming,
		});
		// Deliberately NOT asserting scanTick's global counters: sibling test files
		// share this database, so they are only zero by scheduling accident. The
		// property that matters is scoped -- no reminder_state row exists for these
		// users to be woken, escalated or terminated, and the event row itself is
		// untouched by the scan.
		expect(
			await db
				.select()
				.from(tables.reminderState)
				.where(inArray(tables.reminderState.recipientUserId, [...userIds])),
		).toEqual([]);
		const after = await outboxFor(B);
		expect(after).toHaveLength(1);
		expect(after[0].status).toBe("queued");
		expect(after[0].attempts).toBe(0);
	});

	test("an event is delivered end to end with no ack action and no capability row", async () => {
		await seedChannel(B, "ntfy");
		await enqueue(
			await mutate(mutators.task.assign, A, { taskId: TASK, userId: B }),
		);
		const { adapter, sent } = stubAdapter("ntfy");
		const send = createSendFn({
			database: db,
			allowedPrivateCIDRs: [],
			deadlineMs: 5_000,
			ackBaseUrl: "https://app.example.test",
			adapters: { ntfy: adapter },
		});
		const summary = await workerTick(db, {
			send,
			timing: workerTiming,
			replicaId: REPLICA,
			prune: false,
		});
		expect(summary.sent).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].ackUrl).toBeNull();
		expect(sent[0].urgent).toBe(false);
		expect(sent[0].title).toBe(`Task ${TASK}`);
		expect(sent[0].body).toBe("You were assigned this task");
		expect(
			await db
				.select()
				.from(tables.ackCapability)
				.where(inArray(tables.ackCapability.recipientUserId, [...userIds])),
		).toEqual([]);
		expect((await outboxFor(B))[0].status).toBe("sent");
	});

	test("an event enqueued during quiet hours defers to the window end, then delivers", async () => {
		await seedChannel(B, "ntfy");
		// Relative to the present, never pinned: the second worker tick below
		// compares against the database's real now(), so a pinned future instant
		// would silently become a past one and the test would start failing on a
		// calendar date rather than on a regression.
		await setPref(B, { quietHours: { start: "22:00", end: "07:00" } });
		const day = new Date(Date.now() + 24 * 3_600_000);
		// 23:00Z tomorrow is inside 22:00-07:00; the window ends 07:00Z the day
		// after. Both are >= ~23h out however the suite is scheduled.
		const at = new Date(
			Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23),
		);
		const until = new Date(
			Date.UTC(
				day.getUTCFullYear(),
				day.getUTCMonth(),
				day.getUTCDate() + 1,
				7,
			),
		);
		const collected = await mutate(mutators.task.assign, A, {
			taskId: TASK,
			userId: B,
		});
		expect(await enqueue(collected, at)).toBe(1);

		const rows = await outboxFor(B);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("queued");
		expect(rows[0].nextAttemptAt.toISOString()).toBe(until.toISOString());

		const { adapter, sent } = stubAdapter("ntfy");
		const send = createSendFn({
			database: db,
			allowedPrivateCIDRs: [],
			deadlineMs: 5_000,
			ackBaseUrl: null,
			adapters: { ntfy: adapter },
		});
		// The window has not passed yet: the claim must not pick it up.
		const held = await workerTick(db, {
			send,
			timing: workerTiming,
			replicaId: REPLICA,
			prune: false,
		});
		expect(held.claimed).toBe(0);
		expect(sent).toEqual([]);

		// Advance the clock past the window end by moving the row's due time back.
		await db
			.update(tables.notificationOutbox)
			.set({ nextAttemptAt: new Date() })
			.where(eq(tables.notificationOutbox.id, rows[0].id));
		const released = await workerTick(db, {
			send,
			timing: workerTiming,
			replicaId: REPLICA,
			prune: false,
		});
		expect(released.sent).toBe(1);
		expect(sent).toHaveLength(1);
	});
});

describe("overdue sweep", () => {
	const OVERDUE = "ev-overdue";
	const DUE = new Date("2026-07-20T00:00:00Z");
	// Pinned: two ticks must land on the same local calendar day, which a
	// wall-clock-relative instant cannot guarantee near midnight.
	const SWEEP_AT = new Date("2026-07-22T10:00:00Z");

	async function seedOverdue(assignees: string[]) {
		await seedTask(OVERDUE, { dueAt: DUE, done: false });
		for (const userId of assignees) {
			await db
				.insert(tables.taskAssignee)
				.values({ id: `${OVERDUE}:${userId}`, taskId: OVERDUE, userId })
				.onConflictDoNothing();
		}
	}

	const sweep = (now: Date) => overdueSweep(db, { now, maxQueuedPerUser: CAP });

	test("enqueues one row per overdue task per assignee, and not again next tick", async () => {
		await seedChannel(A, "ntfy");
		await seedChannel(B, "ntfy");
		await seedOverdue([A, B]);

		expect((await sweep(SWEEP_AT)).enqueued).toBe(2);
		expect(await outboxFor(A)).toHaveLength(1);
		expect(await outboxFor(B)).toHaveLength(1);

		expect((await sweep(new Date(SWEEP_AT.getTime() + 60_000))).enqueued).toBe(
			0,
		);
		expect(await outboxFor(A)).toHaveLength(1);
		expect(await outboxFor(B)).toHaveLength(1);
	});

	test("a recipient with no enabled channels gets nothing", async () => {
		await dropChannels(A);
		await seedOverdue([A]);
		expect((await sweep(SWEEP_AT)).enqueued).toBe(0);
		expect(await outboxFor(A)).toEqual([]);
	});

	test("the overdue date is the recipient's local date, not UTC", async () => {
		await seedChannel(A, "ntfy");
		await setPref(A, { timezone: "Pacific/Auckland" });
		await seedOverdue([A]);

		// 12:30Z on 2026-07-22 is 00:30 on 2026-07-23 in Auckland (UTC+12).
		const first = new Date("2026-07-22T12:30:00Z");
		// 05:00Z on 2026-07-23 is 17:00 on the SAME Auckland day. A UTC-computed
		// date would treat this as a new day and notify twice.
		const second = new Date("2026-07-23T05:00:00Z");

		expect((await sweep(first)).enqueued).toBe(1);
		const rows = await outboxFor(A);
		expect(rows).toHaveLength(1);
		expect(rows[0].idempotencyKey).toBe(
			`overdue:${OVERDUE}:${A}:2026-07-23:ntfy`,
		);

		expect((await sweep(second)).enqueued).toBe(0);
		expect(await outboxFor(A)).toHaveLength(1);
	});

	test("falls back to the list owner when a task has no assignee", async () => {
		await seedChannel(OWNER, "ntfy");
		await seedOverdue([]);
		expect((await sweep(SWEEP_AT)).enqueued).toBe(1);
		const rows = await outboxFor(OWNER);
		expect(rows).toHaveLength(1);
		expect(rows[0].payload).toMatchObject({
			kind: "overdue",
			taskId: OVERDUE,
		});
	});

	test("an ex-member stops receiving overdue notices", async () => {
		await seedChannel(EX, "ntfy");
		await seedOverdue([EX]);
		expect((await sweep(SWEEP_AT)).enqueued).toBe(1);
		expect(await outboxFor(EX)).toHaveLength(1);

		// task_assignee survives the membership removal; the notify-time gate is
		// the only thing standing between an ex-member and the task title.
		await setMembership(EX, false);
		await db
			.delete(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.recipientUserId, EX));
		expect((await sweep(SWEEP_AT)).enqueued).toBe(0);
		expect(await outboxFor(EX)).toEqual([]);
	});

	test("a task overdue beyond the lookback window stops nagging", async () => {
		await seedChannel(A, "ntfy");
		await seedTask(OVERDUE, {
			dueAt: new Date(SWEEP_AT.getTime() - OVERDUE_LOOKBACK_MS - 86_400_000),
			done: false,
		});
		await db
			.insert(tables.taskAssignee)
			.values({ id: `${OVERDUE}:${A}`, taskId: OVERDUE, userId: A })
			.onConflictDoNothing();
		expect((await sweep(SWEEP_AT)).enqueued).toBe(0);
		expect(await outboxFor(A)).toEqual([]);
	});

	test("a habit is never overdue", async () => {
		await seedChannel(A, "ntfy");
		await db.insert(tables.task).values({
			id: OVERDUE,
			listId: HABIT_LIST,
			title: "Walk the dog",
			sortKey: "h0",
			dueAt: DUE,
			done: false,
		});
		await db
			.insert(tables.taskAssignee)
			.values({ id: `${OVERDUE}:${A}`, taskId: OVERDUE, userId: A })
			.onConflictDoNothing();
		expect((await sweep(SWEEP_AT)).enqueued).toBe(0);
		expect(await outboxFor(A)).toEqual([]);
	});

	test("delivers the overdue body with its due date", async () => {
		await seedChannel(A, "ntfy");
		await seedOverdue([A]);
		// SWEEP_AT, not a wall-clock-relative instant: it is in the real past so
		// the row is genuinely claimable, AND two days after DUE so the task stays
		// inside OVERDUE_LOOKBACK_MS. A `now - 1h` sweep silently stopped matching
		// 30 days after the pinned DUE and the assertion below then saw no send.
		await sweep(SWEEP_AT);
		const { adapter, sent } = stubAdapter("ntfy");
		await workerTick(db, {
			send: createSendFn({
				database: db,
				allowedPrivateCIDRs: [],
				deadlineMs: 5_000,
				ackBaseUrl: null,
				adapters: { ntfy: adapter },
			}),
			timing: workerTiming,
			replicaId: REPLICA,
			prune: false,
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].body).toBe(
			`This task is overdue (due ${DUE.toISOString()})`,
		);
	});

	test("a done task is not overdue", async () => {
		await seedChannel(A, "ntfy");
		await seedTask(OVERDUE, { dueAt: DUE, done: true });
		await db
			.insert(tables.taskAssignee)
			.values({ id: `${OVERDUE}:${A}`, taskId: OVERDUE, userId: A })
			.onConflictDoNothing();
		expect((await sweep(SWEEP_AT)).enqueued).toBe(0);
		expect(await outboxFor(A)).toEqual([]);
	});
});

// The production wiring /api/zero/mutate calls, driven directly. Driving the
// mounted route itself is not possible in this suite: handleMutateRequest
// records last-mutation IDs in Zero's own upstream tables, which this app's
// migrations do not create, so the route needs zero-cache standing up.
// eventMutateSession is therefore the boundary under test, and index.ts holds
// nothing but the two calls to it.
describe("eventMutateSession", () => {
	// Stands in for Zero's transact: runs the mutation callback, then reports the
	// outcome the real one would.
	const transactWith =
		(result: object, onRun?: () => void) =>
		async (
			callback: (tx: unknown, name: string, args: unknown) => Promise<void>,
		) => {
			onRun?.();
			await callback(null, "task|assign", {});
			return { result };
		};

	// A mutator's whole contribution is one collectEvent call, so recording the
	// intent directly is the mutator's half without dragging in task.assign's own
	// idempotence (a second call would no-op and hide a retry regression).
	async function recordAssign() {
		collectEvent({
			recipientUserId: B,
			event: {
				kind: "assign",
				taskId: TASK,
				taskTitle: `Task ${TASK}`,
				actorUserId: A,
			},
		});
	}

	test("enqueues after a mutation that committed", async () => {
		await seedChannel(B, "ntfy");
		const session = eventMutateSession(db);
		await session.run(transactWith({ data: undefined }), recordAssign);
		// Nothing is written until the request is done.
		expect(await outboxFor(B)).toEqual([]);
		await session.flush();
		expect(await outboxFor(B)).toHaveLength(1);
	});

	test("discards events when the transaction reports an error result", async () => {
		await seedChannel(B, "ntfy");
		const session = eventMutateSession(db);
		// Zero catches an error raised at COMMIT and retries with the mutator
		// skipped: the body ran, the write did not land. Announcing it would be a
		// phantom notification.
		await session.run(
			transactWith({ error: "app", message: "boom" }),
			recordAssign,
		);
		await session.flush();
		expect(await outboxFor(B)).toEqual([]);
	});

	test("discards events when transact itself rejects", async () => {
		await seedChannel(B, "ntfy");
		const session = eventMutateSession(db);
		await expect(
			session.run(async (callback) => {
				await callback(null, "task|assign", {});
				throw new Error("commit failed");
			}, recordAssign),
		).rejects.toThrow("commit failed");
		await session.flush();
		expect(await outboxFor(B)).toEqual([]);
	});

	test("a retried transaction notifies once, not twice", async () => {
		await seedChannel(B, "ntfy");
		const session = eventMutateSession(db);
		let attempts = 0;
		await session.run(async (callback) => {
			// Re-entering the callback must replace the buffer, not append to it.
			await callback(null, "task|assign", {});
			attempts++;
			await callback(null, "task|assign", {});
			attempts++;
			return { result: { data: undefined } };
		}, recordAssign);
		expect(attempts).toBe(2);
		await session.flush();
		expect(await outboxFor(B)).toHaveLength(1);
	});

	test("flush swallows an enqueue failure rather than failing the request", async () => {
		await seedChannel(B, "ntfy");
		// A pool that is closed makes every statement throw. The mutation has
		// already committed and the client already applied it, so the request must
		// still succeed.
		const brokenPool = new Pool({ connectionString: databaseURL });
		await brokenPool.end();
		const session = eventMutateSession(drizzle(brokenPool, { schema: tables }));
		await session.run(transactWith({ data: undefined }), recordAssign);
		await expect(session.flush()).resolves.toBeUndefined();
		expect(await outboxFor(B)).toEqual([]);
	});
});

describe("event payload rendering", () => {
	test("an unknown payload kind is permanently undeliverable", async () => {
		await seedChannel(B, "ntfy");
		await db.insert(tables.notificationOutbox).values({
			id: "ev-unknown",
			reminderStateId: null,
			recipientUserId: B,
			channelKind: "ntfy",
			payload: { kind: "telepathy", taskTitle: "Nope" },
			idempotencyKey: "ev-unknown-key",
			nextAttemptAt: NOW,
		});
		const { adapter, sent } = stubAdapter("ntfy");
		const summary = await workerTick(db, {
			send: createSendFn({
				database: db,
				allowedPrivateCIDRs: [],
				deadlineMs: 5_000,
				ackBaseUrl: null,
				adapters: { ntfy: adapter },
			}),
			timing: workerTiming,
			replicaId: REPLICA,
			prune: false,
		});
		expect(summary.failed).toBe(1);
		expect(sent).toEqual([]);
		expect((await outboxFor(B))[0].status).toBe("failed");
	});
});
