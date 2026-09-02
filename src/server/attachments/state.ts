import type { Pool, PoolClient } from "pg";

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
