// Single-leader scan tick: expand reminder-bearing tasks over [now - grace,
// now], create one reminder_state row per (occurrence, recipient), and drive
// quiet-hours deferral and escalation off that row. Sending is not done here --
// every replica claims outbox rows independently, so the slow network half
// never sits inside the lock.
import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
	and,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import type { SchedulerTiming } from "../../config/scheduler.ts";
import { schedulerTiming } from "../../config/scheduler.ts";
import { maxQueuedPerUser } from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import {
	type EscalationPolicy,
	nextEscalation,
} from "../../domain/escalation.ts";
import { resolveEscalationPolicy } from "../../domain/escalation-policy.ts";
import {
	type QuietDecision,
	quietHoursDecision,
} from "../../domain/quiet-hours.ts";
import { reminderWindow } from "../../domain/reminder-window.ts";
import { type EnqueueOptions, enqueueOutbox } from "./worker.ts";

export const SCHEDULER_LOCK_KEY = 918274;

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

export type TickSummary = {
	created: number;
	fired: number;
	deferred: number;
	repeated: number;
	escalated: number;
	terminated: number;
	enqueued: number;
	skippedTasks: number;
	skippedRecipients: number;
	skippedRows: number;
	cappedTaskIds: string[];
};

export type ScanOptions = {
	now?: Date;
	timing?: SchedulerTiming;
	// Test seam for the crash-between-insert-and-enqueue case (C1). Inert
	// unless passed; there is no env or production path that sets it.
	onBeforeEnqueue?: () => void | Promise<void>;
	maxQueuedPerUser?: number;
};

// Options plus the per-tick enqueue cap state, so the refusal warning dedupes
// per user per tick rather than per refused row.
type TickOptions = ScanOptions & { cap: EnqueueOptions };

export async function withLeaderLock<T>(
	pool: Pool,
	lockKey: number,
	run: () => Promise<T>,
): Promise<T | null> {
	const client = await pool.connect();
	let releaseError: unknown;
	try {
		const { rows } = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS acquired",
			[lockKey],
		);
		if (!rows[0]?.acquired) return null;
		try {
			return await run();
		} finally {
			// Never let the unlock replace the callback's error: on a broken
			// connection both fail, and the scan's real error is the useful one.
			try {
				await client.query("SELECT pg_advisory_unlock($1)", [lockKey]);
			} catch (error) {
				releaseError = error;
			}
		}
	} finally {
		// A connection returned clean while still holding a session-level advisory
		// lock is never reclaimed, and no later tick acquires. Destroy it instead.
		client.release(releaseError as Error | undefined);
	}
}

type TaskRow = {
	id: string;
	title: string;
	listId: string;
	done: boolean;
	dueAt: Date | null;
	rrule: string | null;
	reminderTime: string | null;
	repeatEveryMin: number | null;
	maxRepeats: number | null;
	fallbackUserId: string | null;
	urgent: boolean;
	listOwnerId: string;
	workspaceId: string;
};

type Pref = {
	timezone: string;
	quietHours: unknown;
	escalationDefaults: unknown;
};

const DEFAULT_PREF: Pref = {
	timezone: "UTC",
	quietHours: null,
	escalationDefaults: null,
};

// A non-recurring task's occurrence is its dueAt calendar date re-timed by
// reminderTime, so only tasks anchored near the window can produce one. A
// recurring task's dueAt is the series anchor and can sit years back, so it is
// never bounded here. The pad exceeds reminder-window's own widening.
const ANCHOR_PAD_MS = 3 * 24 * 3_600_000;

// Payload shape is deliberately minimal; Task 12's adapters own rendering.
function reminderPayload(task: TaskRow, occurrenceAt: Date, fireCount: number) {
	return {
		kind: "reminder" as const,
		taskId: task.id,
		taskTitle: task.title,
		listId: task.listId,
		occurrenceAt: occurrenceAt.toISOString(),
		fireCount,
		urgent: task.urgent,
	};
}

function policyFor(task: TaskRow, pref: Pref): EscalationPolicy {
	return resolveEscalationPolicy(
		{
			repeatEveryMin: task.repeatEveryMin,
			maxRepeats: task.maxRepeats,
			fallbackUserId: task.fallbackUserId,
			urgent: task.urgent,
		},
		pref.escalationDefaults,
	);
}

