// Event notifications: assignment, @-mention and overdue. These share the
// outbox with reminders but have no reminder_state row, so they never escalate,
// never ack, and are deferred (never dropped) by quiet hours through
// notification_outbox.next_attempt_at, which the worker's claim already filters
// on.
//
// Enqueue is NOT atomic with the mutation that caused it: mutators only record
// intent (zero/event-sink.ts) and the /api/zero/mutate handler enqueues after
// handleMutateRequest resolves, outside the mutator transaction. A crash
// between commit and enqueue therefore loses the notification. That is the
// deliberate trade -- the alternative couples Zero's transaction to a table Zero
// cannot see, and a missed assignment notice is recoverable in a way a phantom
// one is not.
import { AsyncLocalStorage } from "node:async_hooks";
import { Cron } from "croner";
import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { schedulerTiming } from "../../config/scheduler.ts";
import { maxQueuedPerUser } from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import { instantToWallClock } from "../../domain/zoned.ts";
import {
	type NotificationEvent,
	type PendingEvent,
	setEventSink,
} from "../../zero/event-sink.ts";
import { type EnqueueOptions, enqueueOutbox } from "./outbox.ts";
import {
	DEFAULT_PREF,
	decideQuietHours,
	loadChannels,
	loadPrefs,
} from "./recipients.ts";
import { withLeaderLock } from "./scheduler.ts";

type Database = NodePgDatabase<typeof tables>;
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

export const OVERDUE_LOCK_KEY = 918275;

// A task overdue for longer than this stops nagging. Without it an abandoned
// task notifies its assignees once per local day forever, and the sweep's scan
// grows without bound.
export const OVERDUE_LOOKBACK_MS = 30 * 24 * 3_600_000;

// Stamped when the server collects the event, not by the mutator: the mutator
// also runs on the client, where nothing is collected. It discriminates assign
// keys, so assign -> unassign -> re-assign notifies again instead of losing to
// the retained (up to 30 days) outbox row's unique constraint. Uniqueness, not
// dedupe: the sequence guarantees distinctness within a millisecond, and there
// is no second producer of the same assign event to dedupe against.
export type CollectedEvent = PendingEvent & { stamp: string };

const collector = new AsyncLocalStorage<CollectedEvent[]>();
let sequence = 0;

// Installed at import. The sink is a module global by necessity (mutators.ts
// ships to the client and cannot import node:async_hooks), but the store it
// writes to is request-scoped, so concurrent requests never share a buffer.
setEventSink((pending) => {
	const stamp = `${Date.now()}-${sequence++}`;
	collector.getStore()?.push({ ...pending, stamp });
});

// Runs `fn` with its own collection buffer. The caller enqueues the buffer only
// if `fn` resolved: a mutator that throws server-side rolls back, and its
// collected events must be discarded with it.
export async function withEventCollector<T>(
	into: CollectedEvent[],
	fn: () => Promise<T>,
): Promise<T> {
	return await collector.run(into, fn);
}

export type EventPayload = {
	kind: NotificationEvent["kind"] | "overdue";
	taskId: string;
	taskTitle: string;
	actorUserId?: string;
	commentId?: string;
	dueAt?: string;
};

function payloadFor(event: NotificationEvent): EventPayload {
	if (event.kind === "assign") {
		return {
			kind: "assign",
			taskId: event.taskId,
			taskTitle: event.taskTitle,
			actorUserId: event.actorUserId,
		};
	}
	return {
		kind: "mention",
		taskId: event.taskId,
		taskTitle: event.taskTitle,
		commentId: event.commentId,
		actorUserId: event.actorUserId,
	};
}

function keyFor(collected: CollectedEvent, channelKind: ChannelKind): string {
	const { event, recipientUserId, stamp } = collected;
	return event.kind === "assign"
		? `assign:${event.taskId}:${recipientUserId}:${channelKind}:${stamp}`
		: `mention:${event.commentId}:${recipientUserId}:${channelKind}`;
}

type EnqueueEventOptions = {
	now?: Date;
	maxQueuedPerUser?: number;
};

// One outbox row per (event, recipient, enabled channel). The channel is part of
// the idempotency key or a user with two channels would be notified once.
async function enqueueRows(
	database: Database,
	recipientUserId: string,
	channels: ChannelKind[],
	payload: EventPayload,
	key: (channelKind: ChannelKind) => string,
	nextAttemptAt: Date,
	cap: EnqueueOptions,
): Promise<number> {
	let enqueued = 0;
	for (const channelKind of channels) {
		const outcome = await enqueueOutbox(
			database,
			{
				// Event rows carry no reminder: nothing escalates them and dispatch
				// mints no ack capability (ack_capability.reminder_state_id is NOT
				// NULL). C13's terminate step is skipped for the same reason -- there
				// is no reminder_state row to mark failed.
				reminderStateId: null,
				recipientUserId,
				channelKind,
				payload,
				idempotencyKey: key(channelKind),
				nextAttemptAt,
			},
			cap,
		);
		if (outcome === "inserted") enqueued++;
		else if (outcome === "refused") {
			console.warn(
				`events: dropped ${payload.kind} notification for user ${recipientUserId} on ${channelKind}; the user is at the outbox cap`,
			);
		}
	}
	return enqueued;
}

