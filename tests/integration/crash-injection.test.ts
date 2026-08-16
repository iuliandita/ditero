// Kill a real replica at a named point in the pipeline and assert what the
// docs will claim about recovery.
//
// The crash is self-inflicted (DITERO_TEST_CRASH_POINT, src/config/test-crash):
// the window between "the provider accepted this" and "we committed that it was
// sent" is sub-millisecond, so an external SIGKILL can never land in it, and a
// test that tried would either flake or quietly degenerate into the
// before-send case.
//
// The after-send test asserts a DUPLICATE on purpose. At-least-once is the
// guarantee; anything stronger would need a transaction spanning the provider.
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as lib from "../../src/db/schema.ts";
import { type NtfyTap, startNtfyTap } from "../support/ntfy-tap.ts";
import { privateHost } from "../support/private-host.ts";
import {
	describePipeline,
	ReplicaRig,
	RIG_TIMING,
	recoveryBudgetMs,
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

const TAP_PORT = 4612;
const PREFIX = "crashr";
const USER_A = `${PREFIX}-a`;
const USER_B = `${PREFIX}-b`;

const pool = new Pool({ connectionString: databaseURL, max: 8 });
const db = drizzle(pool, { schema: lib });

// A late threshold well above the tick, so "fired late" is a real distinction
// here rather than something every reminder trivially satisfies.
const LATE_THRESHOLD_MS = 300_000;

let tap: NtfyTap;
let rig: ReplicaRig;
let scope: SeededScope;

// Bound to this file's tap/db so the call sites stay unchanged.
const wireFor = (taskId: string, topic?: string) =>
	rigWireFor(tap, taskId, topic);
const outboxFor = (taskIds: string[]) => rigOutboxFor(db, taskIds);

// The wire count belongs in the dump alongside the durable state: "sent with no
// delivery" and "never sent" are the two halves of #114 and look identical from
// the database alone.
const diagnose = (...taskIds: string[]) => ({
	diagnose: async () =>
		[
			await describePipeline(db, taskIds),
			`  ntfy tap: ${taskIds
				.map((id) => `${id}=${wireFor(id).length}`)
				.join(" ")}`,
		].join("\n"),
});

// Drive the escalation ladder without waiting out repeat_every_min: what is
// under test is the sweep's branch, not the clock.
async function dueNow(taskId: string): Promise<number> {
	const { rowCount } = await db.execute(sql`
		update reminder_state set next_attempt_at = now() - interval '1 second'
		where task_id = ${taskId} and status = 'pending'
			and next_attempt_at is not null
	`);
	return rowCount ?? 0;
}

beforeAll(async () => {
	const host = privateHost();
	tap = await startNtfyTap(host, TAP_PORT);
	// wipeRigFixture truncates the notification tables itself.
	await wipeRigFixture(db, [USER_A, USER_B], [`${PREFIX}-ws`]);
	await seedUser(db, USER_A, tap.url);
	await seedUser(db, USER_B, tap.url);
	scope = await seedWorkspace(db, PREFIX, USER_A, [USER_A, USER_B]);
	rig = new ReplicaRig({
		databaseURL,
		replicaEnv: [""],
		tapCIDR: `${host}/32`,
		basePort: 3191,
		timing: { ...RIG_TIMING, lateThresholdMs: LATE_THRESHOLD_MS },
	});
}, 120_000);

afterAll(async () => {
	await rig?.killAll();
	await tap?.close();
	await wipeRigFixture(db, [USER_A, USER_B], [`${PREFIX}-ws`]);
	await pool.end();
}, 60_000);

// Seed while nothing is running, then boot armed, wait for the suicide, then
// boot clean and watch the recovery.
//
// The crash is SETUP, not the property under test -- the property is the
// recovery that follows it -- and under a saturated host the setup is what
// fails (#114): the armed replica exits before reaching its crash point, or
// never gets scheduled far enough to exit at all. So the crash phase retries
// rather than asserting, and only an exhausted retry is a failure.
//
// Retrying is sound because an ARMED replica can never leave a terminal row:
// every crash point fires before the completion commit (worker.ts), so a row
// this attempt touched is still queued or still leased, and the next armed
// launch reclaims and re-crashes it. That is exactly why the same loop must
// NOT accept the state left by a killed-on-timeout replica -- an external kill
// between the claim and the send leaves a row indistinguishable from a
// before-send crash, which would let the after-send test pass its precondition
// having never sent anything.
//
// `left` is what the crash must have LEFT BEHIND. The rig cannot tell the armed
// suicide from any other exit, so without it a replica that died early silently
// turns the caller into a test whose precondition never existed: it waits out
// its full budget for a recovery that was never set up, and blames the recovery
// for a crash that never happened.
const CRASH_ATTEMPTS = 3;
// Clears the same allowance waitHealthy gives a boot (45s) twice over: an armed
// replica has to BOOT before it can reach its crash point, and the old 60s was
// a starved runner's difference between booting and not (#114). Bounded so
// CRASH_ATTEMPTS x this still fits the tests' own timeout.
const CRASH_EXIT_BUDGET_MS = 90_000;

async function crashThenRecover(
	point: string,
	taskIds: string[],
	seed: () => Promise<void>,
	left?: { label: string; holds: (rows: OutboxSnapshot) => boolean },
): Promise<void> {
	await rig.stop(0);
	await seed();

	let reason = "";
	for (let attempt = 1; attempt <= CRASH_ATTEMPTS; attempt++) {
		// A silent retry hides a degrading runner: a run that needed two attempts
		// would otherwise look exactly like a clean one.
		if (attempt > 1) {
			console.error(
				`[rig] retrying the ${point} crash (${attempt}/${CRASH_ATTEMPTS}): ${reason.split("\n")[0]}`,
			);
		}
		rig.launch(0, `DITERO_TEST_CRASH_POINT=${point}`);
		try {
			await rig.waitForExit(0, CRASH_EXIT_BUDGET_MS);
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
			// Still alive and still armed: take it down before relaunching, or the
			// next spawn races a process that may yet reach its crash point.
			await rig.stop(0);
			// Every caller asserts an EXACT delivery count, so a retry is only
			// clean while the abandoned attempt put nothing on the wire. It should
			// not have -- the send-point hooks fire immediately after the send, so
			// a replica that got that far would have exited long before this
			// budget -- but "should not" is not an invariant to silently bet an
			// exact count on.
			const stray = taskIds.filter((id) => wireFor(id).length > 0);
			if (stray.length > 0) {
				throw new Error(
					`rig: the timed-out ${point} attempt already delivered ${stray.join(", ")}, so retrying it would inflate the wire count the caller asserts\n${reason}`,
				);
			}
			continue;
		}
		if (!left || left.holds(await outboxFor(taskIds))) {
			await rig.restart(0, "");
			return;
		}
		reason = `the ${point} crash did not leave ${left.label}\n${await describePipeline(db, taskIds)}`;
	}
	throw new Error(
		`rig: the ${point} crash never set up its precondition in ${CRASH_ATTEMPTS} attempts, so the recovery under test was never reachable\n${reason}`,
	);
}

type OutboxSnapshot = Awaited<ReturnType<typeof outboxFor>>;

// Both send-point crashes die holding the row: claimBatch commits `sending`
// with claimed_by before either hook can fire, and neither hook is reached
// without that claim.
const heldBySender = (rows: OutboxSnapshot) =>
	rows.length === 1 &&
	rows[0].status === "sending" &&
	rows[0].claimedBy !== null;

describe("crash injection", () => {
	test("SIGKILL before the send: the row is reclaimed after the lease and delivered once", async () => {
		const taskId = `${PREFIX}-before`;
		await crashThenRecover(
			"before-send",
			[taskId],
			async () => {
				await seedReminderTask(db, scope, taskId);
			},
			{ label: "a claimed row", holds: heldBySender },
		);

		await waitFor(
			"the reclaimed row to be delivered",
			async () => wireFor(taskId).length > 0,
			{ timeoutMs: recoveryBudgetMs(), ...diagnose(taskId) },
		);
		await sleep(3_000);

		expect(wireFor(taskId)).toHaveLength(1);
		const rows = await outboxFor([taskId]);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("sent");
		expect(rows[0].claimedBy).toBeNull();
		// The lease reclaim bumped attempts and logged its own attempt row
		// before the successful one.
		expect(rows[0].attempts).toBeGreaterThanOrEqual(2);
	}, 420_000);

	// X3: this is the test that substantiates the at-least-once claim. It must
	// NOT assert exactly-once.
	test("SIGKILL after the send but before the commit: the row is re-sent", async () => {
		const taskId = `${PREFIX}-after`;
		await crashThenRecover(
			"after-send",
			[taskId],
			async () => {
				await seedReminderTask(db, scope, taskId);
			},
			{ label: "a claimed row", holds: heldBySender },
		);

		await waitFor(
			"the re-send after the reclaim",
			async () => wireFor(taskId).length >= 2,
			{ timeoutMs: recoveryBudgetMs(), ...diagnose(taskId) },
		);
		await sleep(3_000);

		const rows = await outboxFor([taskId]);
		expect(rows).toHaveLength(1);
		// One outbox row, one idempotency key, TWO notifications on the wire.
		expect(wireFor(taskId)).toHaveLength(2);
		expect(rows[0].status).toBe("sent");
	}, 420_000);

	test("SIGKILL mid-claim: no row is lost or left stranded past the lease", async () => {
		const taskId = `${PREFIX}-claim`;
		const reminderId = randomUUID();
		const N = 5;
		await crashThenRecover(
			"mid-claim",
			[taskId],
			async () => {
				// Directly enqueued: a whole batch has to be in flight for
				// "mid-claim" to differ from "before-send".
				await seedReminderTask(db, scope, taskId, { minutesAgo: 180 });
				await db.insert(lib.reminderState).values({
					id: reminderId,
					taskId,
					occurrenceAt: new Date(),
					recipientUserId: USER_A,
					status: "pending",
					fireCount: 1,
					nextAttemptAt: null,
				});
				for (let i = 0; i < N; i++) {
					await db.insert(lib.notificationOutbox).values({
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
						idempotencyKey: `${reminderId}:ntfy:claim-${i}`,
						status: "queued",
						nextAttemptAt: new Date(),
					});
				}
			},
			{
				// The hook fires only when claimBatch returned rows (worker.ts), and
				// batchSize is N, so a real mid-claim crash leaves the whole batch
				// leased. Without this the test degenerates exactly like the send
				// points did (#114): a replica that died early leaves N queued rows,
				// the restart drains them normally, and the recovery under test --
				// that a lease reclaim rescues a batch stranded mid-flight -- is
				// never exercised while the test still passes.
				label: "the batch leased",
				holds: (rows) =>
					rows.length === N &&
					rows.every(
						(row) => row.status === "sending" && row.claimedBy !== null,
					),
			},
		);

		await waitFor(
			"every claimed row to be recovered and sent",
			async () => {
				const rows = await outboxFor([taskId]);
				return rows.length === N && rows.every((row) => row.status === "sent");
			},
			{ timeoutMs: 90_000, ...diagnose(taskId) },
		);
		const rows = await outboxFor([taskId]);
		expect(rows.filter((row) => row.claimedBy !== null)).toHaveLength(0);
		expect(wireFor(taskId).length).toBeGreaterThanOrEqual(N);
	}, 420_000);

	test("a restart inside the grace window fires the missed reminder once, late", async () => {
		const late = `${PREFIX}-late`;
		const fresh = `${PREFIX}-fresh`;
		await rig.stop(0);
		// Both are inside the 1h grace window; only one is past the late
		// threshold, so fired_late is a real discriminator rather than a
		// constant.
		await seedReminderTask(db, scope, late, { minutesAgo: 30 });
		await seedReminderTask(db, scope, fresh, { minutesAgo: 0 });
		await rig.restart(0, "");

		await waitFor(
			"both missed reminders to fire",
			async () => wireFor(late).length > 0 && wireFor(fresh).length > 0,
			{ timeoutMs: 60_000, ...diagnose(late, fresh) },
		);
		await sleep(3_000);

		expect(wireFor(late)).toHaveLength(1);
		const rows = await db
			.select({
				taskId: lib.reminderState.taskId,
				firedLate: lib.reminderState.firedLate,
				fireCount: lib.reminderState.fireCount,
			})
			.from(lib.reminderState)
			.where(inArray(lib.reminderState.taskId, [late, fresh]));
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.taskId === late)?.firedLate).toBe(true);
		expect(rows.find((r) => r.taskId === fresh)?.firedLate).toBe(false);
		for (const row of rows) expect(row.fireCount).toBe(1);
	}, 180_000);

	// X7 / C1: every other crash test targets the worker. This one kills the
	// leader inside the scan, between the reminder_state write and its enqueue.
	// The recovery under test is that those two are ONE transaction: commit the
	// row before the enqueue and the crash strands it at fire_count 1 with no
	// outbox row and no re-fire, which this test catches.
	//
	// Alone among the crash tests this one takes no precondition: a mid-scan
	// crash is DEFINED by leaving nothing behind (the write and the enqueue share
	// a transaction, so the kill rolls both back), which is indistinguishable
	// from a replica that never scanned. The retry loop still covers the exit
	// hang, and a crash that silently did not happen degrades this to a plain
	// restart test rather than to a false pass.
	test("the leader killed mid-scan strands no reminder_state row", async () => {
		const taskId = `${PREFIX}-scan`;
		await crashThenRecover("mid-scan", [taskId], async () => {
			await seedReminderTask(db, scope, taskId);
		});

		await waitFor(
			"the reminder to be created and delivered after the restart",
			async () => wireFor(taskId).length > 0,
			{ timeoutMs: 60_000, ...diagnose(taskId) },
		);
		await sleep(3_000);

		const rows = await db
			.select()
			.from(lib.reminderState)
			.where(eq(lib.reminderState.taskId, taskId));
		expect(rows).toHaveLength(1);
		// Neither stranded at fire_count 0 nor fired twice.
		expect(rows[0].fireCount).toBe(1);
		expect(rows[0].status).toBe("pending");
		expect(wireFor(taskId)).toHaveLength(1);
	}, 420_000);

	// X7 / C3: the unbounded-ladder-against-a-real-phone case. maxRepeats 1, so
	// the shape is exactly "maxRepeats deliveries, one fallback, then silence".
	test("the escalation ladder terminates at maxRepeats, then the fallback, then stops", async () => {
		const taskId = `${PREFIX}-ladder`;
		await rig.stop(0);
		await seedReminderTask(db, scope, taskId, {
			repeatEveryMin: 1,
			maxRepeats: 1,
			fallbackUserId: USER_B,
		});
		await rig.restart(0, "");

		await waitFor(
			"the primary recipient to be notified",
			async () => wireFor(taskId, `rig-${USER_A}`).length > 0,
			{ timeoutMs: 60_000, ...diagnose(taskId) },
		);

		// Pull the repeat forward instead of waiting out repeat_every_min.
		await waitFor(
			"the ladder to hand off to the fallback",
			async () => {
				await dueNow(taskId);
				return wireFor(taskId, `rig-${USER_B}`).length > 0;
			},
			{ timeoutMs: 60_000, intervalMs: 500, ...diagnose(taskId) },
		);

		// Keep pulling every pending row forward: if the ladder were unbounded
		// this is exactly what would keep it firing.
		const until = Date.now() + 15_000;
		while (Date.now() < until) {
			await dueNow(taskId);
			await sleep(500);
		}

		expect(wireFor(taskId, `rig-${USER_A}`)).toHaveLength(1);
		expect(wireFor(taskId, `rig-${USER_B}`)).toHaveLength(1);
		expect(wireFor(taskId)).toHaveLength(2);

		const rows = await db
			.select({
				recipientUserId: lib.reminderState.recipientUserId,
				status: lib.reminderState.status,
			})
			.from(lib.reminderState)
			.where(eq(lib.reminderState.taskId, taskId));
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.recipientUserId === USER_A)?.status).toBe(
			"escalated",
		);
		expect(rows.find((r) => r.recipientUserId === USER_B)?.status).toBe(
			"expired",
		);
	}, 240_000);
});
