// Ack capability: mint primitives, the atomic redeem, the IP token bucket, and
// the expired/consumed prune.
//
// The redeem consumes BEFORE it validates. An empty consume result means
// invalid, expired or already consumed -- indistinguishable to the caller -- and
// a binding mismatch found after the consume still commits the burn. Validating
// first would leave the token alive after a failed attempt, letting an attacker
// who guessed a token retry it with a corrected binding.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, ne, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../db/schema.ts";
import {
	ACK_TERMINAL_STATUSES,
	AckCompletionDenied,
	type AckStore,
	ackedPatch,
	completeForAck,
} from "../../domain/ack-complete.ts";
import { karmaWrite } from "../../domain/karma.ts";

type Database = NodePgDatabase<typeof tables>;
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Path of the public capability route. Exported so the minting and serving
// sides cannot drift into links nobody answers.
export const ACK_PATH = "/api/notifications/ack";
// The only action minted today. Bindings are checked on consume, so a
// capability minted for one action must not redeem another (C27).
export const ACK_ACTION = "complete";
// A test send carries a live capability of this action instead: outbound
// success proves half a round trip, and for Discord app mode the half that
// silently lies is the outbound one. Redeeming it is what proves the inbound
// listener works, so it stamps verified_at and clears the channel's last error.
export const ACK_VERIFY_ACTION = "verify";
// Long enough to walk to the phone the test landed on, short enough that a
// leaked test message is not an indefinite write primitive. Deliberately not
// the reminder ladder's 24h: nothing escalates a test.
export const VERIFY_TTL_MS = 3_600_000;
// The `via` values that name a chat provider's own inbound listener. Anything
// else ("capability", "in_app") is this deployment's own ack path.
const REDEEMING_CHANNEL_KINDS = new Set<string>(
	tables.channelKindEnum.enumValues,
);
// Comfortably outlives the ~33-minute retry ladder and any escalation ladder,
// while bounding how long a leaked notification stays actionable.
export const ACK_TTL_MS = 24 * 3_600_000;
export const ACK_TOKEN_BYTES = 32;

// One uniform rejection for every failure class: unknown, expired, consumed,
// mis-bound recipient, wrong action, denied completion.
export const ACK_REJECT_STATUS = 400;
export const ACK_REJECT_BODY = "This link is no longer valid.";

// C26: a garbage token returns after one indexed lookup; a mis-bound one after
// a consume, two reads and a rollback -- reliably tens of ms later. That gap is
// a working oracle for "this token was real", so every rejection is padded to a
// fixed floor.
export const REJECT_FLOOR_MS = 250;

// Bucket defaults for the public route. Refill is per second.
export const ACK_RATE_CAPACITY = 30;
export const ACK_RATE_REFILL_PER_SEC = 0.5;
// An untouched bucket older than this is treated as full, so a key that fell to
// zero and was never retried cannot stay empty forever.
export const ACK_RATE_IDLE_RESET_MS = 3_600_000;

export function ackToken(): string {
	return randomBytes(ACK_TOKEN_BYTES).toString("base64url");
}

export function hashAckToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// Public origin the ack link points at. No general public-origin config existed
// before this route, and BETTER_AUTH_URL is the nearest thing the deployment
// already sets, so it is the fallback. Null disables the ack action rather than
// minting a link no push client can follow.
export function ackBaseUrl(
	env: Record<string, string | undefined>,
): string | null {
	const configured =
		env.DITERO_PUBLIC_URL?.trim() || env.BETTER_AUTH_URL?.trim();
	return configured ? configured : null;
}

// Single atomic statement: read-modify-write in application code would let two
// replicas both see the last token. Zero rows means the bucket is empty.
//
// Two things here are load-bearing and were wrong in the obvious formulation.
// The predicate tests the REFILLED balance, not the stored one: gating refill
// behind `tokens > 0` means an emptied bucket can never recover through the
// mechanism meant to recover it. And `refilled_at` advances only by the whole
// tokens actually credited, never to now(): at a sub-1/s rate, resetting the
// clock on every accepted request floors the credit to 0 forever, so the
// steady-state refill would be exactly zero rather than refillPerSec.
export async function takeRateToken(
	database: Database,
	key: string,
	capacity: number,
	refillPerSec: number,
	idleResetMs: number = ACK_RATE_IDLE_RESET_MS,
): Promise<boolean> {
	// Cast explicitly: Postgres infers a bound parameter's type from context, and
	// `${refillPerSec} > 0` alone infers integer, which rejects the 0.5/s default
	// outright ("invalid input syntax for type integer").
	const rate = sql`${refillPerSec}::double precision`;
	const idle = sql`rate_bucket.refilled_at < now() - make_interval(secs => ${idleResetMs / 1000}::double precision)`;
	const credit = sql`floor(extract(epoch from now() - rate_bucket.refilled_at) * ${rate})`;
	const refilled = sql`least(${capacity}, rate_bucket.tokens + ${credit})`;
	const { rows } = await database.execute<{ tokens: number }>(sql`
		insert into rate_bucket (key, tokens, refilled_at)
		values (${key}, ${capacity - 1}, now())
		on conflict (key) do update
		set tokens = (case when ${idle} then ${capacity} else ${refilled} end) - 1,
			refilled_at = case
				when ${idle} then now()
				-- Guarded: a zero rate credits nothing, and dividing by it would
				-- abort the statement rather than simply not refilling.
				when ${rate} > 0
					then rate_bucket.refilled_at
						+ make_interval(secs => ${credit} / ${rate})
				else rate_bucket.refilled_at
			end
		where ${refilled} > 0 or ${idle}
		returning tokens
	`);
	return rows.length > 0;
}

