export type ActivationRow = Record<string, unknown>;
export type ActivationQuery = (
	sql: string,
	args: unknown[],
) => Promise<Iterable<ActivationRow>>;
export type ActivationAuthority = {
	userIds: string[];
	workspaceIds: string[];
	evidence: { rows: number; bytes: number };
};

const MAX_ROWS = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;

async function rows(
	query: ActivationQuery,
	sql: string,
	args: unknown[] = [],
): Promise<ActivationRow[]> {
	return Array.from(await query(sql, args));
}

function value(row: ActivationRow, key: string): string {
	const result = row[key];
	if (typeof result !== "string" || result === "")
		throw new Error(`Invalid task activation ${key}`);
	return result;
}

function instant(raw: unknown, key: string): Date {
	if (!(raw instanceof Date) || !Number.isFinite(raw.getTime()))
		throw new Error(`Invalid task activation ${key}`);
	return raw;
}

async function probe(
	query: ActivationQuery,
	sql: string,
	args: unknown[],
	budget: ActivationAuthority["evidence"],
	charge: boolean,
): Promise<number> {
	const result = await rows(query, sql, args);
	if (result.length !== 1)
		throw new Error("Task activation evidence probe failed");
	const count = Number(result[0].count);
	const bytes = Number(result[0].bytes);
	if (
		!Number.isSafeInteger(count) ||
		count < 0 ||
		!Number.isSafeInteger(bytes) ||
		bytes < 0 ||
		count > MAX_ROWS ||
		bytes > MAX_BYTES
	)
		throw new Error("Task activation evidence exceeds import limit");
	if (charge) {
		budget.rows += count;
		budget.bytes += bytes;
		if (budget.rows > MAX_ROWS || budget.bytes > MAX_BYTES)
			throw new Error("Task activation evidence exceeds import limit");
	}
	return count;
}

