import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";
import { nextEscalation } from "../../domain/escalation.ts";
import { resolveEscalationPolicy } from "../../domain/escalation-policy.ts";
import {
	DEFAULT_PREF,
	loadChannels,
	loadPrefs,
	type Pref,
} from "./recipients.ts";
import type { TaskActivationLookup } from "./task-activation.ts";
import { withDrizzleProducerTaskActivation } from "./task-activation-drizzle.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

const MAX_RELATIONSHIPS = 50_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

export type ProducerCandidate =
	| {
			kind: "reminder";
			taskId: string;
			recipientUserId: string;
			occurrenceAt: Date;
			reminderStateId?: string;
	  }
	| {
			kind: "fallback-create";
			taskId: string;
			recipientUserId: string;
			occurrenceAt: Date;
			originReminderStateId: string;
			at: Date;
	  }
	| { kind: "overdue"; taskId: string; recipientUserId: string };

export type ProducerTask = {
	id: string;
	listId: string;
	title: string;
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
	listKind: string;
};

type Pair = { id: string; user_id: string };
type Member = { id: string; user_id: string; workspace_id: string };
type Reminder = {
	id: string;
	task_id: string;
	recipient_user_id: string;
	occurrence_at: Date;
	status: string;
	fire_count: number;
	next_attempt_at: Date | null;
	deferred_until: Date | null;
	fired_late: boolean;
};
type Recipient = {
	user_id: string;
	active: boolean;
	generation: number;
	cutoff: Date | null;
	overdue_suppressed_due_at: Date | null;
};

export type ProducerAuthority = {
	task: ProducerTask;
	lookup: TaskActivationLookup;
	recipientKind: "base" | "fallback";
	baseRecipientIds: string[];
	memberUserIds: string[];
	recipientUserId: string;
	recipientPref: Pref;
	ownerPref: Pref;
	channels: ChannelKind[];
	reminderState: Reminder | null;
	originReminderState: Reminder | null;
	recipientEvidence: Recipient | null;
};

export type ProducerAuthorityResult<T> =
	| { kind: "eligible"; value: T }
	| { kind: "skip" };

export class ProducerAuthorityChanged extends Error {
	constructor() {
		super("Producer authority changed during lock acquisition");
		this.name = "ProducerAuthorityChanged";
	}
}

// A changed prediscovery set needs a fresh transaction and lock acquisition.
// Never retry SQL errors or malformed authority, and never retry in a tainted tx.
export async function retryProducerCandidate<T>(
	run: () => Promise<T>,
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (!(error instanceof ProducerAuthorityChanged)) throw error;
	}
	return run();
}

