import type { PoolClient, QueryResult } from "pg";

const PAGE_SIZE = 1024;
const BLOCKED_REASON = "Account deletion changed notification relationships";

async function withAccountDeleteScope<T>(
	client: PoolClient,
	userId: string,
	callback: () => Promise<T>,
): Promise<T> {
	const before = await client.query<{
		user_id: string | null;
		scope: string | null;
	}>(
		`select current_setting('ditero.user_id',true) as user_id,
		current_setting('ditero.activation_scope',true) as scope`,
	);
	if (
		before.rows.length !== 1 ||
		before.rows[0].user_id !== userId ||
		(before.rows[0].scope ?? "") !== ""
	)
		throw new Error("Invalid account deletion activation context");
	const enabled = await client.query<{ scope: string }>(
		"select set_config('ditero.activation_scope','account-delete',true) as scope",
	);
	if (enabled.rows.length !== 1 || enabled.rows[0].scope !== "account-delete")
		throw new Error("Account deletion activation scope setup failed");
	const verified = await client.query<{ scope: string | null }>(
		"select current_setting('ditero.activation_scope',true) as scope",
	);
	if (verified.rows.length !== 1 || verified.rows[0].scope !== "account-delete")
		throw new Error("Account deletion activation scope requires a transaction");
	const result = await callback();
	const cleared = await client.query<{ scope: string }>(
		"select set_config('ditero.activation_scope','',true) as scope",
	);
	if (cleared.rows.length !== 1 || cleared.rows[0].scope !== "")
		throw new Error("Account deletion activation scope cleanup failed");
	const restored = await client.query<{ scope: string | null }>(
		"select current_setting('ditero.activation_scope',true) as scope",
	);
	if (restored.rows.length !== 1 || restored.rows[0].scope !== "")
		throw new Error("Account deletion activation scope cleanup failed");
	return result;
}

const EXPECTED_USER = `(
	g.expected_relationships->'assignees' @> jsonb_build_array(jsonb_build_object('userId',$1::text))
	or g.expected_relationships->'ownerFallback'->>'userId' = $1
	or g.expected_relationships->'escalationFallback'->>'userId' = $1
)`;

export async function discoverAccountActivationWorkspaces(
	client: PoolClient,
	userId: string,
): Promise<string[]> {
	return withAccountDeleteScope(client, userId, async () => {
		const result = await client.query<{ id: string }>(
			`select distinct affected.id from (
			  select l.workspace_id as id from list l where l.owner_id = $1
			  union
			  select l.workspace_id as id from task t
			    join list l on l.id = t.list_id where t.fallback_user_id = $1
			  union
			  select l.workspace_id as id from task_assignee p
			    join task t on t.id = p.task_id join list l on l.id = t.list_id
			    where p.user_id = $1
			  union
			  select l.workspace_id as id from task_notification_activation g
			    join task t on t.id = g.task_id join list l on l.id = t.list_id
			    where g.status in ('pending','blocked')
			    and (g.owning_owner_user_id = $1 or ${EXPECTED_USER})
			) affected order by affected.id`,
			[userId],
		);
		return result.rows.map((row) => row.id);
	});
}

async function lockPages(
	client: PoolClient,
	query: string,
	workspaceIds: string[],
): Promise<void> {
	let cursor: string | null = null;
	while (true) {
		const result: QueryResult<{ id: string }> = await client.query(query, [
			workspaceIds,
			cursor,
			PAGE_SIZE,
		]);
		if (result.rows.length === 0) return;
		cursor = result.rows[result.rows.length - 1].id;
	}
}