// A row past expires_at OR already consumed is dead. Task 12 mints a fresh
// capability per attempt by design, so an exhausted ladder leaves up to
// MAX_ATTEMPTS rows behind; nothing else deletes them. Batched on ctid, the
// same shape as the outbox prune, rather than a second scheme.
export async function pruneAckCapabilities(
	database: Database,
	batchSize: number,
): Promise<number> {
	const { rowCount } = await database.execute(sql`
		delete from ack_capability
		where ctid in (
			select ctid from ack_capability
			where expires_at < now() or consumed_at is not null
			limit ${batchSize}
		)
	`);
	return rowCount ?? 0;
}

// The ack route is public and unauthenticated, so every distinct client address
// writes a permanent rate_bucket row and nothing else deletes them. A row
// untouched for longer than the idle window is already treated as full, so
// deleting it changes no decision. The margin over idleResetMs keeps a bucket
// that is still being refilled out of the delete's way.
export async function pruneRateBuckets(
	database: Database,
	batchSize: number,
	idleResetMs: number = ACK_RATE_IDLE_RESET_MS,
): Promise<number> {
	const cutoff = sql`now() - make_interval(secs => ${(2 * idleResetMs) / 1000}::double precision)`;
	const { rowCount } = await database.execute(sql`
		delete from rate_bucket
		where ctid in (
			select ctid from rate_bucket
			where refilled_at < ${cutoff}
			limit ${batchSize}
		)
	`);
	return rowCount ?? 0;
}

function drizzleAckStore(tx: DbTransaction): AckStore {
	return {
		async task(taskId) {
			const rows = await tx
				.select({
					id: tables.task.id,
					workspaceId: tables.list.workspaceId,
					listKind: tables.list.kind,
					rrule: tables.task.rrule,
					recurrenceRelative: tables.task.recurrenceRelative,
					dueAt: tables.task.dueAt,
					done: tables.task.done,
					priority: tables.task.priority,
				})
				.from(tables.task)
				.innerJoin(tables.list, eq(tables.task.listId, tables.list.id))
				.where(eq(tables.task.id, taskId))
				.limit(1);
			const row = rows[0];
			if (!row) return null;
			return {
				...row,
				dueAt: row.dueAt ? row.dueAt.getTime() : null,
			};
		},
		async role(userId, workspaceId) {
			const rows = await tx
				.select({ role: tables.membership.role })
				.from(tables.membership)
				.where(
					and(
						eq(tables.membership.userId, userId),
						eq(tables.membership.workspaceId, workspaceId),
					),
				)
				.limit(1);
			return rows[0]?.role ?? null;
		},
		async timezone(userId) {
			const rows = await tx
				.select({ timezone: tables.userPref.timezone })
				.from(tables.userPref)
				.where(eq(tables.userPref.id, userId))
				.limit(1);
			return rows[0]?.timezone ?? "UTC";
		},
		async updateTask(id, patch) {
			await tx
				.update(tables.task)
				.set({
					done: patch.done,
					completedAt: patch.completedAt ? new Date(patch.completedAt) : null,
					...(patch.dueAt === undefined
						? {}
						: { dueAt: patch.dueAt === null ? null : new Date(patch.dueAt) }),
				})
				.where(eq(tables.task.id, id));
		},
		async habitLog(habitId, date) {
			const rows = await tx
				.select({
					id: tables.habitLog.id,
					status: tables.habitLog.status,
					karmaDelta: tables.habitLog.karmaDelta,
				})
				.from(tables.habitLog)
				.where(
					and(
						eq(tables.habitLog.habitId, habitId),
						eq(tables.habitLog.date, date),
					),
				)
				.limit(1);
			return rows[0] ?? null;
		},
		async putHabitLog(row) {
			const completedAt = new Date(row.completedAt);
			if (row.existingId) {
				await tx
					.update(tables.habitLog)
					.set({ status: "done", karmaDelta: row.karmaDelta, completedAt })
					.where(eq(tables.habitLog.id, row.existingId));
				return;
			}
			await tx.insert(tables.habitLog).values({
				id: randomUUID(),
				habitId: row.habitId,
				date: row.date,
				status: "done",
				karmaDelta: row.karmaDelta,
				completedAt,
			});
		},
		async awardKarma(userId, delta, reason, date) {
			const now = new Date();
			const existing = await tx
				.select({ points: tables.karma.points })
				.from(tables.karma)
				.where(eq(tables.karma.userId, userId))
				.limit(1);
			const next = karmaWrite(existing[0]?.points ?? 0, delta);
			if (existing.length > 0) {
				await tx
					.update(tables.karma)
					.set({ ...next, updatedAt: now })
					.where(eq(tables.karma.userId, userId));
			} else {
				await tx
					.insert(tables.karma)
					.values({ userId, ...next, updatedAt: now });
			}
			await tx.insert(tables.karmaEvent).values({
				id: randomUUID(),
				userId,
				date,
				delta,
				reason,
				createdAt: now,
			});
		},
	};
}

