// Integration tests for the M3a outbox worker (src/server/notifications/worker.ts)
// and the outbox fill side (outbox.ts). Every property under test is a database
// behavior: SKIP LOCKED's non-blocking partition, the lease reclaim, and the
// claimed_by completion fence all disappear under a mock. Two independent pools
// stand in for two replicas.
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
import { enqueueOutbox } from "../../src/server/notifications/outbox.ts";
import {
	claimBatch,
	claimBatchSql,
	completeDelivery,
	LEASE_EXPIRED,
	pruneTerminal,
	reclaimExpired,
	type SendFn,
	workerTick,
} from "../../src/server/notifications/worker.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 6 });
const db = drizzle(pool, { schema: tables });
// Replica B: the partition tests need two real connections claiming at once,
// which one pooled client cannot express.
// statement_timeout so a claim that blocks (the failure mode when SKIP LOCKED
// is missing) fails sharply on its own query instead of hanging the connection
// and cascading into every later test's beforeEach.
const otherPool = new Pool({
	connectionString: databaseURL,
	max: 6,
	statement_timeout: 2_000,
});
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
	adapterDeadlineMs: 5_000,
	batchSize: 20,
	sendConcurrency: 10,
	retentionMs: 30 * 24 * 3_600_000,
	pruneCadenceTicks: 60,
	pruneBatchSize: 1_000,
	maxQueuedPerUser: 500,
};

const ok: ProviderResult = { ok: true, status: 200 };
const retryable: ProviderResult = { ok: false, status: 503, error: "boom" };
const permanent: ProviderResult = { ok: false, status: 403, error: "nope" };

const sendOk: SendFn = async () => ok;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
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

