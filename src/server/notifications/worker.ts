// Outbox drain loop. Runs on EVERY replica with no leader lock: the claim is
// mediated by FOR UPDATE SKIP LOCKED, and a dead claimer is recovered by the
// lease reclaim rather than by a lock timeout. Sending itself is injected
// (SendFn) so Task 12 owns the adapters and this module owns only the
// at-least-once bookkeeping.
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type CrashHook, crashHook } from "../../config/test-crash.ts";
import type { WorkerTiming } from "../../config/worker.ts";
import {
	replicaId as resolveReplicaId,
	workerTiming,
} from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import { redactUrlsIn } from "../../domain/notification-channel.ts";
import type {
	ProviderResult,
	RetryDecision,
} from "../../domain/notification-retry.ts";
import {
	classifyRetry,
	MAX_ATTEMPTS,
} from "../../domain/notification-retry.ts";
import { pruneAckCapabilities, pruneRateBuckets } from "./capability.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

// Written by the reclaim path, which has no ProviderResult to classify: the
// worker never heard back at all. Distinct from "transport" (we tried and the
// network answered) so an operator can tell a hung provider from a refused one.
export const LEASE_EXPIRED = "lease-expired";

export type OutboxRow = {
	id: string;
	reminderStateId: string | null;
	recipientUserId: string;
	channelKind: ChannelKind;
	payload: unknown;
	attempts: number;
};

// The seam Task 12 fills. Shaped by what classifyRetry consumes: a send
// reports a ProviderResult and nothing else, so the worker never learns
// anything channel-specific.
//
// The signal is aborted when the worker stops waiting for this send, so an
// adapter must pass it to fetch: without it a hung endpoint leaks a socket and
// its buffers per timed-out send, per replica, per hanging channel. It is on
// the signature from the start because widening it later means touching every
// adapter Task 12 writes against this type.
export type SendFn = (
	row: OutboxRow,
	signal: AbortSignal,
) => Promise<ProviderResult>;

export type WorkerSummary = {
	reclaimed: number;
	abandoned: number;
	pruned: number;
	// Expired or consumed ack_capability rows. Task 12 mints a fresh capability
	// per attempt, so nothing else bounds that table's growth.
	prunedCapabilities: number;
	// Idle rate_bucket rows. The ack route is unauthenticated, so this is the
	// only bound on a table any anonymous caller can grow.
	prunedRateBuckets: number;
	claimed: number;
	sent: number;
	failed: number;
	retried: number;
	fenced: number;
	// Rows whose outcome could not be recorded at all. Without this a database
	// outage reports an all-zero summary plus a console line.
	errored: number;
};

export type WorkerOptions = {
	send: SendFn;
	// Required, not defaulted: resolving config inside the tick moves a
	// misconfiguration from boot into the tick's try/catch, where it is a log
	// line every second instead of a failed start.
	timing: WorkerTiming;
	// Required for the same reason the fence exists: a per-call fallback would
	// mint a fresh id every tick, and a caller whose claim and completion span
	// two ticks could never fence its own writes.
	replicaId: string;
	// Prune is comparatively expensive and is not needed every tick; startWorker
	// runs it on a coarse cadence.
	prune?: boolean;
	// Process-suicide seam for the durability rig. Absent -- not a no-op closure
	// -- unless the process booted under NODE_ENV=test with
	// DITERO_TEST_CRASH_POINT set (config/test-crash).
	crash?: CrashHook;
};

const ERROR_MAX_LENGTH = 300;

// Redact BEFORE truncating (C15): truncation can cut a URL mid-token so the
// redaction pattern no longer matches, persisting a partial webhook or bot
// token into delivery_attempt.error, which surfaces in the operator view.
function sanitizeError(message: string): string {
	const redacted = redactUrlsIn(message);
	return redacted.length > ERROR_MAX_LENGTH
		? redacted.slice(0, ERROR_MAX_LENGTH)
		: redacted;
}