function decideQuietHours(
	pref: Pref,
	urgent: boolean,
	at: Date,
	userId: string,
): QuietDecision {
	try {
		return quietHoursDecision(
			pref.quietHours as never,
			pref.timezone,
			at,
			urgent,
		);
	} catch (error) {
		// A broken preference must not silently suppress a reminder.
		console.error(
			`scheduler: unusable quiet hours for user ${userId}, firing anyway:`,
			error,
		);
		return { kind: "fire" };
	}
}

async function enqueue(
	tx: Transaction,
	reminderStateId: string,
	recipientUserId: string,
	channels: ChannelKind[],
	payload: ReturnType<typeof reminderPayload>,
	fireCount: number,
	now: Date,
	cap: EnqueueOptions,
): Promise<number> {
	let enqueued = 0;
	for (const channelKind of channels) {
		const outcome = await enqueueOutbox(
			tx,
			{
				reminderStateId,
				recipientUserId,
				channelKind,
				payload,
				// fireCount is what keeps each escalation repeat distinct; without
				// it the second repeat loses to the unique constraint and nobody
				// is notified.
				idempotencyKey: `${reminderStateId}:${channelKind}:${fireCount}`,
				nextAttemptAt: now,
			},
			cap,
		);
		if (outcome === "inserted") enqueued++;
	}
	return enqueued;
}

async function fire(
	tx: Transaction,
	reminderStateId: string,
	recipientUserId: string,
	task: TaskRow,
	occurrenceAt: Date,
	fireCount: number,
	nextAttemptAt: Date | null,
	channels: ChannelKind[],
	now: Date,
	cap: EnqueueOptions,
	onBeforeEnqueue?: () => void | Promise<void>,
): Promise<number> {
	await tx
		.update(tables.reminderState)
		.set({
			status: "pending",
			fireCount,
			nextAttemptAt,
			deferredUntil: null,
		})
		.where(eq(tables.reminderState.id, reminderStateId));
	await onBeforeEnqueue?.();
	return await enqueue(
		tx,
		reminderStateId,
		recipientUserId,
		channels,
		reminderPayload(task, occurrenceAt, fireCount),
		fireCount,
		now,
		cap,
	);
}

function repeatAt(policy: EscalationPolicy, now: Date): Date | null {
	return policy.repeatEveryMin === null
		? null
		: new Date(now.getTime() + policy.repeatEveryMin * 60_000);
}

export async function scanTick(
	database: Database,
	options: ScanOptions = {},
): Promise<TickSummary> {
	const now = options.now ?? new Date();
	const timing = options.timing ?? schedulerTiming(process.env);
	const summary: TickSummary = {
		created: 0,
		fired: 0,
		deferred: 0,
		repeated: 0,
		escalated: 0,
		terminated: 0,
		enqueued: 0,
		skippedTasks: 0,
		skippedRecipients: 0,
		skippedRows: 0,
		cappedTaskIds: [],
	};

	const tickOptions: TickOptions = {
		...options,
		cap: {
			maxQueuedPerUser:
				options.maxQueuedPerUser ?? maxQueuedPerUser(process.env),
			refusedLogged: new Set(),
		},
	};
	const from = new Date(now.getTime() - timing.graceMs);
	await createDueReminders(database, now, from, timing, summary, tickOptions);
	await sweep(database, now, summary, tickOptions);
	return summary;
}

async function loadTasks(
	database: Database,
	from: Date,
	to: Date,
): Promise<TaskRow[]> {
	return await database
		.select({
			id: tables.task.id,
			title: tables.task.title,
			listId: tables.task.listId,
			done: tables.task.done,
			dueAt: tables.task.dueAt,
			rrule: tables.task.rrule,
			reminderTime: tables.task.reminderTime,
			repeatEveryMin: tables.task.repeatEveryMin,
			maxRepeats: tables.task.maxRepeats,
			fallbackUserId: tables.task.fallbackUserId,
			urgent: tables.task.urgent,
			listOwnerId: tables.list.ownerId,
			workspaceId: tables.list.workspaceId,
		})
		.from(tables.task)
		.innerJoin(tables.list, eq(tables.task.listId, tables.list.id))
		.where(
			and(
				isNotNull(tables.task.reminderTime),
				isNotNull(tables.task.dueAt),
				or(
					isNotNull(tables.task.rrule),
					and(
						eq(tables.task.done, false),
						gte(tables.task.dueAt, new Date(from.getTime() - ANCHOR_PAD_MS)),
						lte(tables.task.dueAt, new Date(to.getTime() + ANCHOR_PAD_MS)),
					),
				),
			),
		);
}