const tick = (options: Partial<Parameters<typeof workerTick>[1]> = {}) =>
	workerTick(db, { send: sendOk, timing, replicaId: A, ...options });

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
	// The property SKIP LOCKED buys is NOT BLOCKING, so the test has to observe
	// a claim that overlaps a HELD lock. Asserting only that the two results are
	// disjoint passes with plain FOR UPDATE (B waits, re-reads under READ
	// COMMITTED, and takes the rows A did not), and passes just as well when B
	// returns nothing at all. The wall-clock bound is what discriminates.
	test("a second replica claims without waiting on the first replica's locks", async () => {
		for (let i = 0; i < 10; i++) await seedOutbox(`wk-c-${i}`);

		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let claimedByA: string[] = [];
		const holding = db.transaction(async (tx) => {
			claimedByA = (await claimBatch(tx, 5, A)).map((row) => row.id);
			// Hold the transaction, and therefore A's row locks, open.
			await held;
		});
		for (let waited = 0; claimedByA.length === 0; waited++) {
			if (waited > 200) throw new Error("replica A never claimed its batch");
			await sleep(5);
		}

		const startedAt = Date.now();
		const claimedByB = (await claimBatch(otherDb, 5, B)).map((row) => row.id);
		const elapsed = Date.now() - startedAt;

		release();
		await holding;

		expect(claimedByA).toHaveLength(5);
		// Only a non-blocking partition returns a full second batch here.
		expect(claimedByB).toHaveLength(5);
		expect(claimedByA.filter((id) => claimedByB.includes(id))).toEqual([]);
		// A serializing claim cannot return before release(), which runs after.
		expect(elapsed).toBeLessThan(1_000);
	});

	test("the row selection is evaluated once, whatever the planner does", async () => {
		for (let i = 0; i < 8; i++) await seedOutbox(`wk-nl-${i}`);
		const plan = (
			await db.execute<{ "QUERY PLAN": string }>(
				sql`explain (costs off) ${claimBatchSql(2, A)}`,
			)
		).rows
			.map((row) => row["QUERY PLAN"])
			.join("\n");

		// The shape this replaced -- `where id in (select ... limit N for update
		// skip locked)` -- does not bound the claim. Postgres may plan it as a
		// nested-loop semi join with the subquery on the INNER side and rescan
		// it once per outer row, each rescan taking a fresh N rows past the ones
		// it already locked. A claim of 5 against ten queued rows returned all
		// ten, in this suite, on a table whose statistics happened to favour
		// that plan.
		//
		// Asserted as a plan and not as a row count on purpose: whether the
		// broken shape over-claims depends on which join the planner picks, so
		// the behavioural version of this test passes on the days it is kind.
		// A materialized CTE cannot be rescanned by any plan.
		expect(plan).toContain("CTE claimed");
		expect(plan).not.toContain("ANY_subquery");
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

		const result = await reclaimExpired(db, 60_000, 100);

		expect(result.reclaimed).toBe(1);
		const row = await outbox("wk-l-stuck");
		expect(row.status).toBe("queued");
		expect(row.claimedBy).toBeNull();
		expect(row.claimedAt).toBeNull();
		// Reclaimed rows carry backoff; without it the row is re-claimable in
		// the same tick with no wait at all.
		expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
	});

	test("a reclaim records why the attempt produced no result", async () => {
		await seedOutbox("wk-l-log");
		await claimBatch(db, 10, A);
		await backdateClaim("wk-l-log", 120_000);

		await reclaimExpired(db, 60_000, 100);

		const [attempt] = await attemptsFor("wk-l-log");
		expect(attempt.attemptNo).toBe(1);
		expect(attempt.retryClass).toBe(LEASE_EXPIRED);
		expect(attempt.providerStatus).toBeNull();
	});

	test("a row within its lease is not reclaimed", async () => {
		await seedOutbox("wk-l-fresh");
		await claimBatch(db, 10, A);

		const result = await reclaimExpired(db, 60_000, 100);

		expect(result).toEqual({ reclaimed: 0, abandoned: 0 });
		const row = await outbox("wk-l-fresh");
		expect(row.status).toBe("sending");
		expect(row.claimedBy).toBe(A);
		expect(await attemptsFor("wk-l-fresh")).toEqual([]);
	});

	// C11: without the claimed_by fence, A's late completion overwrites B's
	// terminal state and resurrects the row for a third delivery.
	test("a worker whose row was reclaimed mid-send cannot modify it on completion", async () => {
		await seedOutbox("wk-f-race");

		const [claimedByA] = await claimBatch(db, 10, A);
		await backdateClaim("wk-f-race", 120_000);
		await reclaimExpired(db, 60_000, 100);
		await makeDue("wk-f-race");

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
		// Attempt 1 is the reclaim, attempt 2 is B. A wrote nothing.
		expect(written.map((a) => a.attemptNo)).toEqual([1, 2]);
		expect(written.map((a) => a.retryClass)).toEqual([LEASE_EXPIRED, "ok"]);
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
			abandoned += (await reclaimExpired(db, 60_000, 100)).abandoned;
			await makeDue("wk-f-hang");
		}

		expect(abandoned).toBe(1);
		const row = await outbox("wk-f-hang");
		expect(row.status).toBe("abandoned");
		expect(row.attempts).toBe(MAX_ATTEMPTS);
		expect(await claimBatch(db, 10, A)).toEqual([]);
		// The abandoned row explains itself rather than ending with 15 attempts
		// and no history at all.
		expect(await attemptsFor("wk-f-hang")).toHaveLength(MAX_ATTEMPTS);
	});
});

