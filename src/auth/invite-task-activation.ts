import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient, QueryResultRow } from "pg";
import * as tables from "../db/schema.ts";
import { UserContextError } from "../db/user-context.ts";
import {
	type TaskActivationClient,
	type TaskActivationLookup,
	withInviteTaskActivation,
} from "../server/notifications/task-activation.ts";
import { taskActivationClientFromDrizzle } from "../server/notifications/task-activation-drizzle.ts";
import { reconcileActiveTaskRecipients } from "../zero/task-activation-transition.ts";

type Database = NodePgDatabase<typeof tables>;
type DrizzleTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Record<string, unknown>;
export type InviteQuery = (
	statement: string,
	values: unknown[],
) => Promise<Row[]>;
type Evidence = { rows: number; bytes: number };

const MAX_EVIDENCE_ROWS = 50_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

export class InviteAuthorityChanged extends Error {
	constructor() {
		super("Invite task authority changed");
	}
}

export class InviteTaskUnavailable extends Error {
	constructor(public reason: "missing" | "foreign" | "pending") {
		super(`Invite task ${reason}`);
	}
}

function field(row: Row | undefined, name: string): string {
	const value = row?.[name];
	if (typeof value !== "string" || !value) throw new InviteAuthorityChanged();
	return value;
}

function optionalField(row: Row, name: string): string | null {
	const value = row[name];
	if (value === null) return null;
	return field(row, name);
}

function charge(budget: Evidence, row: Row | undefined): number {
	const count = Number(row?.count);
	const bytes = Number(row?.bytes);
	if (
		!Number.isSafeInteger(count) ||
		count < 0 ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0
	)
		throw new Error("Invite task evidence probe failed");
	budget.rows += count;
	budget.bytes += bytes;
	if (budget.rows > MAX_EVIDENCE_ROWS || budget.bytes > MAX_EVIDENCE_BYTES)
		throw new Error("Invite task evidence exceeds import limit");
	return count;
}

