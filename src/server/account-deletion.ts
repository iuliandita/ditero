import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withUserContext } from "../db/user-context.ts";
import type { Guards } from "./guards.ts";
import {
	blockAccountActivation,
	discoverAccountActivationWorkspaces,
	lockAccountActivationRows,
} from "./portability/import-activation-account-deletion.ts";

type WorkspaceWarning = { id: string; name: string };

type DeletionPreview = {
	lastHolderWorkspaces: WorkspaceWarning[];
	soleOwnerWorkspaces: WorkspaceWarning[];
};

type AccountDeletionOptions = {
	now?: () => Date;
	deletedEmail?: () => string;
};

class AccountScopeChangedError extends Error {}

const deleteBody = z.object({
	acknowledgeKeyLoss: z.boolean(),
});

async function deletionPreview(
	client: PoolClient,
	userId: string,
): Promise<DeletionPreview> {
	const [lastHolder, soleOwner] = await Promise.all([
		client.query<WorkspaceWarning>(
			`select distinct w.id, w.name
			 from workspace w
			 join membership mine
			   on mine.workspace_id = w.id and mine.user_id = $1
			 join attachment a
			   on a.workspace_id = w.id and a.state = 'committed'
			 where w.kind = 'shared'
			   and exists (
			     select 1
			     from membership_key mk
			     join user_key uk
			       on uk.user_id = mine.user_id
			      and uk.public_key = mk.recipient_public_key
			      and uk.state = 'ready'
			      and uk.retired_at is null
			     where mk.membership_id = mine.id
			       and mk.key_version = a.key_version
			   )
			   and not exists (
			     select 1
			     from membership other
			     join membership_key mk on mk.membership_id = other.id
			     join user_key uk
			       on uk.user_id = other.user_id
			      and uk.public_key = mk.recipient_public_key
			      and uk.state = 'ready'
			      and uk.retired_at is null
			     join "user" holder on holder.id = other.user_id
			     where other.workspace_id = w.id
			       and other.user_id <> $1
			       and holder.deleted_at is null
			       and mk.key_version = a.key_version
			   )
			 order by w.name, w.id`,
			[userId],
		),
		client.query<WorkspaceWarning>(
			`select w.id, w.name
			 from workspace w
			 join membership mine
			   on mine.workspace_id = w.id
			  and mine.user_id = $1
			  and mine.role = 'owner'
			 where w.kind = 'shared'
			   and not exists (
			     select 1
			     from membership other
			     join "user" owner_user on owner_user.id = other.user_id
			     where other.workspace_id = w.id
			       and other.user_id <> $1
			       and other.role = 'owner'
			       and owner_user.deleted_at is null
			   )
			 order by w.name, w.id`,
			[userId],
		),
	]);
	return {
		lastHolderWorkspaces: lastHolder.rows,
		soleOwnerWorkspaces: soleOwner.rows,
	};
}

async function accountLockScope(client: PoolClient, userId: string) {
	const workspaces = await client.query<{ id: string }>(
		`select w.id from workspace w
		 where w.owner_id = $1
		    or exists (select 1 from membership m where m.workspace_id = w.id and m.user_id = $1)
		    or exists (select 1 from list l where l.workspace_id = w.id and l.owner_id = $1)
		 order by w.id`,
		[userId],
	);
	const activationWorkspaces = await discoverAccountActivationWorkspaces(
		client,
		userId,
	);
	const replacements = await client.query<{ user_id: string }>(
		`select distinct candidate.user_id from (
		   select m.user_id from workspace w join membership m on m.workspace_id = w.id
		   where w.kind = 'shared' and w.owner_id = $1
		     and m.role = 'owner' and m.user_id <> $1
		   union
		   select w.owner_id as user_id from list l join workspace w on w.id = l.workspace_id
		   where w.kind = 'shared' and l.owner_id = $1 and w.owner_id <> $1
		 ) candidate order by candidate.user_id`,
		[userId],
	);
	return {
		workspaceIds: [
			...new Set([
				...workspaces.rows.map((row) => row.id),
				...activationWorkspaces,
			]),
		].sort(),
		userIds: [
			...new Set([userId, ...replacements.rows.map((row) => row.user_id)]),
		].sort(),
	};
}

function sameIds(left: string[], right: string[]): boolean {
	return (
		left.length === right.length &&
		left.every((id, index) => id === right[index])
	);
}