describe("sending", () => {
	test("a send exceeding the adapter deadline is a retryable failure, not a hung tick", async () => {
		await seedOutbox("wk-s-hang");

		const summary = await tick({
			send: () => new Promise<ProviderResult>(() => {}),
			timing: { ...timing, adapterDeadlineMs: 100 },
		});

		expect(summary.retried).toBe(1);
		const row = await outbox("wk-s-hang");
		expect(row.status).toBe("queued");
		expect(row.attempts).toBe(1);
		const [attempt] = await attemptsFor("wk-s-hang");
		expect(attempt.error).toBe("adapter deadline exceeded");
	});

	// Without the signal on the seam, a hung endpoint holds its socket and
	// buffers open per timed-out send, per replica, per hanging channel.
	test("a timed-out send has its signal aborted", async () => {
		await seedOutbox("wk-s-abort");
		let observed: AbortSignal | undefined;

		await tick({
			send: (_row, signal) => {
				observed = signal;
				return new Promise<ProviderResult>(() => {});
			},
			timing: { ...timing, adapterDeadlineMs: 100 },
		});

		expect(observed?.aborted).toBe(true);
	});

	test("a throwing adapter is caught and the row is requeued, not stranded", async () => {
		await seedOutbox("wk-s-throw");

		const summary = await tick({
			send: async () => {
				throw new Error("socket exploded");
			},
		});

		expect(summary.retried).toBe(1);
		const row = await outbox("wk-s-throw");
		expect(row.status).toBe("queued");
		expect(row.claimedBy).toBeNull();
		const [attempt] = await attemptsFor("wk-s-throw");
		expect(attempt.retryClass).toBe("transport");
		expect(attempt.error).toContain("socket exploded");
	});

	// Finding 1: a serial drain gives the last row of a batch an effective
	// deadline of batchSize * adapterDeadlineMs, pushing it past the lease.
	test("a batch is dispatched with bounded concurrency, not serially", async () => {
		const rows = 6;
		const sendMs = 150;
		for (let i = 0; i < rows; i++) await seedOutbox(`wk-s-conc-${i}`);
		let inFlight = 0;
		let peak = 0;

		const startedAt = Date.now();
		await tick({
			timing: { ...timing, sendConcurrency: 3 },
			send: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await sleep(sendMs);
				inFlight--;
				return ok;
			},
		});
		const elapsed = Date.now() - startedAt;

		// The discriminator: a serial drain never has more than one send in
		// flight, so this alone fails it, and it does not depend on how fast the
		// machine is. The wall-clock check below is a second, weaker net -- bound
		// to the serial floor rather than an arbitrary number, because a loaded
		// CI runner took 720ms for the concurrent case that a 600ms bound failed.
		expect(peak).toBe(3);
		expect(elapsed).toBeLessThan(rows * sendMs);
	});

	test("a failure to record the outcome leaves the row claimed for reclaim", async () => {
		await seedOutbox("wk-s-dberr");
		const brokenDb = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "transaction") {
					return async () => {
						throw new Error("connection terminated unexpectedly");
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});

		const summary = await workerTick(brokenDb, {
			send: sendOk,
			timing,
			replicaId: A,
		});

		expect(summary.errored).toBe(1);
		const row = await outbox("wk-s-dberr");
		expect(row.status).toBe("sending");
		expect(row.claimedBy).toBe(A);
		expect(await attemptsFor("wk-s-dberr")).toEqual([]);

		// The lease reclaim is what recovers it.
		await backdateClaim("wk-s-dberr", 120_000);
		expect((await reclaimExpired(db, 60_000, 100)).reclaimed).toBe(1);
	});

	test("two replicas ticking on one batch deliver each row exactly once", async () => {
		for (let i = 0; i < 4; i++) await seedOutbox(`wk-s-race-${i}`);

		const [first, second] = await Promise.all([
			workerTick(db, { send: sendOk, timing, replicaId: A }),
			workerTick(otherDb, { send: sendOk, timing, replicaId: B }),
		]);

		expect(first.sent + second.sent).toBe(4);
		for (let i = 0; i < 4; i++) {
			expect((await outbox(`wk-s-race-${i}`)).status).toBe("sent");
			expect(await attemptsFor(`wk-s-race-${i}`)).toHaveLength(1);
		}
	});
});