function interval(ms: number) {
	return sql`make_interval(secs => ${ms / 1000})`;
}

// The row locks are taken in the subplan before the outer update evaluates, so
// two workers never claim the same row; `, id` is only a deterministic
// tiebreak. One statement, therefore its own transaction.
export async function claimBatch(
	database: Database | Transaction,
	limit: number,
	replicaId: string,
): Promise<OutboxRow[]> {
	const { rows } = await database.execute<{
		id: string;
		reminder_state_id: string | null;
		recipient_user_id: string;
		channel_kind: ChannelKind;
		payload: unknown;
		attempts: number;
	}>(sql`
		update notification_outbox
		set status = 'sending', claimed_at = now(), claimed_by = ${replicaId}
		where id in (
			select id from notification_outbox
			where status = 'queued' and next_attempt_at <= now()
			order by next_attempt_at, id
			for update skip locked
			limit ${limit}
		)
		returning id, reminder_state_id, recipient_user_id, channel_kind, payload, attempts
	`);
	return rows.map((row) => ({
		id: row.id,
		reminderStateId: row.reminder_state_id,
		recipientUserId: row.recipient_user_id,
		channelKind: row.channel_kind,
		payload: row.payload,
		attempts: row.attempts,
	}));
}

// The increment is load-bearing (C12): without it, a provider that reliably
// hangs past the lease loops claim -> hang -> reclaim forever, classifyRetry is
// never reached, MAX_ATTEMPTS never applies, and the user is notified once per
// lease interval from a single row.
//
// One data-modifying CTE so the bump and its delivery_attempt row commit
// together: a row that hangs all the way to `abandoned` would otherwise end
// with attempts = MAX_ATTEMPTS and no attempt history at all, leaving the table
// that answers "why did my reminder never arrive" empty in precisely the case
// that most needs answering.
export async function reclaimExpired(
	database: Database,
	leaseMs: number,
	batchSize: number,
): Promise<{ reclaimed: number; abandoned: number }> {
	const { rows } = await database.execute<{ status: string }>(sql`
		with expired as (
			select id from notification_outbox
			where status = 'sending' and claimed_at < now() - ${interval(leaseMs)}
			for update skip locked
			limit ${batchSize}
		),
		bumped as (
			update notification_outbox o
			set status = (case when o.attempts + 1 >= ${MAX_ATTEMPTS} then 'abandoned' else 'queued' end)::outbox_status,
				attempts = o.attempts + 1,
				-- Mirrors the backoff ladder in domain/notification-retry.ts
				-- (1s doubling, capped at 300s, plus up to 25% jitter).
				-- Reclaimed rows would otherwise keep next_attempt_at in the
				-- past and be re-claimable in the same tick with no backoff at
				-- all; without the jitter a mass reclaim gives every row an
				-- identical next_attempt_at and they all come due together.
				next_attempt_at = now() + make_interval(secs =>
					least(power(2, o.attempts)::double precision, 300) * (1 + random() * 0.25)),
				claimed_at = null,
				claimed_by = null
			from expired e
			where o.id = e.id
			returning o.id, o.status, o.attempts
		),
		logged as (
			insert into delivery_attempt (id, outbox_id, attempt_no, provider_status, retry_class, error)
			select gen_random_uuid()::text, b.id, b.attempts, null, ${LEASE_EXPIRED},
				'lease expired before the worker reported a result'
			from bumped b
		)
		select status from bumped
	`);
	const abandoned = rows.filter((row) => row.status === "abandoned").length;
	return { reclaimed: rows.length - abandoned, abandoned };
}