async function loadPrefs(
	database: Database,
	userIds: string[],
): Promise<Map<string, Pref>> {
	const prefs = new Map<string, Pref>();
	if (userIds.length === 0) return prefs;
	const rows = await database
		.select({
			id: tables.userPref.id,
			timezone: tables.userPref.timezone,
			quietHours: tables.userPref.quietHours,
			escalationDefaults: tables.userPref.escalationDefaults,
		})
		.from(tables.userPref)
		.where(inArray(tables.userPref.id, userIds));
	for (const row of rows) {
		prefs.set(row.id, {
			timezone: row.timezone,
			quietHours: row.quietHours,
			escalationDefaults: row.escalationDefaults,
		});
	}
	return prefs;
}

async function loadChannels(
	database: Database,
	userIds: string[],
): Promise<Map<string, ChannelKind[]>> {
	const channels = new Map<string, ChannelKind[]>();
	if (userIds.length === 0) return channels;
	const rows = await database
		.select({
			userId: tables.notificationChannel.userId,
			kind: tables.notificationChannel.kind,
		})
		.from(tables.notificationChannel)
		.where(
			and(
				inArray(tables.notificationChannel.userId, userIds),
				eq(tables.notificationChannel.enabled, true),
			),
		);
	for (const row of rows) {
		const list = channels.get(row.userId) ?? [];
		list.push(row.kind);
		channels.set(row.userId, list);
	}
	return channels;
}

async function createDueReminders(
	database: Database,
	now: Date,
	from: Date,
	timing: SchedulerTiming,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const taskRows = await loadTasks(database, from, now);
	if (taskRows.length === 0) return;

	const assignees = await database
		.select({
			taskId: tables.taskAssignee.taskId,
			userId: tables.taskAssignee.userId,
		})
		.from(tables.taskAssignee)
		.where(
			inArray(
				tables.taskAssignee.taskId,
				taskRows.map((t) => t.id),
			),
		);
	const byTask = new Map<string, string[]>();
	for (const row of assignees) {
		const list = byTask.get(row.taskId) ?? [];
		list.push(row.userId);
		byTask.set(row.taskId, list);
	}

	const recipientsFor = (task: TaskRow) =>
		byTask.get(task.id) ?? [task.listOwnerId];
	const everyone = new Set<string>();
	for (const task of taskRows) {
		everyone.add(task.listOwnerId);
		for (const userId of recipientsFor(task)) everyone.add(userId);
	}
	const prefs = await loadPrefs(database, [...everyone]);
	const channels = await loadChannels(database, [...everyone]);

	for (const task of taskRows) {
		// Isolate per task: a malformed reminderTime or an invalid stored
		// timezone throws inside the expansion, and one bad row must not stop
		// every other user's reminders.
		let occurrences: { occurrenceAt: Date }[];
		try {
			const ownerPref = prefs.get(task.listOwnerId) ?? DEFAULT_PREF;
			// One expansion per task in the LIST OWNER's zone: every recipient
			// shares one occurrence_at, which is what makes sibling rows
			// addressable and ack propagation possible.
			const result = reminderWindow(
				[
					{
						taskId: task.id,
						reminderTime: task.reminderTime,
						rrule: task.rrule,
						dueAt: task.dueAt,
						done: task.done,
					},
				],
				ownerPref.timezone,
				from,
				now,
			);
			if (result.cappedTaskIds.length > 0) {
				summary.cappedTaskIds.push(...result.cappedTaskIds);
				console.warn(
					`scheduler: reminder expansion capped for task ${task.id}; some occurrences in this window were not materialized`,
				);
			}
			occurrences = result.occurrences;
		} catch (error) {
			summary.skippedTasks++;
			console.error(
				`scheduler: skipping task ${task.id}, cannot expand reminders:`,
				error,
			);
			continue;
		}

		for (const occurrence of occurrences) {
			const firedLate =
				now.getTime() - occurrence.occurrenceAt.getTime() >
				timing.lateThresholdMs;
			for (const recipientUserId of recipientsFor(task)) {
				try {
					await createReminder(database, {
						task,
						occurrenceAt: occurrence.occurrenceAt,
						recipientUserId,
						pref: prefs.get(recipientUserId) ?? DEFAULT_PREF,
						channels: channels.get(recipientUserId) ?? [],
						firedLate,
						now,
						summary,
						cap: options.cap,
						onBeforeEnqueue: options.onBeforeEnqueue,
					});
				} catch (error) {
					summary.skippedRecipients++;
					console.error(
						`scheduler: skipping recipient ${recipientUserId} for task ${task.id}:`,
						error,
					);
				}
			}
		}
	}
}