async function lockAccountScope(
	client: PoolClient,
	userId: string,
): Promise<{ email: string; deletedAt: Date | null; workspaceIds: string[] }> {
	const discovered = await accountLockScope(client, userId);
	const users = await client.query<{
		id: string;
		email: string;
		deleted_at: Date | null;
	}>(
		`select id, email, deleted_at from "user"
		 where id = any($1::text[]) order by id for update`,
		[discovered.userIds],
	);
	if (users.rows.length !== discovered.userIds.length)
		throw new AccountScopeChangedError();
	const account = users.rows.find((row) => row.id === userId);
	if (!account) throw new Error("authenticated user row is missing");
	if (account.deleted_at)
		return {
			email: account.email,
			deletedAt: account.deleted_at,
			workspaceIds: [],
		};

	const workspaces = await client.query<{ id: string }>(
		`select id from workspace where id = any($1::text[])
		 order by id for update`,
		[discovered.workspaceIds],
	);
	if (
		!sameIds(
			workspaces.rows.map((row) => row.id),
			discovered.workspaceIds,
		)
	)
		throw new AccountScopeChangedError();
	await client.query(
		`select id from membership where workspace_id = any($1::text[])
		 order by id for update`,
		[discovered.workspaceIds],
	);
	await lockAccountActivationRows(client, userId, discovered.workspaceIds);
	const locked = await accountLockScope(client, userId);
	if (
		!sameIds(locked.workspaceIds, discovered.workspaceIds) ||
		!sameIds(locked.userIds, discovered.userIds)
	)
		throw new AccountScopeChangedError();
	return {
		email: account.email,
		deletedAt: account.deleted_at,
		workspaceIds: discovered.workspaceIds,
	};
}

async function removePersonalData(
	client: PoolClient,
	userId: string,
	now: Date,
): Promise<void> {
	await client.query(
		`update attachment a
		 set state = case
		       when a.state = 'committed' then 'deleting'::attachment_state
		       else 'aborted'::attachment_state
		     end,
		     deleted_at = $2,
		     reservation_expires_at = case
		       when a.state = 'committed' then a.reservation_expires_at
		       else $2
		     end
		 from workspace w
		 where w.id = a.workspace_id
		   and w.kind = 'personal'
		   and w.owner_id = $1
		   and a.state <> 'deleting'`,
		[userId, now],
	);
	await client.query(
		`delete from task
		 where parent_id is not null
		   and list_id in (
		     select l.id from list l join workspace w on w.id = l.workspace_id
		     where w.kind = 'personal' and w.owner_id = $1
		   )`,
		[userId],
	);
	await client.query(
		`delete from task
		 where list_id in (
		   select l.id from list l join workspace w on w.id = l.workspace_id
		   where w.kind = 'personal' and w.owner_id = $1
		 )`,
		[userId],
	);
	for (const table of [
		"list",
		"folder",
		"label",
		"template",
		"invite",
	] as const) {
		await client.query(
			`delete from ${table}
			 where workspace_id in (
			   select id from workspace
			   where kind = 'personal' and owner_id = $1
			 )`,
			[userId],
		);
	}
	await client.query(
		`delete from view where workspace_id in (
		   select id from workspace where kind = 'personal' and owner_id = $1
		 )`,
		[userId],
	);
	await client.query(
		`delete from dashboard where workspace_id in (
		   select id from workspace where kind = 'personal' and owner_id = $1
		 )`,
		[userId],
	);
	await client.query(
		`delete from workspace_key where workspace_id in (
		   select id from workspace where kind = 'personal' and owner_id = $1
		 )`,
		[userId],
	);
	await client.query(
		`update workspace set name = 'Deleted workspace'
		 where kind = 'personal' and owner_id = $1`,
		[userId],
	);
}

