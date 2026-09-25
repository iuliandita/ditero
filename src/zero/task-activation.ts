import type { Transaction } from "@rocicorp/zero";
import type { Schema } from "./schema.gen.ts";
import { reconcileActiveTaskRecipients } from "./task-activation-transition.ts";

type ZeroTransaction = Transaction<Schema>;
type RawRow = Record<string, unknown>;
type TaskSeat = {
	id: string;
	listId: string;
	workspaceId: string;
	listOwnerId: string;
	fallbackUserId: string | null;
	parentId: string | null;
};
type MemberSeat = {
	id: string;
	userId: string;
	workspaceId: string;
	role: string;
};
const MAX_EVIDENCE_ROWS = 50_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
type EvidenceBudget = { rows: number; bytes: number };

function measured(row: RawRow | undefined): EvidenceBudget {
	const rows = Number(row?.count);
	const bytes = Number(row?.bytes);
	if (
		!Number.isSafeInteger(rows) ||
		rows < 0 ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0
	)
		throw new Error("Task activation evidence probe failed");
	return { rows, bytes };
}

function charge(budget: EvidenceBudget, evidence: EvidenceBudget): void {
	budget.rows += evidence.rows;
	budget.bytes += evidence.bytes;
	if (budget.rows > MAX_EVIDENCE_ROWS || budget.bytes > MAX_EVIDENCE_BYTES)
		throw new Error("Task activation evidence exceeds import limit");
}

async function probe(
	tx: ZeroTransaction,
	sql: string,
	values: unknown[],
	budget?: EvidenceBudget,
): Promise<EvidenceBudget> {
	const rows = await query(tx, sql, values);
	if (rows.length !== 1)
		throw new Error("Task activation evidence probe failed");
	const evidence = measured(rows[0]);
	if (budget) charge(budget, evidence);
	else charge({ rows: 0, bytes: 0 }, evidence);
	return evidence;
}

function field(row: RawRow, key: string): string {
	const value = row[key];
	if (typeof value !== "string")
		throw new Error(`Invalid task activation ${key}`);
	return value;
}

function optionalField(row: RawRow, key: string): string | null {
	const value = row[key];
	if (value === null) return null;
	return field(row, key);
}

async function query(
	tx: ZeroTransaction,
	sql: string,
	values: unknown[] = [],
): Promise<RawRow[]> {
	if (tx.location !== "server") throw new Error("Server transaction required");
	return Array.from(await tx.dbTransaction.query(sql, values));
}

async function setting(
	tx: ZeroTransaction,
	name: string,
): Promise<string | null> {
	const rows = await query(tx, "select current_setting($1, true) as value", [
		name,
	]);
	if (
		rows.length !== 1 ||
		(rows[0].value !== null && typeof rows[0].value !== "string")
	)
		throw new Error("Task activation context lookup failed");
	return rows[0].value as string | null;
}

async function setUser(tx: ZeroTransaction, userId: string): Promise<void> {
	const rows = await query(
		tx,
		"select set_config('ditero.user_id', $1, true) as value",
		[userId],
	);
	if (
		rows.length !== 1 ||
		rows[0].value !== userId ||
		(await setting(tx, "ditero.user_id")) !== userId
	)
		throw new Error("Task activation user context setup failed");
}

// The route uses this for every authoritative mutation. Direct trusted callers
// still use ensureUser below because existing tests invoke mutators without it.
export async function withZeroUserContext<T>(
	tx: ZeroTransaction,
	userId: string,
	callback: () => Promise<T>,
): Promise<T> {
	if (tx.location !== "server") return callback();
	if (!userId) throw new Error("Task activation user context is required");
	const prior = await setting(tx, "ditero.user_id");
	if (prior && prior !== userId)
		throw new Error("Task activation user context mismatch");
	await setUser(tx, userId);
	if ((await setting(tx, "ditero.activation_scope")) || "")
		throw new Error("Nested task activation scope is forbidden");
	const result = await callback();
	const restored = prior ?? "";
	await query(tx, "select set_config('ditero.user_id', $1, true) as value", [
		restored,
	]);
	if ((await setting(tx, "ditero.user_id")) !== restored)
		throw new Error("Task activation user context cleanup failed");
	return result;
}

