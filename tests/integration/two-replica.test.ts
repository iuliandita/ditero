// Two real server processes against one database.
//
// The properties here are cross-process by definition and no in-process suite
// can observe them: which replica won the advisory lock, that SKIP LOCKED
// partitioned a batch across two OS processes, and that killing the leader
// hands the lock to the survivor.
//
// Attribution on the wire comes from the ack link: dispatch builds it from
// DITERO_PUBLIC_URL, which the rig sets per replica port. claimed_by is nulled
// by completeDelivery, so the database cannot answer "which replica sent this"
// after the fact -- the notification itself can.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { type NtfyTap, startNtfyTap } from "../support/ntfy-tap.ts";
import { privateHost } from "../support/private-host.ts";
import {
	ReplicaRig,
	outboxFor as rigOutboxFor,
	wireFor as rigWireFor,
	type SeededScope,
	seedReminderTask,
	seedUser,
	seedWorkspace,
	sleep,
	waitFor,
	wipeRigFixture,
} from "./replica-rig.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const TAP_PORT = 4611;
const PREFIX = "twore";
const USER_A = `${PREFIX}-a`;
const USER_B = `${PREFIX}-b`;

const pool = new Pool({ connectionString: databaseURL, max: 8 });
const db = drizzle(pool, { schema: tables });

let tap: NtfyTap;
let rig: ReplicaRig;
let scope: SeededScope;

// Bound to this file's tap/db so the call sites stay unchanged.
const wireFor = (taskId: string) => rigWireFor(tap, taskId);
const outboxFor = (taskIds: string[]) => rigOutboxFor(db, taskIds);

// Which replica put a delivery on the wire: the ack link's origin is that
// replica's DITERO_PUBLIC_URL.
function senderOf(ackUrl: string | null): string | null {
	return ackUrl ? new URL(ackUrl).origin : null;
}

beforeAll(async () => {
	const host = privateHost();
	tap = await startNtfyTap(host, TAP_PORT);
	// wipeRigFixture truncates the notification tables itself.
	await wipeRigFixture(db, [USER_A, USER_B], [`${PREFIX}-ws`]);
	await seedUser(db, USER_A, tap.url);
	await seedUser(db, USER_B, tap.url);
	scope = await seedWorkspace(db, PREFIX, USER_A, [USER_A, USER_B]);
	// Guard the fixture before any replica exists: without an enabled ntfy
	// channel every assertion below fails opaquely on a timeout, and the cause
	// would only surface after four slow tests.
	const channels = await db
		.select({ userId: tables.notificationChannel.userId })
		.from(tables.notificationChannel)
		.where(
			and(
				inArray(tables.notificationChannel.userId, [USER_A, USER_B]),
				eq(tables.notificationChannel.enabled, true),
				eq(tables.notificationChannel.kind, "ntfy"),
			),
		);
	expect(channels).toHaveLength(2);

	rig = new ReplicaRig({
		databaseURL,
		replicaEnv: ["", ""],
		tapCIDR: `${host}/32`,
	});
	await rig.start();
}, 120_000);

afterAll(async () => {
	// X6: hard-kill first. A ticking replica outliving the suite races every
	// later file's fixture teardown.
	await rig?.killAll();
	await tap?.close();
	await wipeRigFixture(db, [USER_A, USER_B], [`${PREFIX}-ws`]);
	await pool.end();
}, 60_000);