// Caller has already locked sorted users, workspace/memberships, list, and the
// task FOR UPDATE. No earlier authority ID may be acquired after entry.
export async function reconcileActiveTaskRecipients(
	query: ActivationQuery,
	taskId: string,
	locked: ActivationAuthority,
	forceGeneration = false,
): Promise<void> {
	const current = await rows(
		query,
		`select t.id, t.due_at, l.workspace_id, l.owner_id
		from task t join list l on l.id = t.list_id where t.id = $1`,
		[taskId],
	);
	if (current.length !== 1 || current[0].id !== taskId)
		throw new Error("Task activation task changed");
	const workspaceId = value(current[0], "workspace_id");
	const ownerId = value(current[0], "owner_id");
	if (!locked.workspaceIds.includes(workspaceId))
		throw new Error("Task activation workspace changed");
	const pairCount = await probe(
		query,
		`select count(*)::text as count,
		coalesce(sum(octet_length(id)+octet_length(user_id)+octet_length(task_id)),0)::text as bytes
		from task_assignee where task_id = $1`,
		[taskId],
		locked.evidence,
		false,
	);
	const pairRows = await rows(
		query,
		`select user_id from task_assignee
		where task_id = $1 order by user_id for share`,
		[taskId],
	);
	if (pairRows.length !== pairCount)
		throw new Error("Task activation assignments changed");
	const assignees = pairRows.map((row) => value(row, "user_id"));
	const guardRows = await rows(
		query,
		`select task_id, status, generation,
		import_occurrence_cutoff, recipient_generation_cutoff
		from task_notification_activation where task_id = $1 for update`,
		[taskId],
	);
	if (guardRows.length === 0) return;
	if (
		guardRows.length !== 1 ||
		guardRows[0].task_id !== taskId ||
		guardRows[0].status !== "active"
	)
		throw new Error("Task activation guard changed");
	const guard = guardRows[0];
	const effective = assignees.length ? assignees : [ownerId];
	for (const id of effective) {
		if (!locked.userIds.includes(id))
			throw new Error("Task activation recipient changed");
		const seats = await rows(
			query,
			`select m.id from membership m
			join "user" u on u.id = m.user_id and u.deleted_at is null
			where m.user_id = $1 and m.workspace_id = $2`,
			[id, workspaceId],
		);
		if (seats.length !== 1)
			throw new Error("Task activation recipient is not a live member");
	}
	const recipientCount = await probe(
		query,
		`select count(*)::text as count,
		coalesce(sum(octet_length(r::text)),0)::text as bytes
		from task_notification_recipient r where task_id = $1`,
		[taskId],
		locked.evidence,
		true,
	);
	const recipients = await rows(
		query,
		`select user_id, active, generation, cutoff,
		overdue_suppressed_due_at from task_notification_recipient
		where task_id = $1 order by user_id for update`,
		[taskId],
	);
	if (recipients.length !== recipientCount)
		throw new Error("Task activation recipient evidence changed");
	const currentSet = new Set(
		recipients
			.filter((row) => row.active === true)
			.map((row) => value(row, "user_id")),
	);
	const nextSet = new Set(effective);
	if (
		!forceGeneration &&
		currentSet.size === nextSet.size &&
		[...currentSet].every((id) => nextSet.has(id))
	)
		return;
	const oldGeneration = guard.generation;
	if (
		typeof oldGeneration !== "number" ||
		!Number.isSafeInteger(oldGeneration) ||
		oldGeneration < 1 ||
		!Number.isSafeInteger(oldGeneration + 1)
	)
		throw new Error("Invalid task activation generation");
	const nextGeneration = oldGeneration + 1;
	const clock = await rows(query, "select clock_timestamp() as now");
	const now = instant(clock[0]?.now, "clock");
	let cutoffMs = now.getTime();
	if (guard.import_occurrence_cutoff !== null)
		cutoffMs = Math.max(
			cutoffMs,
			instant(guard.import_occurrence_cutoff, "original cutoff").getTime(),
		);
	if (guard.recipient_generation_cutoff !== null)
		cutoffMs = Math.max(
			cutoffMs,
			instant(guard.recipient_generation_cutoff, "recipient cutoff").getTime(),
		);
	for (const row of recipients)
		if (row.cutoff !== null)
			cutoffMs = Math.max(
				cutoffMs,
				instant(row.cutoff, "recipient cutoff").getTime(),
			);
	const cutoff = new Date(cutoffMs);
	const prior = new Set(recipients.map((row) => value(row, "user_id")));
	for (const row of recipients) {
		const id = value(row, "user_id");
		if (nextSet.has(id)) {
			await rows(
				query,
				`update task_notification_recipient set active = true,
				generation = $3, cutoff = $4, updated_at = now()
				where task_id = $1 and user_id = $2`,
				[taskId, id, nextGeneration, cutoff],
			);
		} else if (row.active === true) {
			await rows(
				query,
				`update task_notification_recipient set active = false,
				updated_at = now() where task_id = $1 and user_id = $2`,
				[taskId, id],
			);
		}
	}
	const dueAt =
		current[0].due_at === null ? null : instant(current[0].due_at, "due date");
	for (const id of [...nextSet].sort()) {
		if (prior.has(id)) continue;
		const suppressed = dueAt && dueAt.getTime() < now.getTime() ? dueAt : null;
		await rows(
			query,
			`insert into task_notification_recipient
			(task_id, user_id, active, generation, cutoff, overdue_suppressed_due_at)
			values ($1, $2, true, $3, $4, $5)`,
			[taskId, id, nextGeneration, cutoff, suppressed],
		);
	}
	const changed = await rows(
		query,
		`update task_notification_activation
		set generation = $2, recipient_generation_cutoff = $3, updated_at = now()
		where task_id = $1 and status = 'active' and generation = $4
		returning task_id`,
		[taskId, nextGeneration, cutoff, oldGeneration],
	);
	if (changed.length !== 1 || changed[0].task_id !== taskId)
		throw new Error("Task activation generation changed");
}
