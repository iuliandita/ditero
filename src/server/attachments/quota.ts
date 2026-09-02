import type { PoolClient } from "pg";
import { quotaWouldExceed } from "../../domain/attachment.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";

export type AttachmentParentKind = "task" | "comment" | "list";

export type AttachmentContext = {
	workspaceId: string;
	parentKind: AttachmentParentKind;
	parentId: string;
	keyVersion: number;
};

export type AttachmentAccessFailure =
	| "not-permitted"
	| "rotation-required"
	| "key-unavailable"
	| "parent-mismatch";

type WorkspaceSeat = {
	rotation_required: boolean;
	membership_id: string;
	role: Role;
};

async function parentBelongsToWorkspace(
	client: PoolClient,
	context: AttachmentContext,
	lock: boolean,
): Promise<boolean> {
	const query =
		context.parentKind === "list"
			? "select 1 from list where id = $1 and workspace_id = $2"
			: context.parentKind === "task"
				? `select 1 from task t join list l on l.id = t.list_id
				   where t.id = $1 and l.workspace_id = $2`
				: `select 1 from comment c
				   join task t on t.id = c.task_id
				   join list l on l.id = t.list_id
				   where c.id = $1 and l.workspace_id = $2`;
	const result = await client.query(`${query}${lock ? " for key share" : ""}`, [
		context.parentId,
		context.workspaceId,
	]);
	return result.rowCount === 1;
}

export async function validateAttachmentWrite(
	client: PoolClient,
	userId: string,
	context: AttachmentContext,
	options: { lockWorkspace?: boolean; lockContext?: boolean } = {},
): Promise<AttachmentAccessFailure | null> {
	const lockContext = options.lockContext || options.lockWorkspace;
	const locked = options.lockWorkspace
		? " for update of w, m"
		: lockContext
			? " for key share of w, m"
			: "";
	const seats = await client.query<WorkspaceSeat>(
		`select w.rotation_required, m.id as membership_id, m.role
		 from workspace w
		 join membership m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1${locked}`,
		[context.workspaceId, userId],
	);
	const seat = seats.rows[0];
	if (!seat || !WRITE_ROLES.has(seat.role)) return "not-permitted";
	if (seat.rotation_required) return "rotation-required";

	const key = await client.query(
		`select 1 from workspace_key wk
		 join membership_key mk
		   on mk.workspace_id = wk.workspace_id
		  and mk.key_version = wk.version
		  and mk.membership_id = $2
		  and mk.user_id = $4
		 where wk.workspace_id = $1 and wk.version = $3 and wk.active
		 ${lockContext ? "for key share of wk, mk" : ""}`,
		[context.workspaceId, seat.membership_id, context.keyVersion, userId],
	);
	if (key.rowCount !== 1) return "key-unavailable";

	if (
		!(await parentBelongsToWorkspace(client, context, Boolean(lockContext)))
	) {
		return "parent-mismatch";
	}
	return null;
}

export async function hasAttachmentWriteRole(
	client: PoolClient,
	userId: string,
	workspaceId: string,
): Promise<boolean> {
	const membership = await client.query<{ role: Role }>(
		"select role from membership where workspace_id = $1 and user_id = $2",
		[workspaceId, userId],
	);
	const role = membership.rows[0]?.role;
	return role !== undefined && WRITE_ROLES.has(role);
}

export async function attachmentQuotaWouldExceed(
	client: PoolClient,
	workspaceId: string,
	incoming: number,
	limit: number,
): Promise<boolean> {
	const usage = await client.query<{
		committed: string;
		reserved: string;
	}>(
		`select
		 coalesce(sum(coalesce(observed_bytes, declared_bytes))
		   filter (where state = 'committed'), 0)::text
		   as committed,
		 coalesce(sum(declared_bytes) filter
		   (where state = any($2::attachment_state[])), 0)::text as reserved
		 from attachment where workspace_id = $1`,
		[workspaceId, ["reserved", "uploading"]],
	);
	const row = usage.rows[0];
	if (!row) throw new Error("attachment quota query returned no row");
	return quotaWouldExceed({
		committed: Number(row.committed),
		reserved: Number(row.reserved),
		incoming,
		limit,
	});
}