async function ensureUser(tx: ZeroTransaction, userId: string): Promise<void> {
	const current = await setting(tx, "ditero.user_id");
	if (current && current !== userId)
		throw new Error("Task activation user context mismatch");
	if (!current) await setUser(tx, userId);
	if ((await setting(tx, "ditero.activation_scope")) || "")
		throw new Error("Nested task activation scope is forbidden");
}

async function taskSeats(
	tx: ZeroTransaction,
	taskIds: string[],
): Promise<TaskSeat[]> {
	if (taskIds.length === 0) return [];
	const rows = await query(
		tx,
		`select t.id, t.list_id, l.workspace_id,
		l.owner_id as list_owner_id, t.fallback_user_id, t.parent_id
		from task t join list l on l.id = t.list_id
		where t.id = any($1::text[]) order by t.id`,
		[taskIds],
	);
	return rows.map((row) => ({
		id: field(row, "id"),
		listId: field(row, "list_id"),
		workspaceId: field(row, "workspace_id"),
		listOwnerId: field(row, "list_owner_id"),
		fallbackUserId: optionalField(row, "fallback_user_id"),
		parentId: optionalField(row, "parent_id"),
	}));
}

async function members(
	tx: ZeroTransaction,
	userIds: string[],
	workspaceIds: string[],
): Promise<MemberSeat[]> {
	if (userIds.length === 0 || workspaceIds.length === 0) return [];
	const rows = await query(
		tx,
		`select id, user_id, workspace_id, role from membership
		where user_id = any($1::text[]) and workspace_id = any($2::text[]) order by id`,
		[userIds, workspaceIds],
	);
	return rows.map((row) => ({
		id: field(row, "id"),
		userId: field(row, "user_id"),
		workspaceId: field(row, "workspace_id"),
		role: field(row, "role"),
	}));
}