// Redeem a capability token. Returns the recipient the capability was bound to,
// or null for every rejection class; the caller must not distinguish them.
// Throwing out of the transaction body is how a denied completion rolls the
// consume back -- the token stays usable once the denial is fixed -- while a
// binding mismatch returns null and keeps the burn.
//
// The recipient is returned rather than a bare boolean because a channel
// listener resolves a callback to several possible recipients (a group chat one
// whole family is bound to) and has to answer the provider with THAT user's
// credentials, not an arbitrary member's.
export async function redeemAckCapability(
	database: Database,
	token: string,
	via: string,
	now: number = Date.now(),
	// Channel listeners bind the callback's sender to the capability's
	// recipient (design 5). Checked after the consume, like every other binding
	// here: a mismatch keeps the burn rather than leaving the token alive for a
	// corrected retry.
	options: { allowedRecipients?: readonly string[] } = {},
): Promise<string | null> {
	try {
		return await database.transaction(async (tx) => {
			const { rows } = await tx.execute<{
				reminder_state_id: string | null;
				recipient_user_id: string;
				action: string;
				channel_kind: string | null;
			}>(sql`
				update ack_capability
				set consumed_at = now()
				where token_hash = ${hashAckToken(token)}
					and consumed_at is null
					and expires_at > now()
				returning reminder_state_id, recipient_user_id, action, channel_kind
			`);
			const capability = rows[0];
			// Unknown, expired or already consumed -- one outcome, by design.
			if (!capability) return null;
			if (
				options.allowedRecipients !== undefined &&
				!options.allowedRecipients.includes(capability.recipient_user_id)
			) {
				return null;
			}
			if (capability.action === ACK_VERIFY_ACTION) {
				if (capability.channel_kind === null) return null;
				// A capability minted for Discord must not be redeemable through the
				// Telegram or Slack listener: stamping "verified" is a claim that
				// THAT channel's inbound leg works, which is the entire point of
				// making the test an ack round trip. `via` is the redeeming channel's
				// kind at every listener and "capability" at the link route, which is
				// a legitimate ack path for any kind.
				if (
					REDEEMING_CHANNEL_KINDS.has(via) &&
					via !== capability.channel_kind
				) {
					return null;
				}
				await tx
					.update(tables.notificationChannel)
					.set({
						verifiedAt: new Date(now),
						ackVerifiedAt: new Date(now),
						lastErrorAt: null,
						lastErrorCode: null,
						updatedAt: new Date(now),
					})
					.where(
						and(
							eq(
								tables.notificationChannel.userId,
								capability.recipient_user_id,
							),
							eq(
								tables.notificationChannel.kind,
								capability.channel_kind as (typeof tables.channelKindEnum.enumValues)[number],
							),
						),
					);
				return capability.recipient_user_id;
			}
			if (capability.action !== ACK_ACTION) return null;
			if (capability.reminder_state_id === null) return null;

			const reminders = await tx
				.select()
				.from(tables.reminderState)
				.where(eq(tables.reminderState.id, capability.reminder_state_id))
				.limit(1);
			const reminder = reminders[0];
			if (!reminder) return null;
			// A capability minted for one recipient must not act as another's,
			// even if both are on the same occurrence.
			if (reminder.recipientUserId !== capability.recipient_user_id) {
				return null;
			}

			// Completion runs first so its outcome can be recorded on the row: a
			// denial throws and rolls everything back, so nothing observes the
			// intermediate order.
			const outcome = await completeForAck(
				drizzleAckStore(tx),
				{
					taskId: reminder.taskId,
					occurrenceAt: reminder.occurrenceAt.getTime(),
					recipientUserId: reminder.recipientUserId,
				},
				capability.recipient_user_id,
				now,
			);
			const patch = ackedPatch(now, via, outcome);
			const acked = { ...patch, ackedAt: new Date(patch.ackedAt) };
			await tx
				.update(tables.reminderState)
				.set(acked)
				.where(eq(tables.reminderState.id, reminder.id));
			// C7: acking terminates every sibling on the same occurrence, or a
			// co-assignee's phone keeps escalating a reminder someone already acked.
			await tx
				.update(tables.reminderState)
				.set(acked)
				.where(
					and(
						eq(tables.reminderState.taskId, reminder.taskId),
						eq(tables.reminderState.occurrenceAt, reminder.occurrenceAt),
						ne(tables.reminderState.id, reminder.id),
						notInArray(tables.reminderState.status, [...ACK_TERMINAL_STATUSES]),
					),
				);
			return capability.recipient_user_id;
		});
	} catch (error) {
		// A denied completion rolled the whole transaction back, consume included.
		if (error instanceof AckCompletionDenied) return null;
		throw error;
	}
}