async function createReminder(
	database: Database,
	input: {
		task: TaskRow;
		occurrenceAt: Date;
		recipientUserId: string;
		pref: Pref;
		channels: ChannelKind[];
		firedLate: boolean;
		now: Date;
		summary: TickSummary;
		cap: EnqueueOptions;
		onBeforeEnqueue?: () => void | Promise<void>;
	},
): Promise<void> {
	const { task, occurrenceAt, recipientUserId, pref, now, summary } = input;
	// The insert and its enqueue are one transaction: a commit between them
	// would leave a row with no schedule and no outbox entry, which the next
	// tick's insert conflicts with and the sweep never selects.
	await database.transaction(async (tx) => {
		const inserted = await tx
			.insert(tables.reminderState)
			.values({
				id: randomUUID(),
				taskId: task.id,
				occurrenceAt,
				recipientUserId,
				status: "pending",
				fireCount: 0,
				// Never NULL: a crash before the branch below leaves the row
				// reachable by the sweep's self-heal branch rather than stranded.
				nextAttemptAt: now,
				firedLate: input.firedLate,
			})
			.onConflictDoNothing()
			.returning({ id: tables.reminderState.id });
		if (inserted.length === 0) return; // another scan won the race
		const reminderStateId = inserted[0].id;
		summary.created++;

		const decision = decideQuietHours(pref, task.urgent, now, recipientUserId);
		if (decision.kind === "defer") {
			await tx
				.update(tables.reminderState)
				.set({
					status: "deferred",
					deferredUntil: decision.until,
					nextAttemptAt: null,
				})
				.where(eq(tables.reminderState.id, reminderStateId));
			summary.deferred++;
			return;
		}

		const policy = policyFor(task, pref);
		summary.enqueued += await fire(
			tx,
			reminderStateId,
			recipientUserId,
			task,
			occurrenceAt,
			1,
			repeatAt(policy, now),
			input.channels,
			now,
			input.cap,
			input.onBeforeEnqueue,
		);
		summary.fired++;
	});
}

type SweepRow = TaskRow & {
	reminderStateId: string;
	recipientUserId: string;
	occurrenceAt: Date;
	fireCount: number;
	firedLate: boolean;
	branch: "wake" | "escalate";
};

