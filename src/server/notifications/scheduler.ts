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
import { crashHook } from "../../config/test-crash.ts";
import { maxQueuedPerUser } from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import {
	type EscalationPolicy,
	nextEscalation,
} from "../../domain/escalation.ts";
import { resolveEscalationPolicy } from "../../domain/escalation-policy.ts";
import type { Locale } from "../../domain/locale.ts";
import { reminderWindow } from "../../domain/reminder-window.ts";
import { type EnqueueOptions, enqueueOutbox } from "./outbox.ts";
import {
	type ProducerAuthority,
	retryProducerCandidate,
	withProducerAuthority,
} from "./producer-authority.ts";
import {
	DEFAULT_PREF,
	decideQuietHours,
	loadPrefs,
	type Pref,
} from "./recipients.ts";
import { withDrizzleProducerActivationScan } from "./task-activation-drizzle.ts";

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
	// Test seam for the crash-between-insert-and-enqueue case (C1). In-process
	// callers pass their own; startScheduler wires the process-suicide hook,
	// which is a no-op unless DITERO_TEST_CRASH_POINT armed it outside
	// production (config/test-crash).
	onBeforeEnqueue?: (tx: Transaction) => void | Promise<void>;
	onBeforeFallbackHandoff?: () => void | Promise<void>;
	onAfterAuthorityDiscovery?: () => void | Promise<void>;
	maxQueuedPerUser?: number;
};

// Options plus the per-tick enqueue cap state, so the refusal warning dedupes
// per user per tick rather than per refused row.
type TickOptions = ScanOptions & { cap: EnqueueOptions };

const producerVisible = sql`not exists (
	select 1 from task_notification_activation activation
	where activation.task_id = ${tables.task.id} and activation.status <> 'active'
)`;

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

// A non-recurring task's occurrence is its dueAt calendar date re-timed by
// reminderTime, so only tasks anchored near the window can produce one. A
// recurring task's dueAt is the series anchor and can sit years back, so it is
// never bounded here. The pad exceeds reminder-window's own widening.
const ANCHOR_PAD_MS = 3 * 24 * 3_600_000;