export async function enqueueEvents(
	database: Database,
	collected: CollectedEvent[],
	options: EnqueueEventOptions = {},
): Promise<number> {
	if (collected.length === 0) return 0;
	const now = options.now ?? new Date();
	const recipients = [...new Set(collected.map((c) => c.recipientUserId))];
	const prefs = await loadPrefs(database, recipients);
	const channels = await loadChannels(database, recipients);
	const cap: EnqueueOptions = {
		maxQueuedPerUser: options.maxQueuedPerUser ?? maxQueuedPerUser(process.env),
		refusedLogged: new Set(),
	};

	let enqueued = 0;
	for (const item of collected) {
		const userChannels = channels.get(item.recipientUserId) ?? [];
		if (userChannels.length === 0) continue;
		const pref = prefs.get(item.recipientUserId) ?? DEFAULT_PREF;
		const decision = decideQuietHours(pref, false, now, item.recipientUserId);
		enqueued += await enqueueRows(
			database,
			item.recipientUserId,
			userChannels,
			payloadFor(item.event),
			(channelKind) => keyFor(item, channelKind),
			decision.kind === "defer" ? decision.until : now,
			cap,
		);
	}
	return enqueued;
}

// Enqueue that never propagates: it runs after the mutation has committed, so
// throwing here would report a failed mutation the client has already applied.
export async function enqueueEventsSafely(
	database: Database,
	collected: CollectedEvent[],
): Promise<void> {
	if (collected.length === 0) return;
	try {
		await enqueueEvents(database, collected);
	} catch (error) {
		console.error("events: enqueue after commit failed:", error);
	}
}

type OverdueRow = {
	taskId: string;
	title: string;
	// The `dueAt < now` predicate already excludes NULL; typed nullable only
	// because the column is.
	dueAt: Date | null;
	listOwnerId: string;
};

export type OverdueSummary = { scanned: number; enqueued: number };

export async function overdueSweep(
	database: Database,
	options: EnqueueEventOptions = {},
): Promise<OverdueSummary> {
	const now = options.now ?? new Date();
	const rows: OverdueRow[] = await database
		.select({
			taskId: tables.task.id,
			title: tables.task.title,
			dueAt: tables.task.dueAt,
			listOwnerId: tables.list.ownerId,
		})
		.from(tables.task)
		.innerJoin(tables.list, eq(tables.task.listId, tables.list.id))
		.where(
			and(
				eq(tables.task.done, false),
				lt(tables.task.dueAt, now),
				gte(tables.task.dueAt, new Date(now.getTime() - OVERDUE_LOOKBACK_MS)),
				// Habits are never "finished" and so are never overdue; they have
				// their own reminder path.
				ne(tables.list.kind, "habits"),
			),
		);
	const summary: OverdueSummary = { scanned: rows.length, enqueued: 0 };
	if (rows.length === 0) return summary;

	const assignees = await database
		.select({
			taskId: tables.taskAssignee.taskId,
			userId: tables.taskAssignee.userId,
		})
		.from(tables.taskAssignee)
		.where(
			inArray(
				tables.taskAssignee.taskId,
				rows.map((row) => row.taskId),
			),
		);
	const byTask = new Map<string, string[]>();
	for (const row of assignees) {
		const list = byTask.get(row.taskId) ?? [];
		list.push(row.userId);
		byTask.set(row.taskId, list);
	}

	const recipientsFor = (row: OverdueRow) =>
		byTask.get(row.taskId) ?? [row.listOwnerId];
	const everyone = new Set<string>();
	for (const row of rows) for (const id of recipientsFor(row)) everyone.add(id);
	const prefs = await loadPrefs(database, [...everyone]);
	const channels = await loadChannels(database, [...everyone]);
	const cap: EnqueueOptions = {
		maxQueuedPerUser: options.maxQueuedPerUser ?? maxQueuedPerUser(process.env),
		refusedLogged: new Set(),
	};

	for (const row of rows) {
		for (const recipientUserId of recipientsFor(row)) {
			const userChannels = channels.get(recipientUserId) ?? [];
			if (userChannels.length === 0) continue;
			const pref = prefs.get(recipientUserId) ?? DEFAULT_PREF;
			// The recipient's OWN local date, not UTC: at UTC+13 a UTC date rolls
			// over up to 13 hours early, which is a second overdue notice inside one
			// local day.
			const localDate = instantToWallClock(now, pref.timezone).date;
			const decision = decideQuietHours(pref, false, now, recipientUserId);
			summary.enqueued += await enqueueRows(
				database,
				recipientUserId,
				userChannels,
				{
					kind: "overdue",
					taskId: row.taskId,
					taskTitle: row.title,
					dueAt: row.dueAt?.toISOString(),
				},
				(channelKind) =>
					`overdue:${row.taskId}:${recipientUserId}:${localDate}:${channelKind}`,
				decision.kind === "defer" ? decision.until : now,
				cap,
			);
		}
	}
	return summary;
}

// Leader-only, like the scheduler scan: this is a periodic table scan, not a
// request-driven event, and running it on every replica would multiply the scan
// by the replica count for no gain (the idempotency key would absorb the
// duplicates, but only after every replica had done the work).
export function startOverdueSweep(
	database: Database,
	pool: Pool,
	env: NodeJS.ProcessEnv = process.env,
): Cron {
	const timing = schedulerTiming(env);
	const seconds = Math.max(1, Math.round(timing.tickMs / 1000));
	return new Cron(
		"* * * * * *",
		{
			interval: seconds,
			protect: () =>
				console.warn("events: previous overdue sweep still running, skipping"),
		},
		async () => {
			try {
				await withLeaderLock(pool, OVERDUE_LOCK_KEY, () =>
					overdueSweep(database),
				);
			} catch (error) {
				console.error("events: overdue sweep failed:", error);
			}
		},
	);
}
