// Outbox drain loop. Runs on EVERY replica with no leader lock: the claim is
// mediated by FOR UPDATE SKIP LOCKED, and a dead claimer is recovered by the
// lease reclaim rather than by a lock timeout. Sending itself is injected
// (SendFn) so Task 12 owns the adapters and this module owns only the
// at-least-once bookkeeping.
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { WorkerTiming } from "../../config/worker.ts";
import {
	replicaId as resolveReplicaId,
	workerTiming,
} from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import { redactChannelUrl } from "../../domain/notification-channel.ts";
import type {
	ProviderResult,
	RetryDecision,
} from "../../domain/notification-retry.ts";
import {
	classifyRetry,
	MAX_ATTEMPTS,
} from "../../domain/notification-retry.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

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
export type SendFn = (row: OutboxRow) => Promise<ProviderResult>;

export type WorkerSummary = {
	reclaimed: number;
	abandoned: number;
	pruned: number;
	claimed: number;
	sent: number;
	failed: number;
	retried: number;
	fenced: number;
};

export type WorkerOptions = {
	send: SendFn;
	timing?: WorkerTiming;
	// Required, not defaulted: a fallback resolved per call would mint a fresh
	// id every tick, and a caller whose claim and completion span two ticks
	// could then never fence its own writes.
	replicaId: string;
};

const ERROR_MAX_LENGTH = 300;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

// Redact BEFORE truncating (C15): truncation can cut a URL mid-token so the
// redaction pattern no longer matches, persisting a partial webhook or bot
// token into delivery_attempt.error, which surfaces in the operator view.
function sanitizeError(message: string): string {
	const redacted = message.replace(URL_IN_TEXT, redactChannelUrl);
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
	database: Database,
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
export async function reclaimExpired(
	database: Database,
	leaseMs: number,
): Promise<{ reclaimed: number; abandoned: number }> {
	const { rows } = await database.execute<{ status: string }>(sql`
		update notification_outbox
		set status = (case when attempts + 1 >= ${MAX_ATTEMPTS} then 'abandoned' else 'queued' end)::outbox_status,
			attempts = attempts + 1,
			claimed_at = null,
			claimed_by = null
		where status = 'sending' and claimed_at < now() - ${interval(leaseMs)}
		returning status
	`);
	const abandoned = rows.filter((row) => row.status === "abandoned").length;
	return { reclaimed: rows.length - abandoned, abandoned };
}

// `failed` belongs here (C14): the permanent-failure branch writes it, and a
// misconfigured channel returning 401 forever is the one genuinely unbounded
// growth case this prune exists to bound. delivery_attempt cascades.
export async function pruneTerminal(
	database: Database,
	retentionMs: number,
): Promise<number> {
	const { rowCount } = await database.execute(sql`
		delete from notification_outbox
		where status in ('sent', 'abandoned', 'failed')
			and created_at < now() - ${interval(retentionMs)}
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

export async function workerTick(
	database: Database,
	options: WorkerOptions,
): Promise<WorkerSummary> {
	const timing = options.timing ?? workerTiming(process.env);
	const { replicaId } = options;
	const reclaim = await reclaimExpired(database, timing.leaseMs);
	// Bounds table growth. Terminal rows are invisible to the per-user cap,
	// which counts only queued + sending, so this is not what keeps that honest.
	const pruned = await pruneTerminal(database, timing.retentionMs);
	const claimed = await claimBatch(database, timing.batchSize, replicaId);

	const summary: WorkerSummary = {
		...reclaim,
		pruned,
		claimed: claimed.length,
		sent: 0,
		failed: 0,
		retried: 0,
		fenced: 0,
	};

	for (const row of claimed) {
		let result: ProviderResult;
		try {
			result = await options.send(row);
		} catch (error) {
			// A throwing adapter is a transport failure, not a reason to strand
			// the row in `sending` until its lease expires.
			result = { ok: false, error: String(error) };
		}
		let outcome: Awaited<ReturnType<typeof completeDelivery>>;
		try {
			outcome = await completeDelivery(database, row, result, replicaId);
		} catch (error) {
			console.error(`worker: recording outbox row ${row.id} failed:`, error);
			continue;
		}
		if (!outcome.applied) summary.fenced++;
		else if (outcome.decision.kind === "done") summary.sent++;
		else if (outcome.decision.kind === "retry") summary.retried++;
		else summary.failed++;
	}
	return summary;
}

export type OutboxInsert = {
	reminderStateId: string | null;
	recipientUserId: string;
	channelKind: ChannelKind;
	payload: unknown;
	idempotencyKey: string;
	nextAttemptAt: Date;
};

export type EnqueueOptions = {
	maxQueuedPerUser: number;
	// Per-tick dedupe for the refusal warning. A silently dropped notification
	// reads as a delivery bug later, but one line per refused row is a flood.
	refusedLogged?: Set<string>;
};

// Bounds a runaway recurrence or an event storm per user rather than letting it
// fill the disk (design §6).
export async function enqueueOutbox(
	database: Database | Transaction,
	row: OutboxInsert,
	options: EnqueueOptions,
): Promise<"inserted" | "duplicate" | "refused"> {
	const [queued] = await database
		.select({ count: sql<number>`count(*)::int` })
		.from(tables.notificationOutbox)
		.where(
			and(
				eq(tables.notificationOutbox.recipientUserId, row.recipientUserId),
				inArray(tables.notificationOutbox.status, ["queued", "sending"]),
			),
		);

	if (queued.count >= options.maxQueuedPerUser) {
		if (!options.refusedLogged?.has(row.recipientUserId)) {
			options.refusedLogged?.add(row.recipientUserId);
			console.warn(
				`worker: user ${row.recipientUserId} is at the outbox cap (${options.maxQueuedPerUser}); refusing further notifications this tick`,
			);
		}
		// C13: leaving the reminder `pending` with no outbox row is permanent
		// limbo, and reminder_state IS synced -- it must tell the user the truth
		// rather than showing a reminder that never resolves.
		if (row.reminderStateId) {
			await database
				.update(tables.reminderState)
				.set({ status: "failed", nextAttemptAt: null, deferredUntil: null })
				.where(eq(tables.reminderState.id, row.reminderStateId));
		}
		return "refused";
	}

	const inserted = await database
		.insert(tables.notificationOutbox)
		.values({
			id: randomUUID(),
			reminderStateId: row.reminderStateId,
			recipientUserId: row.recipientUserId,
			channelKind: row.channelKind,
			payload: row.payload,
			idempotencyKey: row.idempotencyKey,
			status: "queued",
			nextAttemptAt: row.nextAttemptAt,
		})
		.onConflictDoNothing()
		.returning({ id: tables.notificationOutbox.id });
	return inserted.length > 0 ? "inserted" : "duplicate";
}

export function startWorker(
	database: Database,
	send: SendFn,
	env: NodeJS.ProcessEnv = process.env,
): Cron {
	const timing = workerTiming(env);
	const replicaId = resolveReplicaId(env);
	return new Cron(
		"* * * * * *",
		{
			interval: Math.max(1, Math.round(timing.tickMs / 1000)),
			protect: () =>
				console.warn("worker: previous tick still running, skipping"),
		},
		async () => {
			try {
				await workerTick(database, { send, timing, replicaId });
			} catch (error) {
				console.error("worker: tick failed:", error);
			}
		},
	);
}