function same(left: Row[], right: Row[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

// Only static server SQL reaches this adapter. Values become Drizzle parameters,
// never part of SQL text; a malformed placeholder shape fails closed.
export function inviteQueryFromDrizzle(tx: DrizzleTransaction): InviteQuery {
	return async (statement, values) => {
		const fragments: SQL[] = [];
		let position = 0;
		const seen = new Set<number>();
		for (const match of statement.matchAll(/\$(\d+)/g)) {
			const index = Number(match[1]);
			if (!Number.isSafeInteger(index) || index < 1 || index > values.length)
				throw new Error("Invalid invite SQL parameters");
			fragments.push(sql.raw(statement.slice(position, match.index)));
			fragments.push(sql`${sql.param(values[index - 1])}`);
			seen.add(index);
			position = match.index + match[0].length;
		}
		if (seen.size !== values.length)
			throw new Error("Invalid invite SQL parameters");
		fragments.push(sql.raw(statement.slice(position)));
		const result = await tx.execute<Row>(sql.join(fragments, sql.empty()));
		return result.rows.map((row) => {
			const mapped = { ...row };
			for (const [key, column] of [
				["due_at", tables.task.dueAt],
				[
					"import_occurrence_cutoff",
					tables.taskNotificationActivation.importOccurrenceCutoff,
				],
				[
					"recipient_generation_cutoff",
					tables.taskNotificationActivation.recipientGenerationCutoff,
				],
				["cutoff", tables.taskNotificationRecipient.cutoff],
				[
					"overdue_suppressed_due_at",
					tables.taskNotificationRecipient.overdueSuppressedDueAt,
				],
			] as const) {
				if (typeof mapped[key] === "string")
					mapped[key] = column.mapFromDriverValue(mapped[key] as string);
			}
			if (typeof mapped.now === "string") mapped.now = new Date(mapped.now);
			return mapped;
		});
	};
}

export function inviteQueryFromPg(client: PoolClient): InviteQuery {
	return async (statement, values) =>
		(await client.query<QueryResultRow>(statement, values)).rows;
}

export function inviteActivationClientFromDrizzle(
	tx: DrizzleTransaction,
): TaskActivationClient {
	return taskActivationClientFromDrizzle(tx);
}

type TaskSeat = {
	id: string;
	listId: string;
	workspaceId: string;
	listOwnerId: string;
	fallbackUserId: string | null;
	workspaceOwnerId: string;
};

async function taskSeat(
	query: InviteQuery,
	taskId: string,
): Promise<TaskSeat | null> {
	const rows = await query(
		`select t.id, t.list_id, l.workspace_id,
		 l.owner_id as list_owner_id, t.fallback_user_id,
		 w.owner_id as workspace_owner_id
		 from task t join list l on l.id = t.list_id
		 join workspace w on w.id = l.workspace_id and w.kind = 'shared'
		 where t.id = $1`,
		[taskId],
	);
	if (rows.length === 0) return null;
	if (rows.length !== 1) throw new InviteAuthorityChanged();
	const row = rows[0];
	return {
		id: field(row, "id"),
		listId: field(row, "list_id"),
		workspaceId: field(row, "workspace_id"),
		listOwnerId: field(row, "list_owner_id"),
		fallbackUserId: optionalField(row, "fallback_user_id"),
		workspaceOwnerId: field(row, "workspace_owner_id"),
	};
}

export type InviteTaskLock = {
	lookup: TaskActivationLookup;
	taskId: string;
	workspaceId: string;
	userIds: string[];
	workspaceIds: string[];
	evidence: Evidence;
	pairEvidence: Evidence;
	actorId: string;
	inviterId: string | null;
	workspaceOwnerId: string;
	existingWritableIds: string[];
};

// Membership-only invites have no task gate, but still take the same earlier
// authority locks before the invite row or key-grant runtime rows.
export async function lockInviteMembership(
	query: InviteQuery,
	input: {
		workspaceId: string;
		actorId: string;
		inviterId: string;
		role: string;
		insert: boolean;
	},
): Promise<void> {
	const workspace = await query(
		"select id,owner_id,kind from workspace where id=$1",
		[input.workspaceId],
	);
	if (workspace.length !== 1 || workspace[0].kind !== "shared")
		throw new InviteTaskUnavailable("missing");
	const ownerId = field(workspace[0], "owner_id");
	const userIds = [
		...new Set([input.actorId, input.inviterId, ownerId]),
	].sort();
	const evidence: Evidence = { rows: 0, bytes: 0 };
	const memberCount = charge(
		evidence,
		(
			await query(
				`select count(*)::text as count,
			coalesce(sum(octet_length(id)+octet_length(user_id)+octet_length(workspace_id)+octet_length(role::text)),0)::text as bytes
			from membership where user_id=any($1::text[]) and workspace_id=$2`,
				[userIds, input.workspaceId],
			)
		)[0],
	);
	const members = await query(
		"select id,user_id,workspace_id,role from membership where user_id=any($1::text[]) and workspace_id=$2 order by id",
		[userIds, input.workspaceId],
	);
	if (members.length !== memberCount) throw new InviteAuthorityChanged();
	for (const id of userIds) {
		const rows = await query(
			'select id,deleted_at from "user" where id=$1 for update',
			[id],
		);
		if (rows.length !== 1 || rows[0].id !== id)
			throw new InviteAuthorityChanged();
		if (id === input.actorId && rows[0].deleted_at !== null)
			throw new UserContextError();
	}
	const lockedWorkspace = await query(
		"select id,owner_id,kind from workspace where id=$1 for share",
		[input.workspaceId],
	);
	if (!same(workspace, lockedWorkspace)) throw new InviteAuthorityChanged();
	for (const member of members) {
		const locked = await query(
			"select id from membership where id=$1 for share",
			[field(member, "id")],
		);
		if (locked.length !== 1 || locked[0].id !== member.id)
			throw new InviteAuthorityChanged();
	}
	if (
		!same(
			members,
			await query(
				"select id,user_id,workspace_id,role from membership where user_id=any($1::text[]) and workspace_id=$2 order by id",
				[userIds, input.workspaceId],
			),
		)
	)
		throw new InviteAuthorityChanged();
	if (input.insert)
		await query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,$4) on conflict (user_id,workspace_id) do nothing",
			[
				`m_${crypto.randomUUID()}`,
				input.actorId,
				input.workspaceId,
				input.role,
			],
		);
}