async function loadSweepRows(
	database: Database,
	now: Date,
): Promise<SweepRow[]> {
	const columns = {
		reminderStateId: tables.reminderState.id,
		recipientUserId: tables.reminderState.recipientUserId,
		occurrenceAt: tables.reminderState.occurrenceAt,
		fireCount: tables.reminderState.fireCount,
		firedLate: tables.reminderState.firedLate,
		id: tables.task.id,
		title: tables.task.title,
		listId: tables.task.listId,
		done: tables.task.done,
		dueAt: tables.task.dueAt,
		rrule: tables.task.rrule,
		reminderTime: tables.task.reminderTime,
		repeatEveryMin: tables.task.repeatEveryMin,
		maxRepeats: tables.task.maxRepeats,
		fallbackUserId: tables.task.fallbackUserId,
		urgent: tables.task.urgent,
		listOwnerId: tables.list.ownerId,
		workspaceId: tables.list.workspaceId,
	};
	const base = () =>
		database
			.select(columns)
			.from(tables.reminderState)
			.innerJoin(tables.task, eq(tables.reminderState.taskId, tables.task.id))
			.innerJoin(tables.list, eq(tables.task.listId, tables.list.id));

	// Branch A: waking from quiet hours. Branch C (self-heal): a row a crash
	// stranded before it was either fired or deferred -- fire_count = 0 is the
	// reliable discriminator, since a fired row always carries at least 1, and
	// it must catch both stranded shapes (next_attempt_at NULL and the
	// insert-time placeholder) or the row is reachable by no branch at all.
	const waking = await base().where(
		or(
			and(
				eq(tables.reminderState.status, "deferred"),
				isNotNull(tables.reminderState.deferredUntil),
				lte(tables.reminderState.deferredUntil, now),
			),
			and(
				eq(tables.reminderState.status, "pending"),
				eq(tables.reminderState.fireCount, 0),
				isNull(tables.reminderState.deferredUntil),
				or(
					isNull(tables.reminderState.nextAttemptAt),
					lte(tables.reminderState.nextAttemptAt, now),
				),
			),
		),
	);
	// Branch B: fired but not acked. Terminal statuses (acked/failed/expired/
	// escalated) are excluded, or a stale next_attempt_at would escalate them
	// forever.
	const escalating = await base().where(
		and(
			eq(tables.reminderState.status, "pending"),
			isNotNull(tables.reminderState.nextAttemptAt),
			lte(tables.reminderState.nextAttemptAt, now),
			sql`${tables.reminderState.fireCount} > 0`,
		),
	);

	return [
		...waking.map((row) => ({ ...row, branch: "wake" as const })),
		...escalating.map((row) => ({ ...row, branch: "escalate" as const })),
	];
}

async function sweep(
	database: Database,
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const rows = await loadSweepRows(database, now);
	if (rows.length === 0) return;

	const userIds = new Set<string>();
	for (const row of rows) {
		userIds.add(row.recipientUserId);
		if (row.fallbackUserId) userIds.add(row.fallbackUserId);
	}
	const prefs = await loadPrefs(database, [...userIds]);
	const channels = await loadChannels(database, [...userIds]);

	for (const row of rows) {
		// Isolate per row: an unresolvable policy throws, and one bad row must
		// not abort every remaining row in this tick.
		try {
			if (row.branch === "wake") {
				await sweepWake(database, row, prefs, channels, now, summary, options);
			} else {
				await sweepEscalate(
					database,
					row,
					prefs,
					channels,
					now,
					summary,
					options,
				);
			}
		} catch (error) {
			summary.skippedRows++;
			console.error(
				`scheduler: skipping reminder ${row.reminderStateId} (task ${row.id}):`,
				error,
			);
		}
	}
}

async function sweepWake(
	database: Database,
	row: SweepRow,
	prefs: Map<string, Pref>,
	channels: Map<string, ChannelKind[]>,
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const pref = prefs.get(row.recipientUserId) ?? DEFAULT_PREF;
	const decision = decideQuietHours(pref, row.urgent, now, row.recipientUserId);
	if (decision.kind === "defer") {
		await database
			.update(tables.reminderState)
			.set({
				status: "deferred",
				deferredUntil: decision.until,
				nextAttemptAt: null,
			})
			.where(eq(tables.reminderState.id, row.reminderStateId));
		summary.deferred++;
		return;
	}

	// Never nextEscalation() here: it has no "send now" outcome, so a row
	// leaving quiet hours with no repeat policy would be terminated instead of
	// delivered.
	const policy = policyFor(row, pref);
	await database.transaction(async (tx) => {
		summary.enqueued += await fire(
			tx,
			row.reminderStateId,
			row.recipientUserId,
			row,
			row.occurrenceAt,
			1,
			repeatAt(policy, now),
			channels.get(row.recipientUserId) ?? [],
			now,
			options.cap,
			options.onBeforeEnqueue,
		);
	});
	summary.fired++;
}