describe("retry", () => {
	test("a retryable failure increments attempts and schedules a future retry", async () => {
		await seedOutbox("wk-r-retry");
		const before = Date.now();

		const summary = await tick({ send: async () => retryable });

		expect(summary.retried).toBe(1);
		const row = await outbox("wk-r-retry");
		expect(row.status).toBe("queued");
		expect(row.attempts).toBe(1);
		expect(row.claimedBy).toBeNull();
		expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before);
	});

	test("a permanent failure is terminal and never retried", async () => {
		await seedOutbox("wk-r-perm");

		await tick({ send: async () => permanent });

		const row = await outbox("wk-r-perm");
		expect(row.status).toBe("failed");
		expect(row.attempts).toBe(1);
		expect(await claimBatch(db, 10, A)).toEqual([]);

		expect((await tick()).claimed).toBe(0);
		expect((await attemptsFor("wk-r-perm")).map((a) => a.retryClass)).toEqual([
			"client",
		]);
	});

	test("every attempt writes a delivery_attempt row with the correct attempt_no", async () => {
		await seedOutbox("wk-r-log");

		for (let i = 0; i < 3; i++) {
			await makeDue("wk-r-log");
			await tick({ send: async () => retryable });
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

		await tick({
			send: async () => ({ ok: false, status: 500, error: message }),
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

		await tick({
			send: async () => ({ ok: false, status: 500, error: message }),
		});

		const [attempt] = await attemptsFor("wk-x-userinfo");
		expect(attempt.error).not.toContain(password);
		// The exact 10 characters truncate-then-redact would have persisted.
		expect(attempt.error).not.toContain(password.slice(0, 10));
		expect(attempt.error?.length).toBeLessThanOrEqual(300);
	});
});

// Channel health is what the settings page renders instead of an indefinite
// "Verified" for a credential that has started failing, so every assertion here
// reads the persisted row rather than the worker summary.
describe("channel health", () => {
	const CHANNEL = "wk-chan";

	async function channel() {
		const rows = await db
			.select()
			.from(tables.notificationChannel)
			.where(eq(tables.notificationChannel.id, CHANNEL));
		if (rows.length !== 1) throw new Error("channel row not found");
		return rows[0];
	}

	beforeEach(async () => {
		await db
			.delete(tables.notificationChannel)
			.where(eq(tables.notificationChannel.id, CHANNEL));
		await db.insert(tables.notificationChannel).values({
			id: CHANNEL,
			userId: OWNER,
			kind: "ntfy",
			config: { serverUrl: "https://ntfy.invalid", topic: "wk" },
		});
	});

	test("a permanent failure records the error time and category", async () => {
		await seedOutbox("wk-h-perm");

		await tick({ send: async () => permanent });

		const row = await channel();
		expect(row.lastErrorCode).toBe("auth");
		expect(row.lastErrorAt).toBeInstanceOf(Date);
		expect((await outbox("wk-h-perm")).status).toBe("failed");
	});

	test("the category follows the provider status, not a single default", async () => {
		await seedOutbox("wk-h-404");
		await tick({
			send: async () => ({ ok: false, status: 404, error: "no such topic" }),
		});
		expect((await channel()).lastErrorCode).toBe("not_found");
	});

	test("the next success clears both columns", async () => {
		await seedOutbox("wk-h-clear-1");
		await tick({ send: async () => permanent });
		expect((await channel()).lastErrorCode).toBe("auth");

		await seedOutbox("wk-h-clear-2");
		await tick({ send: sendOk });

		const row = await channel();
		expect(row.lastErrorCode).toBeNull();
		expect(row.lastErrorAt).toBeNull();
	});

	// A 503 still has ~33 minutes of ladder to run; flipping the channel to
	// "broken" on the first blip would tell the user something untrue.
	test("a retryable failure leaves the channel unmarked", async () => {
		await seedOutbox("wk-h-retry");

		const summary = await tick({ send: async () => retryable });

		expect(summary.retried).toBe(1);
		const row = await channel();
		expect(row.lastErrorCode).toBeNull();
		expect(row.lastErrorAt).toBeNull();
	});

	// The column is Zero-synced, so a text column would carry a provider error
	// body -- which can contain the bot token from the URL that produced it --
	// to every client of that user. Proven at the database, not the type layer:
	// a `text` column would make this insert succeed.
	test("the database rejects any category outside the enum", async () => {
		const rejection = await db
			.execute(sql`
				update notification_channel
				set last_error_code = '401 Unauthorized {"token":"leaked"}'
				where id = ${CHANNEL}
			`)
			.then(
				() => null,
				(error: unknown) => error as { cause?: { code?: string } },
			);
		// Drizzle wraps the driver error; the pg SQLSTATE for an out-of-enum
		// value is what proves the constraint is the database's, not the ORM's.
		expect(rejection?.cause?.code).toBe("22P02");
		expect((await channel()).lastErrorCode).toBeNull();
	});
});

describe("capacity and pruning", () => {
	test("a user at the queue cap is refused, and the refusal is logged once", async () => {
		const reminderStateId = await seedReminder("wk-cap-r");
		await seedOutbox("wk-cap-1");
		await seedOutbox("wk-cap-2");
		const refusedLogged = new Set<string>();
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
			refusedLogged,
		});
		const second = await enqueueOutbox(
			db,
			{ ...insert, idempotencyKey: "wk-cap-new-2" },
			{ maxQueuedPerUser: 2, refusedLogged },
		);

		expect(first).toBe("refused");
		expect(second).toBe("refused");
		expect([...refusedLogged]).toEqual([OWNER]);

		// Another user is unaffected by this user's cap.
		expect(
			await enqueueOutbox(
				db,
				{ ...insert, recipientUserId: OTHER, reminderStateId: null },
				{ maxQueuedPerUser: 2, refusedLogged },
			),
		).toBe("inserted");
	});

	test("a sending row still counts against the cap", async () => {
		await seedOutbox("wk-cap-s1");
		await claimBatch(db, 10, A);

		expect(
			await enqueueOutbox(
				db,
				{
					reminderStateId: null,
					recipientUserId: OWNER,
					channelKind: "ntfy",
					payload: {},
					idempotencyKey: "wk-cap-s2",
					nextAttemptAt: new Date(),
				},
				{ maxQueuedPerUser: 1, refusedLogged: new Set() },
			),
		).toBe("refused");
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
		const options = { maxQueuedPerUser: 2, refusedLogged: new Set<string>() };
		expect(await enqueueOutbox(db, insert, options)).toBe("inserted");
		expect(await enqueueOutbox(db, insert, options)).toBe("duplicate");
	});

	test("sent, abandoned and failed rows are pruned past the retention window", async () => {
		const old = new Date(Date.now() - 40 * 24 * 3_600_000);
		await seedOutbox("wk-p-sent", { status: "sent", createdAt: old });
		await seedOutbox("wk-p-abandoned", { status: "abandoned", createdAt: old });
		await seedOutbox("wk-p-failed", { status: "failed", createdAt: old });
		await seedOutbox("wk-p-queued", { status: "queued", createdAt: old });
		await seedOutbox("wk-p-recent", { status: "failed" });

		const pruned = await pruneTerminal(db, 30 * 24 * 3_600_000, 1_000);

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

	test("the prune is bounded by its batch size", async () => {
		const old = new Date(Date.now() - 40 * 24 * 3_600_000);
		for (let i = 0; i < 5; i++) {
			await seedOutbox(`wk-p-batch-${i}`, { status: "sent", createdAt: old });
		}

		expect(await pruneTerminal(db, 30 * 24 * 3_600_000, 2)).toBe(2);
		expect(await pruneTerminal(db, 30 * 24 * 3_600_000, 2)).toBe(2);
		expect(await pruneTerminal(db, 30 * 24 * 3_600_000, 2)).toBe(1);
	});

	// The prune only bounds rate_bucket if the tick actually calls it: the public
	// ack route writes those rows and nothing else deletes them.
	test("the tick prunes idle rate buckets and skips them when not pruning", async () => {
		const key = "wk-prune-bucket";
		const seedBucket = async () => {
			await db
				.insert(tables.rateBucket)
				.values({
					key,
					tokens: 0,
					refilledAt: new Date(Date.now() - 3 * 3_600_000),
				})
				.onConflictDoNothing();
		};
		try {
			await seedBucket();
			expect((await tick({ prune: false })).prunedRateBuckets).toBe(0);
			expect((await tick()).prunedRateBuckets).toBe(1);
			expect(
				await db
					.select({ key: tables.rateBucket.key })
					.from(tables.rateBucket)
					.where(eq(tables.rateBucket.key, key)),
			).toEqual([]);
		} finally {
			await db.delete(tables.rateBucket).where(eq(tables.rateBucket.key, key));
		}
	});

	test("prune is skipped when the tick does not ask for it", async () => {
		const old = new Date(Date.now() - 40 * 24 * 3_600_000);
		await seedOutbox("wk-p-skip", { status: "sent", createdAt: old });

		expect((await tick({ prune: false })).pruned).toBe(0);
		expect((await tick()).pruned).toBe(1);
	});
});