function same<T>(left: T[], right: T[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function ids(
	tx: ZeroTransaction,
	sql: string,
	values: unknown[],
): Promise<string[]> {
	return (await query(tx, sql, values)).map((row) => field(row, "id"));
}

export type ZeroTaskLockOptions = {
	taskIds: string[];
	targetListIds?: string[];
	extraUserIds?: string[];
	includeChildren?: boolean;
	allowPending?: boolean;
	allowViewer?: boolean;
};
export type ZeroTaskLock = {
	taskIds: string[];
	userIds: string[];
	workspaceIds: string[];
	evidence: EvidenceBudget;
};

// Discovery is read-only. Every lock is then acquired in user, workspace,
// membership, list, task order. A changed discovery fails instead of taking a
// lock earlier in that order after later locks are held.
export async function lockZeroTaskWrite(
	tx: ZeroTransaction,
	actorId: string,
	options: ZeroTaskLockOptions,
): Promise<ZeroTaskLock> {
	if (tx.location !== "server")
		return {
			taskIds: [...options.taskIds],
			userIds: [],
			workspaceIds: [],
			evidence: { rows: 0, bytes: 0 },
		};
	await ensureUser(tx, actorId);
	const evidence: EvidenceBudget = { rows: 0, bytes: 0 };
	const initialIds = [...new Set(options.taskIds)].sort();
	if (options.includeChildren) {
		if (!options.allowPending)
			await probe(
				tx,
				`select count(*)::text as count,
				coalesce(sum(octet_length(id)),0)::text as bytes
				from task where parent_id = any($1::text[])`,
				[initialIds],
			);
		const childIds = await ids(
			tx,
			"select id from task where parent_id = any($1::text[]) order by id",
			[initialIds],
		);
		initialIds.push(...childIds.filter((id) => !initialIds.includes(id)));
		initialIds.sort();
	}
	if (!options.allowPending) {
		const seatProbe = await probe(
			tx,
			`select count(*)::text as count,
			coalesce(sum(octet_length(t.id)+octet_length(t.list_id)+
			octet_length(l.workspace_id)+octet_length(l.owner_id)+
			coalesce(octet_length(t.fallback_user_id),0)+
			coalesce(octet_length(t.parent_id),0)),0)::text as bytes
			from task t join list l on l.id=t.list_id where t.id = any($1::text[])`,
			[initialIds],
			evidence,
		);
		if (seatProbe.rows !== initialIds.length)
			throw new Error("Task activation tasks changed");
	}
	const observed = await taskSeats(tx, initialIds);
	if (observed.length !== initialIds.length) throw new Error("task not found");
	const targetLists = [...new Set(options.targetListIds ?? [])].sort();
	const targetRows = targetLists.length
		? await query(
				tx,
				"select id, workspace_id, owner_id from list where id = any($1::text[]) order by id",
				[targetLists],
			)
		: [];
	if (targetRows.length !== targetLists.length)
		throw new Error("list not found");
	const listIds = [
		...new Set([...observed.map((row) => row.listId), ...targetLists]),
	].sort();
	const workspaceIds = [
		...new Set([
			...observed.map((row) => row.workspaceId),
			...targetRows.map((row) => field(row, "workspace_id")),
		]),
	].sort();
	const pairProbe = options.allowPending
		? null
		: await probe(
				tx,
				`select count(*)::text as count,
		coalesce(sum(octet_length(id)+octet_length(task_id)+octet_length(user_id)),0)::text as bytes
		from task_assignee where task_id = any($1::text[])`,
				[initialIds],
				evidence,
			);
	const observedPairs = options.allowPending
		? []
		: await query(
				tx,
				"select task_id, user_id from task_assignee where task_id = any($1::text[]) order by task_id, user_id",
				[initialIds],
			);
	if (pairProbe && observedPairs.length !== pairProbe.rows)
		throw new Error("Task activation assignments changed");
	const userIds = [
		...new Set([
			actorId,
			...observed.map((row) => row.listOwnerId),
			...observed.flatMap((row) =>
				row.fallbackUserId ? [row.fallbackUserId] : [],
			),
			...targetRows.map((row) => field(row, "owner_id")),
			...observedPairs.map((row) => field(row, "user_id")),
			...(options.extraUserIds ?? []),
		]),
	].sort();
	const memberProbe = await probe(
		tx,
		`select count(*)::text as count,
		coalesce(sum(octet_length(id)+octet_length(user_id)+octet_length(workspace_id)+octet_length(role::text)),0)::text as bytes
		from membership where user_id = any($1::text[]) and workspace_id = any($2::text[])`,
		[userIds, workspaceIds],
		options.allowPending ? undefined : evidence,
	);
	const observedMembers = await members(tx, userIds, workspaceIds);
	if (observedMembers.length !== memberProbe.rows)
		throw new Error("Task activation memberships changed");
	for (const id of userIds) {
		const rows = await query(
			tx,
			'select id, deleted_at from "user" where id = $1 for update',
			[id],
		);
		if (
			rows.length !== 1 ||
			rows[0].id !== id ||
			((id === actorId || options.extraUserIds?.includes(id)) &&
				rows[0].deleted_at !== null)
		)
			throw new Error("Task activation user authority changed");
	}
	for (const id of workspaceIds) {
		if (
			(
				await ids(tx, "select id from workspace where id = $1 for share", [id])
			)[0] !== id
		)
			throw new Error("Task activation workspace changed");
	}
	for (const member of observedMembers) {
		if (
			(
				await ids(tx, "select id from membership where id = $1 for share", [
					member.id,
				])
			)[0] !== member.id
		)
			throw new Error("Task activation membership changed");
	}
	for (const id of listIds) {
		if (
			(
				await ids(tx, "select id from list where id = $1 for share", [id])
			)[0] !== id
		)
			throw new Error("Task activation list changed");
	}
	for (const id of initialIds) {
		if (
			(
				await ids(tx, "select id from task where id = $1 for update", [id])
			)[0] !== id
		)
			throw new Error("Task activation task changed");
	}
	if (options.includeChildren) {
		const children = await ids(
			tx,
			"select id from task where parent_id = any($1::text[]) order by id",
			[options.taskIds],
		);
		if (
			!same(initialIds, [...new Set([...options.taskIds, ...children])].sort())
		)
			throw new Error("Task activation children changed");
	}
	const lockedPairProbe = options.allowPending
		? null
		: await probe(
				tx,
				`select count(*)::text as count,
		coalesce(sum(octet_length(id)+octet_length(task_id)+octet_length(user_id)),0)::text as bytes
		from task_assignee where task_id = any($1::text[])`,
				[initialIds],
			);
	if (
		lockedPairProbe &&
		(lockedPairProbe.rows !== pairProbe?.rows ||
			lockedPairProbe.bytes !== pairProbe.bytes)
	)
		throw new Error("Task activation assignments changed");
	if (
		!same(observed, await taskSeats(tx, initialIds)) ||
		(!options.allowPending &&
			!same(
				observedPairs,
				await query(
					tx,
					"select task_id, user_id from task_assignee where task_id = any($1::text[]) order by task_id, user_id",
					[initialIds],
				),
			)) ||
		!same(observedMembers, await members(tx, userIds, workspaceIds)) ||
		!same(
			targetRows,
			targetLists.length
				? await query(
						tx,
						"select id, workspace_id, owner_id from list where id = any($1::text[]) order by id",
						[targetLists],
					)
				: [],
		)
	)
		throw new Error("Task activation authority changed");
	for (const workspaceId of workspaceIds) {
		const actorSeat = observedMembers.find(
			(member) =>
				member.userId === actorId && member.workspaceId === workspaceId,
		);
		if (
			!actorSeat ||
			(!options.allowViewer &&
				!["owner", "admin", "member"].includes(actorSeat.role))
		)
			throw new Error("access denied: need member+");
	}
	for (const seat of observed) {
		const rows = await query(
			tx,
			`select t.id as task_id, g.task_id as guard_task_id, g.status
			from task t left join task_notification_activation g on g.task_id = t.id
			where t.id = $1`,
			[seat.id],
		);
		if (rows.length !== 1 || rows[0].task_id !== seat.id)
			throw new Error("Task activation guard lookup failed");
		if (rows[0].guard_task_id !== null && rows[0].guard_task_id !== seat.id)
			throw new Error("Task activation guard mismatch");
		if (
			rows[0].guard_task_id !== null &&
			!["active", "pending", "blocked"].includes(rows[0].status as string)
		)
			throw new Error("Task activation guard invalid");
		if (
			!options.allowPending &&
			rows[0].guard_task_id !== null &&
			rows[0].status !== "active"
		)
			throw new Error("Task is waiting for import activation");
	}
	return { taskIds: initialIds, userIds, workspaceIds, evidence };
}

export async function reconcileZeroActiveRecipients(
	tx: ZeroTransaction,
	taskId: string,
	locked: ZeroTaskLock,
	forceGeneration = false,
): Promise<void> {
	if (tx.location !== "server") return;
	await reconcileActiveTaskRecipients(
		(sql, args) => tx.dbTransaction.query(sql, args),
		taskId,
		locked,
		forceGeneration,
	);
}

export async function clearExplicitDueSuppression(
	tx: ZeroTransaction,
	taskId: string,
	oldDueAt: number | null,
	newDueAt: number | null | undefined,
): Promise<void> {
	if (
		tx.location !== "server" ||
		newDueAt === undefined ||
		oldDueAt === newDueAt
	)
		return;
	await probe(
		tx,
		`select count(*)::text as count,
		coalesce(sum(octet_length(r::text)),0)::text as bytes
		from task_notification_recipient r where task_id = $1`,
		[taskId],
	);
	await query(
		tx,
		`update task_notification_recipient
		set overdue_suppressed_due_at = null, updated_at = now()
		where task_id = $1`,
		[taskId],
	);
}

export async function lockZeroPreferenceUser(
	tx: ZeroTransaction,
	actorId: string,
): Promise<void> {
	if (tx.location !== "server") return;
	await ensureUser(tx, actorId);
	const rows = await query(
		tx,
		'select id from "user" where id = $1 and deleted_at is null for update',
		[actorId],
	);
	if (rows.length !== 1 || rows[0].id !== actorId)
		throw new Error("User is no longer active");
}

export async function lockZeroContainerWrite(
	tx: ZeroTransaction,
	actorId: string,
	options: {
		listId?: string;
		folderId?: string;
		targetFolderId?: string | null;
		listPatch?: {
			title?: string;
			icon?: string | null;
			folderId?: string | null;
			completedDisplay?: string;
			sortKey?: string;
		};
		folderPatch?: { name?: string; sortKey?: string };
		allowPending?: boolean;
		deleteTasks?: boolean;
	},
): Promise<void> {
	if (tx.location !== "server") return;
	await ensureUser(tx, actorId);
	if ((options.listId === undefined) === (options.folderId === undefined))
		throw new Error("Exactly one activation container is required");
	const row =
		options.listId !== undefined
			? (
					await query(
						tx,
						"select id, workspace_id, folder_id from list where id = $1",
						[options.listId],
					)
				)[0]
			: (
					await query(tx, "select id, workspace_id from folder where id = $1", [
						options.folderId,
					])
				)[0];
	if (!row || row.id !== (options.listId ?? options.folderId))
		throw new Error("Activation container not found");
	const workspaceId = field(row, "workspace_id");
	const folderIds =
		options.listId !== undefined
			? [
					...new Set(
						[
							optionalField(row, "folder_id"),
							options.targetFolderId ?? null,
						].filter((id): id is string => id !== null),
					),
				].sort()
			: [options.folderId as string];
	await lockZeroPreferenceUser(tx, actorId);
	if (
		(
			await ids(tx, "select id from workspace where id = $1 for share", [
				workspaceId,
			])
		)[0] !== workspaceId
	)
		throw new Error("Activation workspace changed");
	const seat = await query(
		tx,
		"select id, role from membership where user_id = $1 and workspace_id = $2 for share",
		[actorId, workspaceId],
	);
	if (
		seat.length !== 1 ||
		!["owner", "admin", "member"].includes(seat[0].role as string)
	)
		throw new Error("access denied: need member+");
	for (const id of folderIds)
		if (
			(
				await ids(
					tx,
					`select id from folder where id = $1 and workspace_id = $2
			${id === options.folderId ? "for update" : "for share"}`,
					[id, workspaceId],
				)
			)[0] !== id
		)
			throw new Error("Activation folder changed");
	if (
		options.listId !== undefined &&
		(
			await ids(tx, "select id from list where id = $1 for update", [
				options.listId,
			])
		)[0] !== options.listId
	)
		throw new Error("Activation list changed");
	let changes = true;
	if (options.listId !== undefined) {
		const current = (
			await query(
				tx,
				"select id, workspace_id, folder_id, title, icon, completed_display, sort_key from list where id = $1",
				[options.listId],
			)
		)[0];
		if (
			!current ||
			current.workspace_id !== workspaceId ||
			current.folder_id !== row.folder_id
		)
			throw new Error("Activation list changed");
		if (options.listPatch) {
			const patch = options.listPatch;
			changes =
				(patch.title !== undefined && patch.title !== current.title) ||
				(patch.icon !== undefined && patch.icon !== current.icon) ||
				(patch.folderId !== undefined &&
					patch.folderId !== current.folder_id) ||
				(patch.completedDisplay !== undefined &&
					patch.completedDisplay !== current.completed_display) ||
				(patch.sortKey !== undefined && patch.sortKey !== current.sort_key);
		}
	} else if (options.folderPatch) {
		const current = (
			await query(tx, "select name, sort_key from folder where id = $1", [
				options.folderId,
			])
		)[0];
		if (!current) throw new Error("Activation folder changed");
		changes =
			(options.folderPatch.name !== undefined &&
				options.folderPatch.name !== current.name) ||
			(options.folderPatch.sortKey !== undefined &&
				options.folderPatch.sortKey !== current.sort_key);
	}
	if (options.folderId !== undefined && changes && !options.allowPending) {
		let cursor: string | null = null;
		while (true) {
			const page = await ids(
				tx,
				`select id from list where folder_id = $1 and ($2::text is null or id > $2)
				order by id limit 4096 for update`,
				[options.folderId, cursor],
			);
			if (page.length === 0) break;
			cursor = page[page.length - 1];
		}
	}
	if (options.deleteTasks) {
		if (options.listId === undefined)
			throw new Error("Task deletion requires a list");
		let cursor: string | null = null;
		while (true) {
			const page = await ids(
				tx,
				`select id from task
				where list_id = $1 and ($2::text is null or id > $2) order by id limit 256 for update`,
				[options.listId, cursor],
			);
			if (page.length === 0) break;
			cursor = page[page.length - 1];
		}
	}
	if (options.allowPending || !changes) return;
	const pending = await query(
		tx,
		`select t.id from task t
		join task_notification_activation g on g.task_id = t.id
		${options.folderId !== undefined ? "join list l on l.id = t.list_id" : ""}
		where ${options.folderId !== undefined ? "l.folder_id" : "t.list_id"} = $1
		and g.status in ('pending','blocked') limit 1`,
		[options.folderId ?? options.listId],
	);
	if (pending.length) throw new Error("List is waiting for import activation");
}

// Called only after lockZeroContainerWrite(deleteTasks), while every task row
// in the list remains locked. Pages keep deletion available above import limits.
export async function deleteZeroListTasks(
	tx: ZeroTransaction,
	listId: string,
): Promise<void> {
	if (tx.location !== "server") throw new Error("Server transaction required");
	for (const child of [true, false]) {
		let cursor: string | null = null;
		while (true) {
			const page = await ids(
				tx,
				`select id from task where list_id = $1
				and (parent_id is not null) = $2 and ($3::text is null or id > $3)
				order by id limit 256`,
				[listId, child, cursor],
			);
			if (page.length === 0) break;
			for (const id of page) await tx.mutate.task.delete({ id });
			cursor = page[page.length - 1];
		}
	}
}

export async function lockZeroTaskDeletion(
	tx: ZeroTransaction,
	actorId: string,
	taskId: string,
): Promise<void> {
	if (tx.location !== "server") return;
	await ensureUser(tx, actorId);
	const initial = (await taskSeats(tx, [taskId]))[0];
	if (!initial) throw new Error("task not found");
	await lockZeroPreferenceUser(tx, actorId);
	if (
		(
			await ids(tx, "select id from workspace where id = $1 for share", [
				initial.workspaceId,
			])
		)[0] !== initial.workspaceId
	)
		throw new Error("Task deletion workspace changed");
	const seat = await query(
		tx,
		"select id, role from membership where user_id = $1 and workspace_id = $2 for share",
		[actorId, initial.workspaceId],
	);
	if (
		seat.length !== 1 ||
		!["owner", "admin", "member"].includes(seat[0].role as string)
	)
		throw new Error("access denied: need member+");
	if (
		(
			await ids(tx, "select id from list where id = $1 for share", [
				initial.listId,
			])
		)[0] !== initial.listId
	)
		throw new Error("Task deletion list changed");
	let cursor: string | null = null;
	let sawParent = false;
	let lockedCount = 0;
	while (true) {
		const page = await ids(
			tx,
			`select id from task
			where (id = $1 or parent_id = $1) and ($2::text is null or id > $2)
			order by id limit 256 for update`,
			[taskId, cursor],
		);
		if (page.length === 0) break;
		lockedCount += page.length;
		if (page.includes(taskId)) sawParent = true;
		cursor = page[page.length - 1];
	}
	const currentCount = await query(
		tx,
		"select count(*)::int as count from task where id = $1 or parent_id = $1",
		[taskId],
	);
	if (
		!sawParent ||
		currentCount.length !== 1 ||
		currentCount[0].count !== lockedCount ||
		!same([initial], await taskSeats(tx, [taskId]))
	)
		throw new Error("Task deletion target changed");
}

export async function deleteZeroTaskChildren(
	tx: ZeroTransaction,
	taskId: string,
): Promise<void> {
	if (tx.location !== "server") throw new Error("Server transaction required");
	let cursor: string | null = null;
	while (true) {
		const page = await ids(
			tx,
			`select id from task where parent_id = $1
			and ($2::text is null or id > $2) order by id limit 256`,
			[taskId, cursor],
		);
		if (page.length === 0) break;
		for (const id of page) await tx.mutate.task.delete({ id });
		cursor = page[page.length - 1];
	}
}