describe("two replicas, one database", () => {
	test("a single due reminder produces one reminder_state row and one delivery", async () => {
		const taskId = `${PREFIX}-single`;
		await seedReminderTask(db, scope, taskId);

		await waitFor(
			"the reminder to be delivered",
			async () => wireFor(taskId).length > 0,
			30_000,
		);
		// Both replicas keep scanning; give a couple more leader ticks a chance
		// to create a duplicate before asserting there is none.
		await sleep(3_000);

		const reminders = await db
			.select()
			.from(tables.reminderState)
			.where(eq(tables.reminderState.taskId, taskId));
		expect(reminders).toHaveLength(1);
		expect(reminders[0].recipientUserId).toBe(USER_A);
		expect(wireFor(taskId)).toHaveLength(1);

		const rows = await outboxFor([taskId]);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("sent");
	}, 90_000);

	test("both replicas drain the outbox, and no row goes out twice", async () => {
		// Enqueued directly: the property under test is the worker's claim
		// partition across two processes, and the scan would only ever hand it
		// one row per (reminder, channel).
		const taskId = `${PREFIX}-drain`;
		await seedReminderTask(db, scope, taskId, { minutesAgo: 180 });
		const reminderId = randomUUID();
		await db.insert(tables.reminderState).values({
			id: reminderId,
			taskId,
			occurrenceAt: new Date(),
			recipientUserId: USER_A,
			status: "pending",
			fireCount: 1,
			nextAttemptAt: null,
		});
		const N = 60;
		for (let i = 0; i < N; i++) {
			await db.insert(tables.notificationOutbox).values({
				id: randomUUID(),
				reminderStateId: reminderId,
				recipientUserId: USER_A,
				channelKind: "ntfy",
				payload: {
					kind: "reminder",
					taskId,
					taskTitle: taskId,
					occurrenceAt: new Date().toISOString(),
					fireCount: 1,
				},
				idempotencyKey: `${reminderId}:ntfy:drain-${i}`,
				status: "queued",
				nextAttemptAt: new Date(),
			});
		}

		await waitFor(
			`all ${N} rows to reach a terminal state`,
			async () => {
				const rows = await outboxFor([taskId]);
				return rows.every((row) => row.status === "sent");
			},
			90_000,
		);

		const rows = await outboxFor([taskId]);
		expect(rows).toHaveLength(N);
		const wire = wireFor(taskId);
		// Exactly-once on the wire under a healthy two-replica drain.
		expect(wire).toHaveLength(N);

		// X2: a rig whose second replica crashed on boot would satisfy every
		// assertion above. Both identities must appear and neither may be a
		// rounding error.
		const senders = new Map<string, number>();
		for (const delivery of wire) {
			const origin = senderOf(delivery.ackUrl);
			expect(origin).not.toBeNull();
			if (origin) senders.set(origin, (senders.get(origin) ?? 0) + 1);
		}
		// Pinned, not merely derived: an expectation computed from however many
		// replicas happen to be configured is satisfied by a ONE-replica rig,
		// which is the exact scenario this assertion exists to reject.
		expect(rig.replicas).toHaveLength(2);
		const expected = rig.replicas.map((r) => `http://localhost:${r.port}`);
		expect([...senders.keys()].sort()).toEqual([...expected].sort());
		for (const origin of expected) {
			expect(senders.get(origin) ?? 0).toBeGreaterThanOrEqual(2);
		}
	}, 180_000);

	test("killing the leader lets the survivor acquire the lock on the next tick", async () => {
		// Whoever holds it, killing replica 0 must either free it or leave it
		// with replica 1; either way a reminder seeded afterwards has to be
		// created by a live process.
		rig.kill(0);
		await rig.waitForExit(0);

		const taskId = `${PREFIX}-failover`;
		await seedReminderTask(db, scope, taskId);
		await waitFor(
			"the survivor to scan and deliver",
			async () => wireFor(taskId).length > 0,
			45_000,
		);
		const wire = wireFor(taskId);
		expect(wire).toHaveLength(1);
		expect(senderOf(wire[0].ackUrl)).toBe(
			`http://localhost:${rig.replicas[1].port}`,
		);

		await rig.restart(0);
	}, 120_000);

	// X1: "no duplicate idempotency_key rows" is enforced by a UNIQUE constraint
	// and so cannot fail. What can fail is the wire: a triple enqueued once and
	// delivered twice, or accepted by the provider and recorded as a conflict.
	test("every (reminder, channel, fireCount) triple is delivered exactly once", async () => {
		const taskIds = [0, 1, 2, 3].map((i) => `${PREFIX}-triple-${i}`);
		for (const taskId of taskIds) {
			await seedReminderTask(db, scope, taskId, {
				assignees: [USER_A, USER_B],
			});
		}
		// 4 tasks x 2 assignees x 1 channel = 8 enqueue attempts.
		const attempts = taskIds.length * 2;

		await waitFor(
			"every enqueued row to be sent",
			async () => {
				const rows = await outboxFor(taskIds);
				return (
					rows.length === attempts && rows.every((row) => row.status === "sent")
				);
			},
			90_000,
		);

		const rows = await outboxFor(taskIds);
		const keys = rows.map((row) => row.key);
		// Each key IS the (reminderState, channel, fireCount) triple
		// (scheduler.ts builds it that way).
		expect(new Set(keys).size).toBe(attempts);

		// One recorded successful attempt per triple: a conflict swallowed as
		// success would leave a triple with zero, and a re-send would leave one
		// with two.
		const attemptRows = await db
			.select({
				outboxId: tables.deliveryAttempt.outboxId,
				retryClass: tables.deliveryAttempt.retryClass,
			})
			.from(tables.deliveryAttempt)
			.where(
				inArray(
					tables.deliveryAttempt.outboxId,
					rows.map((row) => row.id),
				),
			);
		expect(attemptRows).toHaveLength(attempts);
		for (const row of rows) {
			expect(attemptRows.filter((a) => a.outboxId === row.id)).toHaveLength(1);
		}

		// And on the wire: exactly one notification per triple, no more.
		for (const taskId of taskIds) expect(wireFor(taskId)).toHaveLength(2);
		expect(
			tap.deliveries.filter(
				(d) => taskIds.includes(d.title) && d.ackUrl !== null,
			),
		).toHaveLength(attempts);
	}, 180_000);

	// X5: both timing modules validate cross-field ordering at boot. A rig that
	// silently accepted an invalid combination would be tuning nothing.
	test("an invalid timing combination is refused at boot", async () => {
		const bad = new ReplicaRig({
			databaseURL,
			replicaEnv: ["DITERO_SCHEDULER_TICK_MS=5000"],
			tapCIDR: "10.0.0.1/32",
			basePort: 3199,
		});
		try {
			// lateThreshold (2000) < 2 x tick (10000): config/scheduler.ts throws,
			// so the process must die instead of serving /health.
			await expect(bad.start()).rejects.toThrow(/exited before boot|timed out/);
		} finally {
			// Unconditional: if the boot validation ever regresses, `start`
			// RESOLVES, the rejects assertion throws, and a live replica on 3199
			// would otherwise outlive the suite.
			await bad.killAll();
		}
	}, 90_000);
});
