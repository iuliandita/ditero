// Integration tests for the M3a outbox worker (src/server/notifications/worker.ts).
// Every property under test is a database behavior: SKIP LOCKED partitioning,
// the lease reclaim, and the claimed_by completion fence all disappear under a
// mock. Two independent pools stand in for two replicas.
import { eq, inArray, sql } from "drizzle-orm";
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
import type { WorkerTiming } from "../../src/config/worker.ts";
import * as tables from "../../src/db/schema.ts";
import type { ProviderResult } from "../../src/domain/notification-retry.ts";
import { MAX_ATTEMPTS } from "../../src/domain/notification-retry.ts";
import {
	claimBatch,
	completeDelivery,
	enqueueOutbox,
	pruneTerminal,
	reclaimExpired,
	type SendFn,
	workerTick,
} from "../../src/server/notifications/worker.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 6 });
const db = drizzle(pool, { schema: tables });
// Replica B: the SKIP LOCKED partition test needs two real connections
// claiming at once, which one pooled client cannot express.
const otherPool = new Pool({ connectionString: databaseURL, max: 6 });
const otherDb = drizzle(otherPool, { schema: tables });

const OWNER = "wk-owner";
const OTHER = "wk-other";
const userIds = [OWNER, OTHER] as const;
const WS = "wk-w";
const LIST = "wk-list";
const TASK = "wk-task";
const OCCURRENCE = new Date("2026-08-01T09:00:00Z");

const A = "worker-a";
const B = "worker-b";

const timing: WorkerTiming = {
	tickMs: 50,
	leaseMs: 60_000,
	adapterDeadlineMs: 15_000,
	batchSize: 20,
	retentionMs: 30 * 24 * 3_600_000,
	maxQueuedPerUser: 500,
};

const ok: ProviderResult = { ok: true, status: 200 };
const retryable: ProviderResult = { ok: false, status: 503, error: "boom" };
const permanent: ProviderResult = { ok: false, status: 403, error: "nope" };

const sendOk: SendFn = async () => ok;