function sameRows<Row>(a: Row[], b: Row[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function validInstant(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function dbInstant(value: unknown): Date {
	const instant = typeof value === "string" ? new Date(value) : value;
	if (!(instant instanceof Date) || !validInstant(instant))
		throw new Error("Producer database timestamp is invalid");
	return instant;
}

function dbInstantOrNull(value: unknown): Date | null {
	return value === null ? null : dbInstant(value);
}

function parsedReminder(row: Reminder): Reminder {
	return {
		...row,
		occurrence_at: dbInstant(row.occurrence_at),
		next_attempt_at: dbInstantOrNull(row.next_attempt_at),
		deferred_until: dbInstantOrNull(row.deferred_until),
	};
}

function parsedRecipient(row: Recipient): Recipient {
	return {
		...row,
		cutoff: dbInstantOrNull(row.cutoff),
		overdue_suppressed_due_at: dbInstantOrNull(row.overdue_suppressed_due_at),
	};
}

// Drizzle expands a JS array into a SQL record, not a PostgreSQL array.
// A bounded JSON parameter keeps IDs as values and handles the empty set.
function textIds(ids: string[]): SQL {
	return sql`array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

function cutoffAllows(instant: Date, cutoff: Date | null): boolean {
	if (cutoff === null) return false;
	if (!validInstant(cutoff))
		throw new Error("Producer recipient cutoff is invalid");
	return instant.getTime() >= cutoff.getTime();
}

function policyFor(task: ProducerTask, pref: Pref) {
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

async function taskRow(
	tx: Transaction,
	taskId: string,
): Promise<ProducerTask | null> {
	const { rows } = await tx.execute<{
		id: string;
		list_id: string;
		title: string;
		done: boolean;
		due_at: Date | null;
		rrule: string | null;
		reminder_time: string | null;
		repeat_every_min: number | null;
		max_repeats: number | null;
		fallback_user_id: string | null;
		urgent: boolean;
		list_owner_id: string;
		workspace_id: string;
		list_kind: string;
	}>(sql`
		select t.id, t.list_id, t.title, t.done, t.due_at, t.rrule,
			t.reminder_time, t.repeat_every_min, t.max_repeats,
			t.fallback_user_id, t.urgent, l.owner_id as list_owner_id,
			l.workspace_id, l.kind as list_kind
		from task t join list l on l.id = t.list_id where t.id = ${taskId}
	`);
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		listId: row.list_id,
		title: row.title,
		done: row.done,
		dueAt: dbInstantOrNull(row.due_at),
		rrule: row.rrule,
		reminderTime: row.reminder_time,
		repeatEveryMin: row.repeat_every_min,
		maxRepeats: row.max_repeats,
		fallbackUserId: row.fallback_user_id,
		urgent: row.urgent,
		listOwnerId: row.list_owner_id,
		workspaceId: row.workspace_id,
		listKind: row.list_kind,
	};
}

async function pairs(
	tx: Transaction,
	taskId: string,
	lock: boolean,
): Promise<Pair[]> {
	const query = lock
		? sql`select id, user_id from task_assignee where task_id = ${taskId} order by id for share`
		: sql`select id, user_id from task_assignee where task_id = ${taskId} order by id`;
	return (await tx.execute<Pair>(query)).rows;
}

async function memberships(
	tx: Transaction,
	workspaceId: string,
	userIds: string[],
	lockIds?: string[],
): Promise<Member[]> {
	const query = lockIds
		? sql`select id, user_id, workspace_id from membership where id = any(${textIds(lockIds)}) order by id for share`
		: sql`select id, user_id, workspace_id from membership where workspace_id = ${workspaceId} and user_id = any(${textIds(userIds)}) order by id`;
	return (await tx.execute<Member>(query)).rows;
}

async function reminder(tx: Transaction, id: string): Promise<Reminder | null> {
	const row = (
		await tx.execute<Reminder>(sql`
			select id, task_id, recipient_user_id, occurrence_at, status,
				fire_count, next_attempt_at, deferred_until, fired_late
			from reminder_state where id = ${id}
		`)
	).rows[0];
	return row ? parsedReminder(row) : null;
}

async function origins(
	tx: Transaction,
	taskId: string,
	occurrenceAt: Date,
): Promise<Reminder[]> {
	const { rows } = await tx.execute<Reminder>(sql`
		select id, task_id, recipient_user_id, occurrence_at, status,
			fire_count, next_attempt_at, deferred_until, fired_late
		from reminder_state
		where task_id = ${taskId} and occurrence_at = ${occurrenceAt}
			and status = 'escalated'
		order by id limit ${MAX_RELATIONSHIPS + 1}
	`);
	if (rows.length > MAX_RELATIONSHIPS)
		throw new Error("Producer origin evidence exceeds the import row limit");
	return rows.map(parsedReminder);
}

function baseRecipientIds(task: ProducerTask, pairRows: Pair[]): string[] {
	return pairRows.length > 0
		? [...new Set(pairRows.map((row) => row.user_id))].sort()
		: [task.listOwnerId];
}

function presentMember(
	rows: Member[],
	userId: string,
	workspaceId: string,
): boolean {
	return rows.some(
		(row) => row.user_id === userId && row.workspace_id === workspaceId,
	);
}

// Caller owns BEGIN/rollback and isolates each candidate. It may retry
// ProducerAuthorityChanged only in a fresh transaction. Callback only enqueues DB
// writes, never sends on the network. User FOR UPDATE also fences insertion of
// a previously absent user_pref through its foreign key.
export async function withProducerAuthority<T>(
	tx: Transaction,
	candidate: ProducerCandidate,
	callback: (authority: ProducerAuthority, tx: Transaction) => Promise<T>,
	options: { onAfterDiscovery?: () => void | Promise<void> } = {},
): Promise<ProducerAuthorityResult<T>> {
	if (typeof candidate.taskId !== "string" || !candidate.recipientUserId)
		throw new Error("Producer task and recipient IDs are required");
	if (candidate.kind !== "overdue" && !validInstant(candidate.occurrenceAt))
		throw new Error("Producer occurrence is invalid");
	if (candidate.kind === "fallback-create" && !validInstant(candidate.at))
		throw new Error("Producer escalation time is invalid");

	const observed = await taskRow(tx, candidate.taskId);
	if (!observed) return { kind: "skip" };
	const probe = await tx.execute<{ count: number; bytes: string }>(sql`
		select count(*)::int as count,
			coalesce(sum(octet_length(id) + octet_length(user_id)), 0)::text as bytes
		from task_assignee where task_id = ${candidate.taskId}
	`);
	if (
		!probe.rows[0] ||
		probe.rows[0].count > MAX_RELATIONSHIPS ||
		Number(probe.rows[0].bytes) > MAX_EVIDENCE_BYTES
	) {
		throw new Error("Producer assignment evidence exceeds the import limit");
	}
	const observedPairs = await pairs(tx, candidate.taskId, false);
	if (observedPairs.length !== probe.rows[0].count)
		throw new ProducerAuthorityChanged();
	const observedState =
		candidate.kind === "reminder" && candidate.reminderStateId
			? await reminder(tx, candidate.reminderStateId)
			: null;
	const observedOrigin =
		candidate.kind === "fallback-create"
			? await reminder(tx, candidate.originReminderStateId)
			: null;
	const observedOrigins =
		candidate.kind === "reminder" && candidate.reminderStateId
			? await origins(tx, candidate.taskId, candidate.occurrenceAt)
			: [];
	const baseIds = baseRecipientIds(observed, observedPairs);
	const initialUsers = [
		...new Set([
			observed.listOwnerId,
			candidate.recipientUserId,
			...baseIds,
			...(observed.fallbackUserId ? [observed.fallbackUserId] : []),
			...(observedOrigin ? [observedOrigin.recipient_user_id] : []),
			...observedOrigins.map((row) => row.recipient_user_id),
		]),
	];
	const policySourceIds = [
		...new Set([
			candidate.recipientUserId,
			...(observedOrigin ? [observedOrigin.recipient_user_id] : []),
			...observedOrigins.map((row) => row.recipient_user_id),
		]),
	];
	const observedPrefs = await loadPrefs(
		tx as unknown as Database,
		initialUsers,
	);
	const userIds = [
		...new Set([
			...initialUsers,
			...policySourceIds.flatMap((id) => {
				const fallback = policyFor(
					observed,
					observedPrefs.get(id) ?? DEFAULT_PREF,
				).fallbackUserId;
				return fallback ? [fallback] : [];
			}),
		]),
	].sort();
	if (
		userIds.length > MAX_RELATIONSHIPS ||
		Buffer.byteLength(JSON.stringify(userIds)) > MAX_EVIDENCE_BYTES
	)
		throw new Error("Producer user evidence exceeds the import byte limit");
	const observedMembers = await memberships(tx, observed.workspaceId, userIds);
	await options.onAfterDiscovery?.();

	const lockedUsers = await tx.execute<{ id: string }>(sql`
		select id from "user" where id = any(${textIds(userIds)}) order by id for update
	`);
	const lockedUserIds = new Set(lockedUsers.rows.map((row) => row.id));
	const workspace = await tx.execute<{ id: string }>(sql`
		select id from workspace where id = ${observed.workspaceId} for share
	`);
	if (workspace.rows.length !== 1) return { kind: "skip" };
	const lockedMembers = await memberships(
		tx,
		observed.workspaceId,
		userIds,
		observedMembers.map((row) => row.id),
	);
	if (!sameRows(observedMembers, lockedMembers))
		throw new ProducerAuthorityChanged();
	const list = await tx.execute<{
		id: string;
		workspace_id: string;
		owner_id: string;
	}>(
		sql`select id, workspace_id, owner_id from list where id = ${observed.listId} for share`,
	);
	if (list.rows.length !== 1) return { kind: "skip" };
	if (
		list.rows[0].workspace_id !== observed.workspaceId ||
		list.rows[0].owner_id !== observed.listOwnerId
	) {
		throw new ProducerAuthorityChanged();
	}

	return withDrizzleProducerTaskActivation(
		tx,
		candidate.taskId,
		async (lookup) => {
			const task = await taskRow(tx, candidate.taskId);
			if (!task) throw new Error("Locked producer task disappeared");
			if (
				task.listId !== observed.listId ||
				task.workspaceId !== observed.workspaceId ||
				task.listOwnerId !== observed.listOwnerId ||
				(task.fallbackUserId && !lockedUserIds.has(task.fallbackUserId))
			) {
				throw new ProducerAuthorityChanged();
			}
			const lockedPairs = await pairs(tx, candidate.taskId, true);
			if (!sameRows(observedPairs, lockedPairs))
				throw new ProducerAuthorityChanged();
			const currentMembers = await memberships(tx, task.workspaceId, userIds);
			if (!sameRows(lockedMembers, currentMembers))
				throw new ProducerAuthorityChanged();
			if (
				!lockedUserIds.has(candidate.recipientUserId) ||
				!presentMember(
					currentMembers,
					candidate.recipientUserId,
					task.workspaceId,
				)
			) {
				return { kind: "skip" };
			}
			if (lookup.kind === "guarded" && lookup.status !== "active")
				return { kind: "skip" };

			const currentBaseIds = baseRecipientIds(task, lockedPairs);
			const isBase = currentBaseIds.includes(candidate.recipientUserId);
			if (candidate.kind === "overdue" && !isBase) return { kind: "skip" };
			if (
				candidate.kind === "reminder" &&
				!candidate.reminderStateId &&
				!isBase
			)
				return { kind: "skip" };
			const relevantIds = [
				...new Set([...currentBaseIds, candidate.recipientUserId]),
			];
			const evidenceRows = (
				await tx.execute<Recipient>(sql`
				select user_id, active, generation, cutoff, overdue_suppressed_due_at
				from task_notification_recipient
				where task_id = ${task.id} and user_id = any(${textIds(relevantIds)})
			`)
			).rows.map(parsedRecipient);
			const evidence = new Map(evidenceRows.map((row) => [row.user_id, row]));

			await tx.execute(sql`
			select id from user_pref where id = any(${textIds(userIds)}) order by id for share
		`);
			const prefs = await loadPrefs(tx as unknown as Database, userIds);
			for (const id of policySourceIds) {
				const target = policyFor(
					task,
					prefs.get(id) ?? DEFAULT_PREF,
				).fallbackUserId;
				if (target && !userIds.includes(target))
					throw new ProducerAuthorityChanged();
			}
			await tx.execute(sql`
			select id from notification_channel
			where user_id = ${candidate.recipientUserId} order by id for share
		`);
			const channelMap = await loadChannels(tx as unknown as Database, [
				candidate.recipientUserId,
			]);

			const stateIds = [
				...new Set([
					...(observedState ? [observedState.id] : []),
					...(observedOrigin ? [observedOrigin.id] : []),
					...observedOrigins.map((row) => row.id),
				]),
			].sort();
			const lockedStates = (
				await tx.execute<Reminder>(sql`
				select id, task_id, recipient_user_id, occurrence_at, status,
					fire_count, next_attempt_at, deferred_until, fired_late
				from reminder_state where id = any(${textIds(stateIds)}) order by id for update
			`)
			).rows.map(parsedReminder);
			if (lockedStates.length !== stateIds.length)
				throw new ProducerAuthorityChanged();
			const states = new Map(lockedStates.map((row) => [row.id, row]));
			const reminderState = observedState
				? (states.get(observedState.id) ?? null)
				: null;
			const originState = observedOrigin
				? (states.get(observedOrigin.id) ?? null)
				: null;
			if (
				candidate.kind === "reminder" &&
				candidate.reminderStateId &&
				!reminderState
			)
				return { kind: "skip" };
			if (candidate.kind === "fallback-create" && !originState)
				return { kind: "skip" };
			if (
				reminderState &&
				(reminderState.task_id !== task.id ||
					reminderState.recipient_user_id !== candidate.recipientUserId ||
					candidate.kind !== "reminder" ||
					reminderState.occurrence_at.getTime() !==
						candidate.occurrenceAt.getTime())
			) {
				return { kind: "skip" };
			}

			let recipientKind: "base" | "fallback" = isBase ? "base" : "fallback";
			let provenOrigin: Reminder | null = null;
			if (candidate.kind === "fallback-create") {
				recipientKind = "fallback";
				if (
					!originState ||
					originState.task_id !== task.id ||
					originState.occurrence_at.getTime() !==
						candidate.occurrenceAt.getTime() ||
					originState.status !== "pending" ||
					!currentBaseIds.includes(originState.recipient_user_id)
				)
					return { kind: "skip" };
				const sourcePref =
					prefs.get(originState.recipient_user_id) ?? DEFAULT_PREF;
				const action = nextEscalation(
					{ fireCount: originState.fire_count },
					policyFor(task, sourcePref),
					candidate.at,
				);
				if (
					action.kind !== "escalate" ||
					action.userId !== candidate.recipientUserId
				)
					return { kind: "skip" };
				provenOrigin = originState;
			} else if (candidate.kind === "reminder" && !isBase) {
				if (!reminderState) return { kind: "skip" };
				if (lookup.kind === "guarded") {
					const originsNow = await origins(
						tx,
						task.id,
						reminderState.occurrence_at,
					);
					if (!sameRows(observedOrigins, originsNow))
						throw new ProducerAuthorityChanged();
					provenOrigin =
						originsNow.find((origin) => {
							if (!currentBaseIds.includes(origin.recipient_user_id))
								return false;
							const sourcePref =
								prefs.get(origin.recipient_user_id) ?? DEFAULT_PREF;
							return (
								policyFor(task, sourcePref).fallbackUserId ===
								candidate.recipientUserId
							);
						}) ?? null;
					if (!provenOrigin) return { kind: "skip" };
				}
			}

			const recipientEvidence = evidence.get(candidate.recipientUserId) ?? null;
			if (lookup.kind === "guarded") {
				if (candidate.kind !== "overdue") {
					if (
						!cutoffAllows(
							candidate.occurrenceAt,
							lookup.importOccurrenceCutoff,
						) ||
						!cutoffAllows(
							candidate.occurrenceAt,
							lookup.recipientGenerationCutoff,
						)
					)
						return { kind: "skip" };
				}
				const baseEvidence =
					recipientKind === "base"
						? recipientEvidence
						: (evidence.get(provenOrigin?.recipient_user_id ?? "") ?? null);
				if (
					!baseEvidence?.active ||
					baseEvidence.generation !== lookup.generation ||
					(candidate.kind !== "overdue" &&
						!cutoffAllows(candidate.occurrenceAt, baseEvidence.cutoff))
				)
					return { kind: "skip" };
				if (
					candidate.kind === "overdue" &&
					baseEvidence.overdue_suppressed_due_at !== null
				) {
					if (!validInstant(baseEvidence.overdue_suppressed_due_at))
						throw new Error("Producer overdue suppression is invalid");
					if (
						task.dueAt?.getTime() ===
						baseEvidence.overdue_suppressed_due_at.getTime()
					)
						return { kind: "skip" };
				}
				if (
					candidate.kind === "fallback-create" &&
					isBase &&
					recipientEvidence
				) {
					if (
						!recipientEvidence.active ||
						recipientEvidence.generation !== lookup.generation ||
						!cutoffAllows(candidate.occurrenceAt, recipientEvidence.cutoff)
					)
						return { kind: "skip" };
				}
			}
			if (
				provenOrigin &&
				(!lockedUserIds.has(provenOrigin.recipient_user_id) ||
					!presentMember(
						currentMembers,
						provenOrigin.recipient_user_id,
						task.workspaceId,
					))
			)
				return { kind: "skip" };

			const context: ProducerAuthority = {
				task,
				lookup,
				recipientKind,
				baseRecipientIds: currentBaseIds,
				memberUserIds: currentMembers.map((row) => row.user_id),
				recipientUserId: candidate.recipientUserId,
				recipientPref: prefs.get(candidate.recipientUserId) ?? DEFAULT_PREF,
				ownerPref: prefs.get(task.listOwnerId) ?? DEFAULT_PREF,
				channels: channelMap.get(candidate.recipientUserId) ?? [],
				reminderState,
				originReminderState: provenOrigin,
				recipientEvidence,
			};
			return { kind: "eligible", value: await callback(context, tx) };
		},
	);
}