// Payload shape is deliberately minimal; Task 12's adapters own rendering.
// `locale` is the recipient's, resolved by the fan-out that already read their
// preferences: dispatch renders with it explicitly, because the server must
// never consult Paraglide's process-global ambient locale.
function reminderPayload(
	task: TaskRow,
	occurrenceAt: Date,
	fireCount: number,
	locale: Locale,
) {
	return {
		kind: "reminder" as const,
		taskId: task.id,
		taskTitle: task.title,
		listId: task.listId,
		occurrenceAt: occurrenceAt.toISOString(),
		fireCount,
		urgent: task.urgent,
		locale,
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
	let refused = 0;
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
		else if (outcome === "refused") refused++;
	}

	// C13: a reminder refused on every channel would otherwise sit `pending`
	// with no outbox row -- permanent limbo, and reminder_state IS synced, so it
	// must tell the user the truth.
	//
	// The counters alone cannot decide this. At the cap the insert is suppressed
	// before ON CONFLICT can fire, so a re-run whose rows already exist is
	// reported `refused` and is indistinguishable from a genuine first refusal.
	// Ask the question that actually matters instead -- does this reminder have
	// an outbox row at all -- which is also robust to any future path that
	// enqueues nothing for a third reason.
	if (refused > 0 && enqueued === 0) {
		const live = await tx
			.select({ id: tables.notificationOutbox.id })
			.from(tables.notificationOutbox)
			.where(eq(tables.notificationOutbox.reminderStateId, reminderStateId))
			.limit(1);
		if (live.length === 0) {
			await tx
				.update(tables.reminderState)
				.set({ status: "failed", nextAttemptAt: null, deferredUntil: null })
				.where(eq(tables.reminderState.id, reminderStateId));
		}
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
	locale: Locale,
	now: Date,
	cap: EnqueueOptions,
	onBeforeEnqueue?: (tx: Transaction) => void | Promise<void>,
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
	await onBeforeEnqueue?.(tx);
	return await enqueue(
		tx,
		reminderStateId,
		recipientUserId,
		channels,
		reminderPayload(task, occurrenceAt, fireCount, locale),
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
	database: Database | Transaction,
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
				producerVisible,
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

async function createDueReminders(
	database: Database,
	now: Date,
	from: Date,
	timing: SchedulerTiming,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const taskRows = await database.transaction((tx) =>
		withDrizzleProducerActivationScan(tx, (scoped) =>
			loadTasks(scoped, from, now),
		),
	);
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
	const prefs = await loadPrefs(database, [
		...new Set(taskRows.map((task) => task.listOwnerId)),
	]);
	// The list owner's preference supplies the expansion timezone even when
	// the owner is no longer a member and receives nothing.

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
			for (const recipientUserId of recipientsFor(task)) {
				try {
					await createReminder(database, {
						taskId: task.id,
						occurrenceAt: occurrence.occurrenceAt,
						recipientUserId,
						from,
						timing,
						now,
						summary,
						cap: options.cap,
						onBeforeEnqueue: options.onBeforeEnqueue,
						onAfterAuthorityDiscovery: options.onAfterAuthorityDiscovery,
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
		taskId: string;
		occurrenceAt: Date;
		recipientUserId: string;
		from: Date;
		timing: SchedulerTiming;
		now: Date;
		summary: TickSummary;
		cap: EnqueueOptions;
		onBeforeEnqueue?: (tx: Transaction) => void | Promise<void>;
		onAfterAuthorityDiscovery?: () => void | Promise<void>;
	},
): Promise<void> {
	const { taskId, occurrenceAt, recipientUserId, now, summary } = input;
	// The insert and its enqueue are one transaction: a commit between them
	// would leave a row with no schedule and no outbox entry, which the next
	// tick's insert conflicts with and the sweep never selects.
	const result = await retryProducerCandidate(() =>
		database.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId,
					recipientUserId,
					occurrenceAt,
				},
				async (authority) => {
					const task = authority.task;
					const pref = authority.recipientPref;
					const lockedWindow = reminderWindow(
						[
							{
								taskId,
								reminderTime: task.reminderTime,
								rrule: task.rrule,
								dueAt: task.dueAt,
								done: task.done,
							},
						],
						authority.ownerPref.timezone,
						input.from,
						now,
					);
					if (
						!lockedWindow.occurrences.some(
							(row) => row.occurrenceAt.getTime() === occurrenceAt.getTime(),
						)
					)
						return { created: 0, fired: 0, deferred: 0, enqueued: 0 };
					const inserted = await tx
						.insert(tables.reminderState)
						.values({
							id: randomUUID(),
							taskId,
							occurrenceAt,
							recipientUserId,
							status: "pending",
							fireCount: 0,
							// Never NULL: a crash before the branch below leaves the row
							// reachable by the sweep's self-heal branch rather than stranded.
							nextAttemptAt: now,
							firedLate:
								now.getTime() - occurrenceAt.getTime() >
								input.timing.lateThresholdMs,
						})
						.onConflictDoNothing()
						.returning({ id: tables.reminderState.id });
					if (inserted.length === 0)
						return { created: 0, fired: 0, deferred: 0, enqueued: 0 }; // another scan won the race
					const reminderStateId = inserted[0].id;

					const decision = decideQuietHours(
						pref,
						task.urgent,
						now,
						recipientUserId,
					);
					if (decision.kind === "defer") {
						await tx
							.update(tables.reminderState)
							.set({
								status: "deferred",
								deferredUntil: decision.until,
								nextAttemptAt: null,
							})
							.where(eq(tables.reminderState.id, reminderStateId));
						return { created: 1, fired: 0, deferred: 1, enqueued: 0 };
					}

					const policy = policyFor(task, pref);
					const enqueued = await fire(
						tx,
						reminderStateId,
						recipientUserId,
						task,
						occurrenceAt,
						1,
						repeatAt(policy, now),
						authority.channels,
						pref.locale,
						now,
						input.cap,
						input.onBeforeEnqueue,
					);
					return { created: 1, fired: 1, deferred: 0, enqueued };
				},
				{ onAfterDiscovery: input.onAfterAuthorityDiscovery },
			),
		),
	);
	if (result.kind === "eligible") {
		summary.created += result.value.created;
		summary.fired += result.value.fired;
		summary.deferred += result.value.deferred;
		summary.enqueued += result.value.enqueued;
	}
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
	database: Database | Transaction,
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
		and(
			producerVisible,
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
		),
	);
	// Branch B: fired but not acked. Terminal statuses (acked/failed/expired/
	// escalated) are excluded, or a stale next_attempt_at would escalate them
	// forever.
	const escalating = await base().where(
		and(
			producerVisible,
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
	const rows = await database.transaction((tx) =>
		withDrizzleProducerActivationScan(tx, (scoped) =>
			loadSweepRows(scoped, now),
		),
	);
	if (rows.length === 0) return;

	for (const row of rows) {
		// Isolate per row: an unresolvable policy throws, and one bad row must
		// not abort every remaining row in this tick.
		try {
			if (row.branch === "wake") {
				await sweepWake(database, row, now, summary, options);
			} else {
				await sweepEscalate(database, row, now, summary, options);
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
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const result = await retryProducerCandidate(() =>
		database.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: row.id,
					recipientUserId: row.recipientUserId,
					occurrenceAt: row.occurrenceAt,
					reminderStateId: row.reminderStateId,
				},
				async (authority) => {
					const state = authority.reminderState;
					if (!state || !readyWake(state, now) || authority.task.done)
						return { fired: 0, deferred: 0, enqueued: 0 };
					const pref = authority.recipientPref;
					const decision = decideQuietHours(
						pref,
						authority.task.urgent,
						now,
						row.recipientUserId,
					);
					if (decision.kind === "defer") {
						await tx
							.update(tables.reminderState)
							.set({
								status: "deferred",
								deferredUntil: decision.until,
								nextAttemptAt: null,
							})
							.where(eq(tables.reminderState.id, state.id));
						return { fired: 0, deferred: 1, enqueued: 0 };
					}
					// Waking fires now, even when there is no repeat policy.
					const enqueued = await fire(
						tx,
						state.id,
						row.recipientUserId,
						authority.task,
						state.occurrence_at,
						1,
						repeatAt(policyFor(authority.task, pref), now),
						authority.channels,
						pref.locale,
						now,
						options.cap,
						options.onBeforeEnqueue,
					);
					return { fired: 1, deferred: 0, enqueued };
				},
				{ onAfterDiscovery: options.onAfterAuthorityDiscovery },
			),
		),
	);
	if (result.kind === "eligible") {
		summary.fired += result.value.fired;
		summary.deferred += result.value.deferred;
		summary.enqueued += result.value.enqueued;
	}
}

async function sweepEscalate(
	database: Database,
	row: SweepRow,
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const first = await retryProducerCandidate(() =>
		database.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "reminder",
					taskId: row.id,
					recipientUserId: row.recipientUserId,
					occurrenceAt: row.occurrenceAt,
					reminderStateId: row.reminderStateId,
				},
				async (authority) => {
					const state = authority.reminderState;
					if (!state || !readyEscalate(state, now) || authority.task.done)
						return { kind: "skip" as const, enqueued: 0 };
					const pref = authority.recipientPref;
					const action = nextEscalation(
						{ fireCount: state.fire_count },
						policyFor(authority.task, pref),
						now,
					);
					if (action.kind === "repeat") {
						const enqueued = await fire(
							tx,
							state.id,
							row.recipientUserId,
							authority.task,
							state.occurrence_at,
							state.fire_count + 1,
							action.at,
							authority.channels,
							pref.locale,
							now,
							options.cap,
							options.onBeforeEnqueue,
						);
						return { kind: "repeated" as const, enqueued };
					}
					if (
						action.kind === "escalate" &&
						action.userId !== row.recipientUserId
					) {
						if (authority.memberUserIds.includes(action.userId))
							return {
								kind: "handoff" as const,
								userId: action.userId,
								enqueued: 0,
							};
						console.warn(
							`scheduler: escalation fallback ${action.userId} is not a member of workspace ${authority.task.workspaceId}; terminating reminder ${state.id} instead`,
						);
					}
					await terminate(tx, state.id);
					return { kind: "terminated" as const, enqueued: 0 };
				},
				{ onAfterDiscovery: options.onAfterAuthorityDiscovery },
			),
		),
	);
	if (first.kind === "skip") return;
	if (first.value.kind === "repeated") {
		summary.repeated++;
		summary.enqueued += first.value.enqueued;
	} else if (first.value.kind === "terminated") {
		summary.terminated++;
	} else if (first.value.kind === "handoff") {
		await options.onBeforeFallbackHandoff?.();
		await escalateToFallback(
			database,
			row,
			first.value.userId,
			now,
			summary,
			options,
		);
	}
}

async function terminate(
	database: Transaction,
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
	now: Date,
	summary: TickSummary,
	options: TickOptions,
): Promise<void> {
	const result = await retryProducerCandidate(() =>
		database.transaction((tx) =>
			withProducerAuthority(
				tx,
				{
					kind: "fallback-create",
					taskId: row.id,
					recipientUserId: fallbackUserId,
					occurrenceAt: row.occurrenceAt,
					originReminderStateId: row.reminderStateId,
					at: now,
				},
				async (authority) => {
					const origin = authority.originReminderState;
					if (!origin || !readyEscalate(origin, now) || authority.task.done)
						return { escalated: 0, deferred: 0, enqueued: 0 };
					const pref = authority.recipientPref;
					const decision = decideQuietHours(
						pref,
						authority.task.urgent,
						now,
						fallbackUserId,
					);
					const policy = policyFor(authority.task, pref);
					const inserted = await tx
						.insert(tables.reminderState)
						.values({
							id: randomUUID(),
							taskId: authority.task.id,
							occurrenceAt: origin.occurrence_at,
							recipientUserId: fallbackUserId,
							status: "pending",
							fireCount: 0,
							nextAttemptAt: now,
							firedLate: origin.fired_late,
						})
						.onConflictDoNothing()
						.returning({ id: tables.reminderState.id });

					let deferred = 0;
					let enqueued = 0;
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
							deferred++;
						} else {
							enqueued += await fire(
								tx,
								siblingId,
								fallbackUserId,
								authority.task,
								origin.occurrence_at,
								1,
								repeatAt(policy, now),
								authority.channels,
								pref.locale,
								now,
								options.cap,
								options.onBeforeEnqueue,
							);
						}
					}

					await tx
						.update(tables.reminderState)
						.set({
							status: "escalated",
							nextAttemptAt: null,
							deferredUntil: null,
						})
						.where(eq(tables.reminderState.id, origin.id));
					return { escalated: 1, deferred, enqueued };
				},
				{ onAfterDiscovery: options.onAfterAuthorityDiscovery },
			),
		),
	);
	if (result.kind === "eligible") {
		summary.escalated += result.value.escalated;
		summary.deferred += result.value.deferred;
		summary.enqueued += result.value.enqueued;
	}
}

type LockedReminder = NonNullable<ProducerAuthority["reminderState"]>;

function readyWake(state: LockedReminder, now: Date): boolean {
	return (
		(state.status === "deferred" &&
			state.deferred_until !== null &&
			state.deferred_until <= now) ||
		(state.status === "pending" &&
			state.fire_count === 0 &&
			state.deferred_until === null &&
			(state.next_attempt_at === null || state.next_attempt_at <= now))
	);
}

function readyEscalate(state: LockedReminder, now: Date): boolean {
	return (
		state.status === "pending" &&
		state.fire_count > 0 &&
		state.next_attempt_at !== null &&
		state.next_attempt_at <= now
	);
}

export function startScheduler(
	database: Database,
	pool: Pool,
	env: NodeJS.ProcessEnv = process.env,
): Cron {
	const timing = schedulerTiming(env);
	const crash = crashHook(env);
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
					// Left undefined when the seam is not armed, so the production
					// enqueue path keeps short-circuiting on an absent option rather
					// than awaiting a live no-op closure every transaction.
					scanTick(database, {
						timing,
						onBeforeEnqueue: crash && (() => crash("mid-scan")),
					}),
				);
			} catch (error) {
				console.error("scheduler: tick failed:", error);
			}
		},
	);
}