// `failed` belongs here (C14): the permanent-failure branch writes it, and a
// misconfigured channel returning 401 forever is the one genuinely unbounded
// growth case this prune exists to bound. delivery_attempt cascades.
//
// Batched: an unbounded DELETE on the first tick after a busy retention window
// takes the whole backlog in one statement while every other replica blocks on
// its row locks, and each of them delays its own claim behind it. At defaults
// (1000 rows every 60th 1s tick) one replica drains ~1000 rows/minute, so
// ~1.4M/day -- the sizing target if a deployment ever outgrows it.
//
// Keys on created_at rather than on when the row went terminal, which assumes
// rows do not sit queued for a meaningful fraction of the retention window. At
// 30 days against a ~33-minute retry ladder that holds comfortably; if the
// retention window is ever configured near the ladder's span, a long-queued row
// could be pruned in the tick it is sent, taking its attempt history with it.
export async function pruneTerminal(
	database: Database,
	retentionMs: number,
	batchSize: number,
): Promise<number> {
	const { rowCount } = await database.execute(sql`
		delete from notification_outbox
		where ctid in (
			select ctid from notification_outbox
			where status in ('sent', 'abandoned', 'failed')
				and created_at < now() - ${interval(retentionMs)}
			limit ${batchSize}
		)
	`);
	return rowCount ?? 0;
}

// `applied: false` means the row was reclaimed while this worker was sending.
// The fence is what stops a late completion from overwriting `sent` with
// `failed`, resurrecting a terminal row for a third delivery, or clobbering
// `attempts` so the MAX_ATTEMPTS bound stops applying (C11).
export async function completeDelivery(
	database: Database,
	row: OutboxRow,
	result: ProviderResult,
	replicaId: string,
): Promise<{ applied: boolean; decision: RetryDecision }> {
	const attemptNo = row.attempts + 1;
	const decision = classifyRetry(result, attemptNo, Math.random());
	const status =
		decision.kind === "done"
			? "sent"
			: decision.kind === "permanent"
				? "failed"
				: "queued";
	const nextAttemptAt =
		decision.kind === "retry"
			? sql`now() + ${interval(decision.delayMs)}`
			: sql`next_attempt_at`;

	return await database.transaction(async (tx) => {
		const { rowCount } = await tx.execute(sql`
			update notification_outbox
			set status = ${status}::outbox_status,
				attempts = ${attemptNo},
				next_attempt_at = ${nextAttemptAt},
				claimed_at = null,
				claimed_by = null
			where id = ${row.id} and claimed_by = ${replicaId} and status = 'sending'
		`);
		if (!rowCount) {
			console.warn(
				`worker: outbox row ${row.id} was reclaimed while ${replicaId} was sending; discarding the result`,
			);
			return { applied: false, decision };
		}
		await tx.insert(tables.deliveryAttempt).values({
			id: randomUUID(),
			outboxId: row.id,
			attemptNo,
			providerStatus: result.status ?? null,
			retryClass: decision.retryClass,
			error: result.ok ? null : sanitizeError(result.error),
		});
		return { applied: true, decision };
	});
}

// The module that owns the lease owns the timeout. An adapter that never
// settles would otherwise block the tick forever, and croner's `protect` then
// suppresses every subsequent tick: that replica silently stops claiming,
// reclaiming and pruning off a single bad row. Freeing the worker slot is what
// the batch wall-clock bound depends on; aborting the signal is what stops the
// abandoned request from holding its socket open behind us.
async function sendWithDeadline(
	send: SendFn,
	row: OutboxRow,
	deadlineMs: number,
): Promise<ProviderResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			send(row, controller.signal),
			new Promise<ProviderResult>((resolve) => {
				timer = setTimeout(
					() => resolve({ ok: false, error: "adapter deadline exceeded" }),
					deadlineMs,
				);
			}),
		]);
	} catch (error) {
		// A throwing adapter is a transport failure, not a reason to strand the
		// row in `sending` until its lease expires.
		return { ok: false, error: String(error) };
	} finally {
		clearTimeout(timer);
		// Safe on the success path too: the adapter has already read everything
		// it needed to build its ProviderResult by the time it resolves.
		controller.abort();
	}
}

