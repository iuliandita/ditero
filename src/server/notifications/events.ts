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
//
// Deliberate extension beyond "one overdue notice per assignee": a task with no
// assignee at all notifies the list owner, so an unassigned overdue task in a
// shared list is not silently nobody's problem.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { overdueSweepMs } from "../../config/scheduler.ts";
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
// the retained (up to 30 days) outbox row's unique constraint.
export type CollectedEvent = PendingEvent & { stamp: string };

const collector = new AsyncLocalStorage<CollectedEvent[]>();

// Installed at import. The sink is a module global by necessity (mutators.ts
// ships to the client and cannot import node:async_hooks), but the store it
// writes to is request-scoped, so concurrent requests never share a buffer.
setEventSink((pending) => {
	collector.getStore()?.push({ ...pending, stamp: randomUUID() });
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

// Zero's MutationResponse: an `error` in the result means the mutation did not
// apply. Structurally typed so this module does not depend on zero/server.
type MutationOutcome = { result: object };

export type MutationTransact<R extends MutationOutcome> = (
	callback: (tx: unknown, name: string, args: unknown) => Promise<void>,
) => Promise<R>;

// The notification half of the /api/zero/mutate handler, extracted so it is
// testable: driving the real route needs Zero's own upstream `clients` table,
// which this app's migrations do not create, so a test there would need
// zero-cache standing up. index.ts holds nothing but the two calls below.
export type EventMutateSession = {
	// Wraps ONE mutation. Events are kept only if `transact` resolved with a
	// non-error result -- that, not "the mutator body returned", is the commit
	// boundary. Zero catches an error raised at COMMIT and retries the
	// transaction with the mutator skipped, so a body that ran to completion can
	// still have been rolled back; announcing its events would be a phantom
	// notification for a mutation that never applied.
	run<R extends MutationOutcome>(
		transact: MutationTransact<R>,
		call: (tx: unknown, name: string, args: unknown) => Promise<void>,
	): Promise<R>;
	// Drains everything kept, after the whole request. Never throws.
	flush(): Promise<void>;
};

export function eventMutateSession(database: Database): EventMutateSession {
	const committed: CollectedEvent[] = [];
	return {
		async run(transact, call) {
			const collected: CollectedEvent[] = [];
			const response = await transact(async (tx, name, args) => {
				// A retried transaction re-enters this callback; replace rather than
				// append so a retry cannot double-notify.
				collected.length = 0;
				await withEventCollector(collected, () => call(tx, name, args));
			});
			if (!("error" in response.result)) committed.push(...collected);
			return response;
		},
		flush: () => enqueueEventsSafely(database, committed),
	};
}

type OverdueRow = {
	taskId: string;
	title: string;
	// The `dueAt < now` predicate already excludes NULL; typed nullable only
	// because the column is.
	dueAt: Date | null;
	listOwnerId: string;
	workspaceId: string;
};

// Bounds one tick's work. Oldest-due first, so a backlog larger than this is
// drained in due order across ticks rather than starving arbitrarily.
export const OVERDUE_SCAN_LIMIT = 5_000;

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
			workspaceId: tables.list.workspaceId,
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
		)
		.orderBy(tables.task.dueAt)
		.limit(OVERDUE_SCAN_LIMIT);
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

	// task_assignee rows and list.ownerId both survive a membership removal, so
	// without this an ex-member keeps receiving overdue notices carrying the task
	// title. Assign and mention are gated on membership at write time; this is
	// the equivalent gate at notify time.
	const memberOf = new Set<string>();
	for (const row of await database
		.select({
			userId: tables.membership.userId,
			workspaceId: tables.membership.workspaceId,
		})
		.from(tables.membership)
		.where(inArray(tables.membership.userId, [...everyone]))) {
		memberOf.add(`${row.userId}:${row.workspaceId}`);
	}

	const prefs = await loadPrefs(database, [...everyone]);
	const channels = await loadChannels(database, [...everyone]);

	// Every (task, recipient, channel) key this sweep would write, resolved
	// before any insert. After the first sweep of a recipient's local day every
	// one of them already exists, and this turns what was one INSERT round-trip
	// per key into a single SELECT -- the sweep is idempotent by design, so
	// re-running it must be cheap, not merely harmless.
	type Candidate = {
		row: OverdueRow;
		recipientUserId: string;
		channelKind: ChannelKind;
		key: string;
		localDate: string;
	};
	const planned: Candidate[] = [];
	for (const row of rows) {
		for (const recipientUserId of recipientsFor(row)) {
			if (!memberOf.has(`${recipientUserId}:${row.workspaceId}`)) continue;
			const pref = prefs.get(recipientUserId) ?? DEFAULT_PREF;
			// The recipient's OWN local date, not UTC: at UTC+13 a UTC date rolls
			// over up to 13 hours early, which is a second overdue notice inside one
			// local day.
			const localDate = instantToWallClock(now, pref.timezone).date;
			for (const channelKind of channels.get(recipientUserId) ?? []) {
				planned.push({
					row,
					recipientUserId,
					channelKind,
					localDate,
					key: `overdue:${row.taskId}:${recipientUserId}:${localDate}:${channelKind}`,
				});
			}
		}
	}
	if (planned.length === 0) return summary;

	const existing = new Set(
		(
			await database
				.select({ key: tables.notificationOutbox.idempotencyKey })
				.from(tables.notificationOutbox)
				.where(
					inArray(
						tables.notificationOutbox.idempotencyKey,
						planned.map((c) => c.key),
					),
				)
		).map((r) => r.key),
	);

	const cap: EnqueueOptions = {
		maxQueuedPerUser: options.maxQueuedPerUser ?? maxQueuedPerUser(process.env),
		refusedLogged: new Set(),
	};
	for (const candidate of planned) {
		// The unique constraint remains the authority; this only skips the
		// round-trip for keys already known to exist.
		if (existing.has(candidate.key)) continue;
		const pref = prefs.get(candidate.recipientUserId) ?? DEFAULT_PREF;
		const decision = decideQuietHours(
			pref,
			false,
			now,
			candidate.recipientUserId,
		);
		summary.enqueued += await enqueueRows(
			database,
			candidate.recipientUserId,
			[candidate.channelKind],
			{
				kind: "overdue",
				taskId: candidate.row.taskId,
				taskTitle: candidate.row.title,
				dueAt: candidate.row.dueAt?.toISOString(),
			},
			() => candidate.key,
			decision.kind === "defer" ? decision.until : now,
			cap,
		);
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
	const seconds = Math.max(1, Math.round(overdueSweepMs(env) / 1000));
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