async function removeAccount(
	client: PoolClient,
	userId: string,
	workspaceIds: string[],
	originalEmail: string,
	now: Date,
	deletedEmail: string,
): Promise<void> {
	await blockAccountActivation(client, userId, workspaceIds);
	await removePersonalData(client, userId, now);

	await client.query(
		`update workspace w
		 set owner_id = (
		   select other.user_id from membership other
		   where other.workspace_id = w.id
		     and other.user_id <> $1
		     and other.role = 'owner'
		   order by other.user_id limit 1
		 )
		 where w.kind = 'shared' and w.owner_id = $1`,
		[userId],
	);
	await client.query(
		`update list l set owner_id = w.owner_id
		 from workspace w
		 where w.id = l.workspace_id
		   and w.kind = 'shared'
		   and l.owner_id = $1`,
		[userId],
	);
	await client.query(
		`update workspace w set rotation_required = true
		 where w.kind = 'shared'
		   and exists (
		     select 1 from membership m
		     where m.workspace_id = w.id and m.user_id = $1
		   )`,
		[userId],
	);

	await client.query("delete from key_grant_request where user_id = $1", [
		userId,
	]);
	await client.query("delete from membership_key where user_id = $1", [userId]);
	await client.query("delete from user_key where user_id = $1", [userId]);
	await client.query("delete from user_device where user_id = $1", [userId]);
	await client.query("delete from membership where user_id = $1", [userId]);

	await client.query(
		"delete from notification_outbox where recipient_user_id = $1",
		[userId],
	);
	await client.query(
		"delete from reminder_state where recipient_user_id = $1",
		[userId],
	);
	await client.query(
		"delete from ack_capability where recipient_user_id = $1",
		[userId],
	);
	for (const [table, column] of [
		["import_source", "owner_user_id"],
		["notification_channel", "user_id"],
		["task_assignee", "user_id"],
		["user_pref", "id"],
		["user_secret", "user_id"],
		["karma", "user_id"],
		["karma_event", "user_id"],
		["focus_session", "user_id"],
		["view", "owner_id"],
		["dashboard", "owner_id"],
		["managed_account", "user_id"],
		["session", "user_id"],
		["account", "user_id"],
		["passkey", "user_id"],
		["two_factor", "user_id"],
	] as const) {
		await client.query(`delete from ${table} where ${column} = $1`, [userId]);
	}
	await client.query("delete from invite where created_by = $1", [userId]);
	await client.query(
		"update invite set claimed_by = null where claimed_by = $1",
		[userId],
	);
	await client.query(
		"update task set fallback_user_id = null where fallback_user_id = $1",
		[userId],
	);
	await client.query("delete from verification where identifier = $1", [
		originalEmail,
	]);

	await client.query(
		`update "user"
		 set name = 'Deleted user', email = $2, email_verified = false,
		     image = null, two_factor_enabled = false,
		     deleted_at = $3::timestamptz, updated_at = $3::timestamptz
		 where id = $1`,
		[userId, deletedEmail, now],
	);
	await client.query(
		`delete from workspace
		 where kind = 'personal' and owner_id = $1
		   and not exists (
		     select 1 from attachment a where a.workspace_id = workspace.id
		   )`,
		[userId],
	);
}

export function accountDeletionRoutes(
	pool: Pool,
	guards: Guards,
	options: AccountDeletionOptions = {},
) {
	const now = options.now ?? (() => new Date());
	const deletedEmail =
		options.deletedEmail ?? (() => `deleted-${randomUUID()}@example.invalid`);

	return new Elysia()
		.get(
			"/api/account/deletion-preview",
			guards.guardedGet(async (_request, session) =>
				withUserContext(pool, session.user.id, (client) =>
					deletionPreview(client, session.user.id),
				),
			),
		)
		.post(
			"/api/account/delete",
			guards.guardedPost(async (request, session) => {
				let body: z.infer<typeof deleteBody>;
				try {
					body = deleteBody.parse(await request.json());
				} catch {
					return new Response("Bad Request", { status: 400 });
				}
				try {
					return await withUserContext(
						pool,
						session.user.id,
						async (client) => {
							const scope = await lockAccountScope(client, session.user.id);
							if (scope.deletedAt) return { deleted: true };
							const preview = await deletionPreview(client, session.user.id);
							if (preview.soleOwnerWorkspaces.length > 0) {
								return Response.json(
									{
										code: "ownership-transfer-required",
										soleOwnerWorkspaces: preview.soleOwnerWorkspaces,
									},
									{ status: 409 },
								);
							}
							if (
								preview.lastHolderWorkspaces.length > 0 &&
								!body.acknowledgeKeyLoss
							) {
								return Response.json(
									{
										code: "key-loss-ack-required",
										lastHolderWorkspaces: preview.lastHolderWorkspaces,
									},
									{ status: 409 },
								);
							}
							await removeAccount(
								client,
								session.user.id,
								scope.workspaceIds,
								scope.email,
								now(),
								deletedEmail(),
							);
							return { deleted: true };
						},
					);
				} catch (error) {
					if (error instanceof AccountScopeChangedError)
						return Response.json(
							{ code: "account-scope-changed" },
							{ status: 409 },
						);
					throw error;
				}
			}),
		);
}
