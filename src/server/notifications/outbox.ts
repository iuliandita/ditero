// Fill side of the outbox. Deliberately separate from worker.ts: the drain
// loop runs on every replica, while the enqueue callers are the leader-locked
// scheduler and (Task 14) request handlers, and neither should import the
// other's module to reach this.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

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
	// Dedupe for the refusal warning, one entry per user per caller-defined
	// window. Required: a caller that omitted it would get exactly the flood
	// this exists to prevent.
	refusedLogged: Set<string>;
};

export type EnqueueOutcome = "inserted" | "duplicate" | "refused";

// Bounds a runaway recurrence or an event storm per user rather than letting it
// fill the disk (design §6).
//
// The cap check and the insert are one statement so there is no round-trip for
// a concurrent enqueue to slip through -- Task 14 enqueues from request
// handlers, which are concurrent by construction. Note this narrows the race
// rather than closing it: under READ COMMITTED both statements still read the
// same snapshot, so simultaneous enqueues can overshoot by a few rows. That is
// acceptable for a disk-growth guard and would need a constraint or an advisory
// lock to make exact.
export async function enqueueOutbox(
	database: Database | Transaction,
	row: OutboxInsert,
	options: EnqueueOptions,
): Promise<EnqueueOutcome> {
	const { rows } = await database.execute<{
		queued: number;
		inserted: number;
	}>(sql`
		with cap as (
			select count(*)::int as queued
			from notification_outbox
			where recipient_user_id = ${row.recipientUserId}
				and status in ('queued', 'sending')
		),
		ins as (
			insert into notification_outbox (
				id, reminder_state_id, recipient_user_id, channel_kind,
				payload, idempotency_key, status, next_attempt_at
			)
			select
				${randomUUID()}, ${row.reminderStateId}, ${row.recipientUserId},
				${row.channelKind}::channel_kind, ${JSON.stringify(row.payload)}::jsonb,
				${row.idempotencyKey}, 'queued', ${row.nextAttemptAt.toISOString()}::timestamptz
			from cap
			where cap.queued < ${options.maxQueuedPerUser}
			on conflict do nothing
			returning id
		)
		select
			(select queued from cap) as queued,
			(select count(*)::int from ins) as inserted
	`);

	const result = rows[0];
	if (result.inserted > 0) return "inserted";
	if (result.queued >= options.maxQueuedPerUser) {
		if (!options.refusedLogged.has(row.recipientUserId)) {
			options.refusedLogged.add(row.recipientUserId);
			console.warn(
				`outbox: user ${row.recipientUserId} is at the queue cap (${options.maxQueuedPerUser}); refusing further notifications`,
			);
		}
		return "refused";
	}
	return "duplicate";
}