// Bounded concurrency, not a serial drain: all rows in a batch share one
// claimed_at, so a serial loop gives the last row an effective deadline of
// batchSize * adapterDeadlineMs and pushes it past the lease. See the
// cross-field check in config/worker.ts.
async function dispatchBatch(
	rows: OutboxRow[],
	concurrency: number,
	run: (row: OutboxRow) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const lanes = Array.from(
		{ length: Math.min(concurrency, rows.length) },
		async () => {
			while (cursor < rows.length) {
				const row = rows[cursor++];
				try {
					await run(row);
				} catch (error) {
					// `run` handles its own failures; this only keeps one unforeseen
					// rejection from tearing down Promise.all with sibling lanes
					// still in flight and their later rejections unhandled.
					console.error(`worker: lane failed on row ${row.id}:`, error);
				}
			}
		},
	);
	await Promise.all(lanes);
}

export async function workerTick(
	database: Database,
	options: WorkerOptions,
): Promise<WorkerSummary> {
	const { timing, replicaId } = options;
	const reclaim = await reclaimExpired(
		database,
		timing.leaseMs,
		timing.batchSize,
	);
	const skipPrune = options.prune === false;
	const pruned = skipPrune
		? 0
		: await pruneTerminal(database, timing.retentionMs, timing.pruneBatchSize);
	const prunedCapabilities = skipPrune
		? 0
		: await pruneAckCapabilities(database, timing.pruneBatchSize);
	const prunedRateBuckets = skipPrune
		? 0
		: await pruneRateBuckets(database, timing.pruneBatchSize);
	const claimed = await claimBatch(database, timing.batchSize, replicaId);
	// Claimed and committed, nothing dispatched: the shape the lease reclaim has
	// to recover.
	if (claimed.length > 0) options.crash?.("mid-claim");

	const summary: WorkerSummary = {
		...reclaim,
		pruned,
		prunedCapabilities,
		prunedRateBuckets,
		claimed: claimed.length,
		sent: 0,
		failed: 0,
		retried: 0,
		fenced: 0,
		errored: 0,
	};

	await dispatchBatch(claimed, timing.sendConcurrency, async (row) => {
		options.crash?.("before-send");
		const result = await sendWithDeadline(
			options.send,
			row,
			timing.adapterDeadlineMs,
		);
		// The provider has accepted; the local commit has not happened. This
		// window is sub-millisecond and is exactly where at-least-once stops
		// being exactly-once.
		options.crash?.("after-send");
		let outcome: Awaited<ReturnType<typeof completeDelivery>>;
		try {
			outcome = await completeDelivery(database, row, result, replicaId);
		} catch (error) {
			// The row stays `sending` with claimed_by intact, so the lease
			// reclaim recovers it rather than it being lost here.
			summary.errored++;
			console.error(`worker: recording outbox row ${row.id} failed:`, error);
			return;
		}
		if (!outcome.applied) summary.fenced++;
		else if (outcome.decision.kind === "done") summary.sent++;
		else if (outcome.decision.kind === "retry") summary.retried++;
		else summary.failed++;
	});
	return summary;
}

export function startWorker(
	database: Database,
	send: SendFn,
	env: NodeJS.ProcessEnv = process.env,
	// Accepted so a caller that already resolved the timing (to build the send
	// fn's deadline) does not parse the environment a second time.
	timing: WorkerTiming = workerTiming(env),
): Cron {
	const replicaId = resolveReplicaId(env);
	const crash = crashHook(env);
	let tick = 0;
	return new Cron(
		"* * * * * *",
		{
			interval: Math.max(1, Math.round(timing.tickMs / 1000)),
			protect: () =>
				console.warn("worker: previous tick still running, skipping"),
		},
		async () => {
			try {
				await workerTick(database, {
					send,
					timing,
					replicaId,
					prune: tick++ % timing.pruneCadenceTicks === 0,
					crash,
				});
			} catch (error) {
				console.error("worker: tick failed:", error);
			}
		},
	);
}