export async function lockInviteTask(
	query: InviteQuery,
	activationClient: TaskActivationClient,
	input: {
		taskId: string;
		workspaceId: string;
		actorId: string;
		inviteeId?: string;
		inviterId?: string;
		membershipRole?: string;
	},
): Promise<InviteTaskLock> {
	const evidence: Evidence = { rows: 0, bytes: 0 };
	const seat = await taskSeat(query, input.taskId);
	if (!seat) throw new InviteTaskUnavailable("missing");
	if (seat.workspaceId !== input.workspaceId)
		throw new InviteTaskUnavailable("foreign");
	charge(evidence, {
		count: "1",
		bytes: String(
			[
				seat.id,
				seat.listId,
				seat.workspaceId,
				seat.listOwnerId,
				seat.fallbackUserId ?? "",
				seat.workspaceOwnerId,
			].reduce((total, value) => total + Buffer.byteLength(value), 0),
		),
	});
	const pairProbe = (
		await query(
			`select count(*)::text as count,
			 coalesce(sum(octet_length(id)+octet_length(task_id)+octet_length(user_id)),0)::text as bytes
			 from task_assignee where task_id = $1`,
			[input.taskId],
		)
	)[0];
	const pairCount = charge(evidence, pairProbe);
	const pairEvidence = { rows: pairCount, bytes: Number(pairProbe.bytes) };
	const pairs = await query(
		"select user_id from task_assignee where task_id = $1 order by user_id",
		[input.taskId],
	);
	if (pairs.length !== pairCount) throw new InviteAuthorityChanged();
	const userIds = [
		...new Set([
			input.actorId,
			...(input.inviteeId ? [input.inviteeId] : []),
			...(input.inviterId ? [input.inviterId] : []),
			seat.listOwnerId,
			seat.workspaceOwnerId,
			...(seat.fallbackUserId ? [seat.fallbackUserId] : []),
			...pairs.map((row) => field(row, "user_id")),
		]),
	].sort();
	const memberCount = charge(
		evidence,
		(
			await query(
				`select count(*)::text as count,
			 coalesce(sum(octet_length(id)+octet_length(user_id)+octet_length(workspace_id)+octet_length(role::text)),0)::text as bytes
			 from membership where user_id = any($1::text[]) and workspace_id = $2`,
				[userIds, input.workspaceId],
			)
		)[0],
	);
	const observedMembers = await query(
		"select id, user_id, workspace_id, role from membership where user_id = any($1::text[]) and workspace_id = $2 order by id",
		[userIds, input.workspaceId],
	);
	if (observedMembers.length !== memberCount)
		throw new InviteAuthorityChanged();
	for (const id of userIds) {
		const rows = await query(
			'select id, deleted_at from "user" where id = $1 for update',
			[id],
		);
		if (rows.length !== 1 || rows[0].id !== id)
			throw new InviteAuthorityChanged();
		if (
			(id === input.actorId || id === input.inviteeId) &&
			rows[0].deleted_at !== null
		)
			throw new UserContextError();
	}
	const workspaces = await query(
		"select id, owner_id, kind from workspace where id = $1 for share",
		[input.workspaceId],
	);
	if (
		workspaces.length !== 1 ||
		workspaces[0].id !== input.workspaceId ||
		workspaces[0].owner_id !== seat.workspaceOwnerId ||
		workspaces[0].kind !== "shared"
	)
		throw new InviteAuthorityChanged();
	for (const member of observedMembers) {
		const rows = await query(
			"select id from membership where id = $1 for share",
			[field(member, "id")],
		);
		if (rows.length !== 1 || rows[0].id !== member.id)
			throw new InviteAuthorityChanged();
	}
	if (
		!same(
			observedMembers,
			await query(
				"select id, user_id, workspace_id, role from membership where user_id = any($1::text[]) and workspace_id = $2 order by id",
				[userIds, input.workspaceId],
			),
		)
	)
		throw new InviteAuthorityChanged();
	if (input.inviteeId && input.membershipRole) {
		await query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ($1,$2,$3,$4) on conflict (user_id, workspace_id) do nothing`,
			[
				`m_${crypto.randomUUID()}`,
				input.inviteeId,
				input.workspaceId,
				input.membershipRole,
			],
		);
	}
	const lists = await query(
		"select id, workspace_id, owner_id from list where id = $1 for share",
		[seat.listId],
	);
	if (
		lists.length !== 1 ||
		lists[0].id !== seat.listId ||
		lists[0].workspace_id !== seat.workspaceId ||
		lists[0].owner_id !== seat.listOwnerId
	)
		throw new InviteAuthorityChanged();
	const tasks = await query("select id from task where id = $1 for update", [
		input.taskId,
	]);
	if (tasks.length !== 1 || tasks[0].id !== input.taskId)
		throw new InviteAuthorityChanged();
	const rereadSeat = await taskSeat(query, input.taskId);
	if (JSON.stringify(rereadSeat) !== JSON.stringify(seat))
		throw new InviteAuthorityChanged();
	const rereadPairs = await query(
		"select user_id from task_assignee where task_id = $1 order by user_id",
		[input.taskId],
	);
	if (!same(pairs, rereadPairs)) throw new InviteAuthorityChanged();
	const lookup = await withInviteTaskActivation(
		activationClient,
		input.taskId,
		async (result) => result,
	);
	if (lookup.kind === "guarded" && lookup.status !== "active")
		throw new InviteTaskUnavailable("pending");
	return {
		lookup,
		taskId: input.taskId,
		workspaceId: input.workspaceId,
		userIds,
		workspaceIds: [input.workspaceId],
		evidence,
		pairEvidence,
		actorId: input.actorId,
		inviterId: input.inviterId ?? null,
		workspaceOwnerId: seat.workspaceOwnerId,
		existingWritableIds: observedMembers
			.filter((member) =>
				["owner", "admin", "member"].includes(field(member, "role")),
			)
			.map((member) => field(member, "user_id")),
	};
}

async function verifiedWriter(
	query: InviteQuery,
	locked: InviteTaskLock,
	beforeClaim: boolean,
): Promise<string> {
	for (const id of [
		locked.actorId,
		locked.inviterId,
		locked.workspaceOwnerId,
	]) {
		if (!id || !locked.userIds.includes(id)) continue;
		if (beforeClaim && !locked.existingWritableIds.includes(id)) continue;
		const rows = await query(
			`select m.user_id from membership m
			 join "user" u on u.id = m.user_id and u.deleted_at is null
			 where m.user_id = $1 and m.workspace_id = $2
			 and m.role in ('owner','admin','member')`,
			[id, locked.workspaceId],
		);
		if (rows.length === 1 && rows[0].user_id === id) return id;
		if (rows.length > 1) throw new InviteAuthorityChanged();
	}
	throw new InviteAuthorityChanged();
}

async function exactSetting(query: InviteQuery, name: string): Promise<string> {
	const rows = await query("select current_setting($1, true) as value", [name]);
	if (
		rows.length !== 1 ||
		(rows[0].value !== null && typeof rows[0].value !== "string")
	)
		throw new Error("Invite activation setting lookup failed");
	return (rows[0].value as string | null) ?? "";
}

async function selectEvidenceWriter(
	query: InviteQuery,
	locked: InviteTaskLock,
	beforeClaim: boolean,
): Promise<void> {
	if ((await exactSetting(query, "ditero.activation_scope")) !== "")
		throw new Error("Invite activation scope is still set");
	if ((await exactSetting(query, "ditero.user_id")) !== locked.actorId)
		throw new Error("Invite activation actor context mismatch");
	const writer = await verifiedWriter(query, locked, beforeClaim);
	const set = await query(
		"select set_config('ditero.user_id', $1, true) as value",
		[writer],
	);
	if (
		set.length !== 1 ||
		set[0].value !== writer ||
		(await exactSetting(query, "ditero.user_id")) !== writer
	)
		throw new Error("Invite activation writer context setup failed");
}

async function restoreActor(
	query: InviteQuery,
	locked: InviteTaskLock,
): Promise<void> {
	const restored = await query(
		"select set_config('ditero.user_id', $1, true) as value",
		[locked.actorId],
	);
	if (
		restored.length !== 1 ||
		restored[0].value !== locked.actorId ||
		(await exactSetting(query, "ditero.user_id")) !== locked.actorId ||
		(await exactSetting(query, "ditero.activation_scope")) !== ""
	)
		throw new Error("Invite activation actor context restore failed");
}

// The writer context permits only these fixed row locks. On any error the outer
// transaction rolls back, including its transaction-local identity change.
export async function lockInviteEvidence(
	query: InviteQuery,
	locked: InviteTaskLock,
): Promise<void> {
	if (locked.lookup.kind === "native") return;
	await selectEvidenceWriter(query, locked, true);
	const pairs = await query(
		"select id from task_assignee where task_id = $1 order by id for share",
		[locked.taskId],
	);
	if (pairs.length > MAX_EVIDENCE_ROWS)
		throw new Error("Invite task evidence exceeds import limit");
	const guards = await query(
		"select task_id, status, generation from task_notification_activation where task_id = $1 for update",
		[locked.taskId],
	);
	if (
		guards.length !== 1 ||
		guards[0].task_id !== locked.taskId ||
		guards[0].status !== "active" ||
		guards[0].generation !== locked.lookup.generation
	)
		throw new InviteAuthorityChanged();
	const rows = await query(
		`select count(*)::text as count,
		 coalesce(sum(octet_length(task_id)+octet_length(user_id)+
		 coalesce(octet_length(overdue_suppressed_due_at::text),0)),0)::text as bytes
		 from task_notification_recipient where task_id = $1`,
		[locked.taskId],
	);
	const count = charge({ ...locked.evidence }, rows[0]);
	const recipients = await query(
		"select user_id from task_notification_recipient where task_id = $1 order by user_id for update",
		[locked.taskId],
	);
	if (recipients.length !== count) throw new InviteAuthorityChanged();
	await restoreActor(query, locked);
}

// This is the only write allowed under the temporary writer identity. It runs
// after the token has been claimed and the task/assignment proof has passed.
export async function reconcileInviteAssignment(
	query: InviteQuery,
	locked: InviteTaskLock,
): Promise<void> {
	if (locked.lookup.kind === "native") return;
	await selectEvidenceWriter(query, locked, false);
	await reconcileActiveTaskRecipients(query, locked.taskId, {
		userIds: locked.userIds,
		workspaceIds: locked.workspaceIds,
		evidence: {
			rows: locked.evidence.rows - locked.pairEvidence.rows,
			bytes: locked.evidence.bytes - locked.pairEvidence.bytes,
		},
	});
	await restoreActor(query, locked);
}

export async function committedInviteAssignment(
	query: InviteQuery,
	taskId: string,
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const rows = await query(
		`select t.id as task_id, l.workspace_id, m.id as membership_id,
		 a.id as assignment_id, g.task_id as guard_task_id,
		 r.task_id as recipient_task_id
		 from task t join list l on l.id = t.list_id
		 left join membership m on m.workspace_id = l.workspace_id and m.user_id = $2
		 left join task_assignee a on a.task_id = t.id and a.user_id = $2
		 left join task_notification_activation g on g.task_id = t.id
		 left join task_notification_recipient r on r.task_id = t.id and r.user_id = $2
		 where t.id = $1`,
		[taskId, userId],
	);
	if (rows.length !== 1) return false;
	const row = rows[0];
	return (
		row.task_id === taskId &&
		row.workspace_id === workspaceId &&
		typeof row.membership_id === "string" &&
		typeof row.assignment_id === "string" &&
		(row.guard_task_id === null || row.recipient_task_id === taskId)
	);
}