// Caller has locked deleting/replacement users, workspaces and memberships.
// Workspace FOR UPDATE fences new lists; list FOR UPDATE fences new tasks;
// task FOR UPDATE fences new pairs, guards and recipient FK inserts.
export async function lockAccountActivationRows(
	client: PoolClient,
	userId: string,
	workspaceIds: string[],
): Promise<void> {
	if (workspaceIds.length === 0) return;
	await withAccountDeleteScope(client, userId, async () => {
		await lockPages(
			client,
			`select id from list where workspace_id = any($1::text[])
			and ($2::text is null or id > $2) order by id limit $3 for update`,
			workspaceIds,
		);
		await lockPages(
			client,
			`select t.id from task t join list l on l.id = t.list_id
			where l.workspace_id = any($1::text[])
			and ($2::text is null or t.id > $2)
			order by t.id limit $3 for update of t`,
			workspaceIds,
		);
		await lockPages(
			client,
			`select p.id from task_assignee p
			join task t on t.id = p.task_id join list l on l.id = t.list_id
			where l.workspace_id = any($1::text[])
			and ($2::text is null or p.id > $2)
			order by p.id limit $3 for update of p`,
			workspaceIds,
		);
		await lockPages(
			client,
			`select g.task_id as id from task_notification_activation g
			join task t on t.id = g.task_id join list l on l.id = t.list_id
			where l.workspace_id = any($1::text[])
			and ($2::text is null or g.task_id > $2)
			order by g.task_id limit $3 for update of g`,
			workspaceIds,
		);
		let taskId: string | null = null;
		let recipientId: string | null = null;
		while (true) {
			const result: QueryResult<{
				task_id: string;
				user_id: string;
			}> = await client.query(
				`select r.task_id, r.user_id from task_notification_recipient r
				join task t on t.id = r.task_id join list l on l.id = t.list_id
				where l.workspace_id = any($1::text[])
				and ($2::text is null or (r.task_id,r.user_id) > ($2,$3))
				order by r.task_id,r.user_id limit $4 for update of r`,
				[workspaceIds, taskId, recipientId, PAGE_SIZE],
			);
			if (result.rows.length === 0) break;
			const last: { task_id: string; user_id: string } =
				result.rows[result.rows.length - 1];
			taskId = last.task_id;
			recipientId = last.user_id;
		}
	});
}

export async function blockAccountActivation(
	client: PoolClient,
	userId: string,
	workspaceIds: string[],
): Promise<void> {
	if (workspaceIds.length === 0) return;
	await withAccountDeleteScope(client, userId, async () => {
		let cursor: string | null = null;
		while (true) {
			const result: QueryResult<{ id: string }> = await client.query(
				`select t.id from task t join list l on l.id = t.list_id
				join workspace w on w.id = l.workspace_id
				join task_notification_activation g on g.task_id = t.id
				where w.kind = 'shared' and w.id = any($1::text[])
				and ($2::text is null or t.id > $2) and (
				  l.owner_id = $3 or t.fallback_user_id = $3
				  or exists (select 1 from task_assignee p
				    where p.task_id = t.id and p.user_id = $3)
				  or (g.status in ('pending','blocked') and (
				    g.owning_owner_user_id = $3
				    or g.expected_relationships->'assignees' @> jsonb_build_array(jsonb_build_object('userId',$3::text))
				    or g.expected_relationships->'ownerFallback'->>'userId' = $3
				    or g.expected_relationships->'escalationFallback'->>'userId' = $3
				  ))
				)
				order by t.id limit $4`,
				[workspaceIds, cursor, userId, PAGE_SIZE],
			);
			if (result.rows.length === 0) break;
			const ids: string[] = result.rows.map((row) => row.id);
			await client.query(
				`update task_notification_activation
				set status = 'blocked', completion_mode = null,
				blocked_reason = $2, updated_at = now()
				where task_id = any($1::text[]) and status in ('active','pending')`,
				[ids, BLOCKED_REASON],
			);
			await client.query(
				`update task_notification_recipient
				set active = false, updated_at = now()
				where task_id = any($1::text[]) and active`,
				[ids],
			);
			cursor = ids[ids.length - 1];
		}
	});
}
