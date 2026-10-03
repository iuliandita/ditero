import type { Pool, PoolClient } from "pg";

// Queries using this predicate bind the attachment row as a.
export const ATTACHMENT_PARENT_PRESENT_SQL = `case a.parent_kind
 when 'list' then exists(select 1 from list l where l.id=a.parent_id and l.workspace_id=a.workspace_id)
 when 'task' then exists(select 1 from task t join list l on l.id=t.list_id where t.id=a.parent_id and l.workspace_id=a.workspace_id)
 when 'comment' then exists(select 1 from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id where c.id=a.parent_id and l.workspace_id=a.workspace_id)
 else false end`;

// A live parent in another workspace needs attachment migration, not GC.
export const ATTACHMENT_PARENT_EXISTS_SQL = `case a.parent_kind
 when 'list' then exists(select 1 from list l where l.id=a.parent_id)
 when 'task' then exists(select 1 from task t join list l on l.id=t.list_id where t.id=a.parent_id)
 when 'comment' then exists(select 1 from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id where c.id=a.parent_id)
 else false end`;

export type AttachmentState =
	| "reserved"
	| "uploading"
	| "committed"
	| "aborted"
	| "deleting";

const TRANSITIONS: Readonly<
	Record<AttachmentState, ReadonlySet<AttachmentState>>
> = {
	reserved: new Set(["uploading", "aborted"]),
	uploading: new Set(["committed", "aborted"]),
	committed: new Set(["deleting"]),
	aborted: new Set(),
	deleting: new Set(),
};

export class AttachmentStateError extends Error {
	constructor(from: AttachmentState, to: AttachmentState) {
		super(`illegal attachment transition: ${from} -> ${to}`);
		this.name = "AttachmentStateError";
	}
}

export function assertAttachmentTransition(
	from: AttachmentState,
	to: AttachmentState,
): void {
	if (!TRANSITIONS[from].has(to)) throw new AttachmentStateError(from, to);
}

export async function expireAttachmentReservations(
	pool: Pick<Pool, "query"> | Pick<PoolClient, "query">,
	now: Date,
): Promise<number> {
	const expired = await pool.query(
		`update attachment set state = 'aborted'
		 where state = any($1::attachment_state[])
		   and reservation_expires_at <= $2`,
		[["reserved", "uploading"], now],
	);
	return expired.rowCount ?? 0;
}