async function wipeVolatile() {
	await db
		.delete(tables.notificationOutbox)
		.where(inArray(tables.notificationOutbox.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
}

async function wipe() {
	await wipeVolatile();
	await db.delete(tables.task).where(eq(tables.task.id, TASK));
	await db.delete(tables.list).where(eq(tables.list.id, LIST));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

type OutboxFields = Partial<typeof tables.notificationOutbox.$inferInsert>;

async function seedOutbox(id: string, fields: OutboxFields = {}) {
	await db.insert(tables.notificationOutbox).values({
		id,
		recipientUserId: OWNER,
		channelKind: "ntfy",
		payload: { kind: "reminder", taskId: TASK },
		idempotencyKey: id,
		status: "queued",
		nextAttemptAt: new Date(Date.now() - 1_000),
		...fields,
	});
	return id;
}

async function seedReminder(id: string) {
	await db.insert(tables.reminderState).values({
		id,
		taskId: TASK,
		occurrenceAt: OCCURRENCE,
		recipientUserId: OWNER,
		status: "pending",
		fireCount: 1,
	});
	return id;
}

async function outbox(id: string) {
	const rows = await db
		.select()
		.from(tables.notificationOutbox)
		.where(eq(tables.notificationOutbox.id, id));
	if (rows.length !== 1) throw new Error(`outbox row ${id} not found`);
	return rows[0];
}

async function attemptsFor(id: string) {
	return await db
		.select()
		.from(tables.deliveryAttempt)
		.where(eq(tables.deliveryAttempt.outboxId, id))
		.orderBy(tables.deliveryAttempt.attemptNo);
}

// The claim query is time-driven, so tests move the clock by moving the row.
async function backdateClaim(id: string, ms: number) {
	await db.execute(sql`
		update notification_outbox
		set claimed_at = now() - make_interval(secs => ${ms / 1000})
		where id = ${id}
	`);
}

async function makeDue(id: string) {
	await db
		.update(tables.notificationOutbox)
		.set({ nextAttemptAt: new Date(Date.now() - 1_000) })
		.where(eq(tables.notificationOutbox.id, id));
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
		name: "Worker WS",
		ownerId: OWNER,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		userIds.map((userId, index) => ({
			id: `wk-m-${userId}`,
			userId,
			workspaceId: WS,
			role: index === 0 ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: OWNER,
		title: "Worker list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: TASK,
		listId: LIST,
		title: "Worker task",
		sortKey: "a0",
	});
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
	await otherPool.end();
});

describe("claiming", () => {
	test("two concurrent workers partition the outbox with no overlap and none missed", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push(await seedOutbox(`wk-c-${i}`));

		const [first, second] = await Promise.all([
			claimBatch(db, 10, A),
			claimBatch(otherDb, 10, B),
		]);

		const claimedA = first.map((row) => row.id);
		const claimedB = second.map((row) => row.id);
		expect(claimedA.filter((id) => claimedB.includes(id))).toEqual([]);
		expect([...claimedA, ...claimedB].sort()).toEqual([...ids].sort());
	});

	test("a claimed row is invisible to a second claimer while sending", async () => {
		await seedOutbox("wk-c-solo");

		const first = await claimBatch(db, 10, A);
		expect(first.map((row) => row.id)).toEqual(["wk-c-solo"]);
		expect((await outbox("wk-c-solo")).status).toBe("sending");

		expect(await claimBatch(db, 10, B)).toEqual([]);
	});
});

describe("lease and fencing", () => {
	test("a row stuck in sending past the lease is reclaimed", async () => {
		await seedOutbox("wk-l-stuck");
		await claimBatch(db, 10, A);
		await backdateClaim("wk-l-stuck", 120_000);

		const result = await reclaimExpired(db, 60_000);

		expect(result.reclaimed).toBe(1);
		const row = await outbox("wk-l-stuck");
		expect(row.status).toBe("queued");
		expect(row.claimedBy).toBeNull();
		expect(row.claimedAt).toBeNull();
	});

	test("a row within its lease is not reclaimed", async () => {
		await seedOutbox("wk-l-fresh");
		await claimBatch(db, 10, A);

		const result = await reclaimExpired(db, 60_000);

		expect(result).toEqual({ reclaimed: 0, abandoned: 0 });
		const row = await outbox("wk-l-fresh");
		expect(row.status).toBe("sending");
		expect(row.claimedBy).toBe(A);
	});

	// C11: without the claimed_by fence, A's late completion overwrites B's
	// terminal state and resurrects the row for a third delivery.
	test("a worker whose row was reclaimed mid-send cannot modify it on completion", async () => {
		await seedOutbox("wk-f-race");

		const [claimedByA] = await claimBatch(db, 10, A);
		await backdateClaim("wk-f-race", 120_000);
		await reclaimExpired(db, 60_000);

		const [claimedByB] = await claimBatch(otherDb, 10, B);
		expect((await completeDelivery(otherDb, claimedByB, ok, B)).applied).toBe(
			true,
		);

		// A finally comes back from its hung send.
		expect((await completeDelivery(db, claimedByA, retryable, A)).applied).toBe(
			false,
		);

		const row = await outbox("wk-f-race");
		expect(row.status).toBe("sent");
		expect(row.attempts).toBe(2);
		const written = await attemptsFor("wk-f-race");
		expect(written.map((a) => a.attemptNo)).toEqual([2]);
		expect(written[0].retryClass).toBe("ok");
	});

	// C12: without the increment, this loop never terminates and the user is
	// notified once per lease interval forever from a single row.
	test("reclaim increments attempts, so a permanently hanging provider is abandoned", async () => {
		await seedOutbox("wk-f-hang");

		let abandoned = 0;
		for (let cycle = 0; cycle < MAX_ATTEMPTS + 1; cycle++) {
			const claimed = await claimBatch(db, 10, A);
			if (claimed.length === 0) break;
			await backdateClaim("wk-f-hang", 120_000);
			abandoned += (await reclaimExpired(db, 60_000)).abandoned;
			await makeDue("wk-f-hang");
		}

		expect(abandoned).toBe(1);
		const row = await outbox("wk-f-hang");
		expect(row.status).toBe("abandoned");
		expect(row.attempts).toBe(MAX_ATTEMPTS);
		expect(await claimBatch(db, 10, A)).toEqual([]);
	});
});

describe("retry", () => {
	test("a retryable failure increments attempts and schedules a future retry", async () => {
		await seedOutbox("wk-r-retry");
		const before = Date.now();

		const summary = await workerTick(db, {
			send: async () => retryable,
			timing,
			replicaId: A,
		});

		expect(summary.retried).toBe(1);
		const row = await outbox("wk-r-retry");
		expect(row.status).toBe("queued");
		expect(row.attempts).toBe(1);
		expect(row.claimedBy).toBeNull();
		expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before);
	});

	test("a permanent failure is terminal and never retried", async () => {
		await seedOutbox("wk-r-perm");

		await workerTick(db, { send: async () => permanent, timing, replicaId: A });

		const row = await outbox("wk-r-perm");
		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(1);
		expect(await claimBatch(db, 10, A)).toEqual([]);

		const second = await workerTick(db, { send: sendOk, timing, replicaId: A });
		expect(second.claimed).toBe(0);
		expect((await attemptsFor("wk-r-perm")).map((a) => a.retryClass)).toEqual([
			"client",
		]);
	});

	test("every attempt writes a delivery_attempt row with the correct attempt_no", async () => {
		await seedOutbox("wk-r-log");

		for (let i = 0; i < 3; i++) {
			await makeDue("wk-r-log");
			await workerTick(db, {
				send: async () => retryable,
				timing,
				replicaId: A,
			});
		}

		const written = await attemptsFor("wk-r-log");
		expect(written.map((a) => a.attemptNo)).toEqual([1, 2, 3]);
		expect(written.map((a) => a.providerStatus)).toEqual([503, 503, 503]);
		expect((await outbox("wk-r-log")).attempts).toBe(3);
	});
});

describe("redaction", () => {
	// C15: truncating first can cut the URL mid-token so the redaction pattern
	// no longer matches, persisting a partial webhook secret.
	test("a secret straddling the truncation boundary is fully redacted", async () => {
		await seedOutbox("wk-x-secret");
		const secret = "s3cr3t-webhook-token-that-must-never-be-stored";
		const url = `https://discord.com/api/webhooks/123456789/${secret}`;
		const padding = "x".repeat(300 - url.length + 20);
		const message = `${padding} POST ${url} failed`;
		expect(message.indexOf(secret)).toBeLessThan(300);
		expect(message.indexOf(secret) + secret.length).toBeGreaterThan(300);

		await workerTick(db, {
			send: async () => ({ ok: false, status: 500, error: message }),
			timing,
			replicaId: A,
		});

		const [attempt] = await attemptsFor("wk-x-secret");
		expect(attempt.error).not.toContain(secret);
		expect(attempt.error).not.toContain(secret.slice(0, 12));
		expect(attempt.error?.length).toBeLessThanOrEqual(300);
	});

	// The last-path-segment fixture above straddles correctly but does NOT
	// discriminate the reversed order: a truncated discord URL still parses and
	// still lands on a SECRET_LAST_SEGMENT_DOMAINS host, so redactChannelUrl
	// catches the partial either way. Userinfo credentials do discriminate --
	// truncating mid-password yields "https://svc:hunter2-su", which new URL()
	// rejects for having no host, so the reversed order falls into the catch
	// branch that only strips Telegram bot paths and leaks the partial password.
	test("a userinfo credential straddling the truncation boundary is fully redacted", async () => {
		await seedOutbox("wk-x-userinfo");
		const password = "hunter2-super-secret-password-value";
		const url = `https://svc:${password}@notify.invalid/hook`;
		const padding = "x".repeat(300 - url.indexOf(password) - 10);
		const message = `${padding}${url} refused`;
		const start = message.indexOf(password);
		expect(start).toBeLessThan(300);
		expect(start + password.length).toBeGreaterThan(300);

		await workerTick(db, {
			send: async () => ({ ok: false, status: 500, error: message }),
			timing,
			replicaId: A,
		});

		const [attempt] = await attemptsFor("wk-x-userinfo");
		expect(attempt.error).not.toContain(password);
		// The exact 10 characters truncate-then-redact would have persisted.
		expect(attempt.error).not.toContain(password.slice(0, 10));
		expect(attempt.error?.length).toBeLessThanOrEqual(300);
	});
});

describe("capacity and pruning", () => {
	// C13: a refused enqueue that leaves reminder_state pending is permanent
	// limbo, and the user's synced row lies about what happened.
	test("a user at the queue cap is refused, and the reminder is terminated", async () => {
		const reminderStateId = await seedReminder("wk-cap-r");
		await seedOutbox("wk-cap-1");
		await seedOutbox("wk-cap-2");
		const logged = new Set<string>();
		const insert = {
			reminderStateId,
			recipientUserId: OWNER,
			channelKind: "ntfy" as const,
			payload: { kind: "reminder" },
			idempotencyKey: "wk-cap-new",
			nextAttemptAt: new Date(),
		};

		const first = await enqueueOutbox(db, insert, {
			maxQueuedPerUser: 2,
			refusedLogged: logged,
		});
		const second = await enqueueOutbox(
			db,
			{ ...insert, idempotencyKey: "wk-cap-new-2" },
			{ maxQueuedPerUser: 2, refusedLogged: logged },
		);

		expect(first).toBe("refused");
		expect(second).toBe("refused");
		expect([...logged]).toEqual([OWNER]);
		const [reminder] = await db
			.select()
			.from(tables.reminderState)
			.where(eq(tables.reminderState.id, reminderStateId));
		expect(reminder.status).toBe("failed");
		expect(reminder.nextAttemptAt).toBeNull();

		// Another user is unaffected by this user's cap.
		expect(
			await enqueueOutbox(
				db,
				{ ...insert, recipientUserId: OTHER, reminderStateId: null },
				{ maxQueuedPerUser: 2 },
			),
		).toBe("inserted");
	});

	test("under the cap the row is inserted, and a duplicate key is a no-op", async () => {
		const insert = {
			reminderStateId: null,
			recipientUserId: OWNER,
			channelKind: "ntfy" as const,
			payload: { kind: "reminder" },
			idempotencyKey: "wk-cap-dup",
			nextAttemptAt: new Date(),
		};
		expect(await enqueueOutbox(db, insert, { maxQueuedPerUser: 2 })).toBe(
			"inserted",
		);
		expect(await enqueueOutbox(db, insert, { maxQueuedPerUser: 2 })).toBe(
			"duplicate",
		);
	});

	test("sent, abandoned and failed rows are pruned past the retention window", async () => {
		const old = new Date(Date.now() - 40 * 24 * 3_600_000);
		await seedOutbox("wk-p-sent", { status: "sent", createdAt: old });
		await seedOutbox("wk-p-abandoned", { status: "abandoned", createdAt: old });
		await seedOutbox("wk-p-failed", { status: "failed", createdAt: old });
		await seedOutbox("wk-p-queued", { status: "queued", createdAt: old });
		await seedOutbox("wk-p-recent", { status: "failed" });

		const pruned = await pruneTerminal(db, 30 * 24 * 3_600_000);

		expect(pruned).toBe(3);
		const survivors = await db
			.select({ id: tables.notificationOutbox.id })
			.from(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.recipientUserId, OWNER));
		expect(survivors.map((r) => r.id).sort()).toEqual([
			"wk-p-queued",
			"wk-p-recent",
		]);
	});
});