async function sweepEscalate(
	database: Database,
	row: SweepRow,
	prefs: Map<string, Pref>,
	channels: Map<string, ChannelKind[]>,
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const pref = prefs.get(row.recipientUserId) ?? DEFAULT_PREF;
	const policy = policyFor(row, pref);
	const action = nextEscalation({ fireCount: row.fireCount }, policy, now);

	if (action.kind === "repeat") {
		await database.transaction(async (tx) => {
			summary.enqueued += await fire(
				tx,
				row.reminderStateId,
				row.recipientUserId,
				row,
				row.occurrenceAt,
				row.fireCount + 1,
				action.at,
				channels.get(row.recipientUserId) ?? [],
				now,
				options.cap,
				options.onBeforeEnqueue,
			);
		});
		summary.repeated++;
		return;
	}

	if (action.kind === "escalate") {
		await escalateToFallback(
			database,
			row,
			action.userId,
			prefs,
			channels,
			now,
			summary,
			options,
		);
		return;
	}

	await terminate(database, row.reminderStateId);
	summary.terminated++;
}

async function terminate(
	database: Database,
	reminderStateId: string,
): Promise<void> {
	await database
		.update(tables.reminderState)
		.set({ status: "expired", nextAttemptAt: null, deferredUntil: null })
		.where(eq(tables.reminderState.id, reminderStateId));
}

async function escalateToFallback(
	database: Database,
	row: SweepRow,
	fallbackUserId: string,
	prefs: Map<string, Pref>,
	channels: Map<string, ChannelKind[]>,
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	// The sibling row carries no marker saying "already escalated", so the
	// cycle guard is structural: a row whose own recipient is the policy's
	// fallback is the sibling, and it hands off to nobody.
	if (fallbackUserId === row.recipientUserId) {
		await terminate(database, row.reminderStateId);
		summary.terminated++;
		return;
	}

	// Memberships change between writing the preference and firing it, so the
	// co-membership check at write time is not sufficient: re-check here or a
	// former member keeps receiving task titles from a workspace they left.
	const member = await database
		.select({ id: tables.membership.id })
		.from(tables.membership)
		.where(
			and(
				eq(tables.membership.userId, fallbackUserId),
				eq(tables.membership.workspaceId, row.workspaceId),
			),
		)
		.limit(1);
	if (member.length === 0) {
		console.warn(
			`scheduler: escalation fallback ${fallbackUserId} is not a member of workspace ${row.workspaceId}; terminating reminder ${row.reminderStateId} instead`,
		);
		await terminate(database, row.reminderStateId);
		summary.terminated++;
		return;
	}

	const pref = prefs.get(fallbackUserId) ?? DEFAULT_PREF;
	const decision = decideQuietHours(pref, row.urgent, now, fallbackUserId);
	const policy = policyFor(row, pref);

	await database.transaction(async (tx) => {
		const inserted = await tx
			.insert(tables.reminderState)
			.values({
				id: randomUUID(),
				taskId: row.id,
				occurrenceAt: row.occurrenceAt,
				recipientUserId: fallbackUserId,
				status: "pending",
				fireCount: 0,
				nextAttemptAt: now,
				firedLate: row.firedLate,
			})
			.onConflictDoNothing()
			.returning({ id: tables.reminderState.id });

		if (inserted.length > 0) {
			const siblingId = inserted[0].id;
			if (decision.kind === "defer") {
				await tx
					.update(tables.reminderState)
					.set({
						status: "deferred",
						deferredUntil: decision.until,
						nextAttemptAt: null,
					})
					.where(eq(tables.reminderState.id, siblingId));
				summary.deferred++;
			} else {
				summary.enqueued += await fire(
					tx,
					siblingId,
					fallbackUserId,
					row,
					row.occurrenceAt,
					1,
					repeatAt(policy, now),
					channels.get(fallbackUserId) ?? [],
					now,
					options.cap,
					options.onBeforeEnqueue,
				);
			}
		}

		await tx
			.update(tables.reminderState)
			.set({ status: "escalated", nextAttemptAt: null, deferredUntil: null })
			.where(eq(tables.reminderState.id, row.reminderStateId));
	});
	summary.escalated++;
}

export function startScheduler(
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
			// A tick overrunning its interval is not a correctness bug (the
			// overlapping run loses the lock), but it burns a connection per
			// overrun and otherwise hides the overrun entirely.
			protect: () =>
				console.warn(
					"scheduler: previous tick still running, skipping this interval",
				),
		},
		async () => {
			try {
				await withLeaderLock(pool, SCHEDULER_LOCK_KEY, () =>
					scanTick(database, { timing }),
				);
			} catch (error) {
				console.error("scheduler: tick failed:", error);
			}
		},
	);
}
