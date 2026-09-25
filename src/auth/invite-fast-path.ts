import type { Pool, PoolClient } from "pg";
import { withLiveUserContext, withUserContext } from "../db/user-context.ts";
import { inviteState } from "../domain/invite.ts";
import { activeRecipientKeyGuard } from "../server/e2e/identity-rotation.ts";
import {
	committedInviteAssignment,
	InviteTaskUnavailable,
	inviteQueryFromPg,
	lockInviteEvidence,
	lockInviteMembership,
	lockInviteTask,
	reconcileInviteAssignment,
} from "./invite-task-activation.ts";

export const FAST_INVITE_TTL_MS = 15 * 60_000;

export type FastInviteFailure =
	| "not_found"
	| "expired"
	| "exhausted"
	| "revoked"
	| "email_mismatch"
	| "not_fast_eligible"
	| "not_claimed"
	| "grant_pending"
	| "stale_recipient_key"
	| "conflict";

export class FastInviteError extends Error {
	constructor(public reason: FastInviteFailure) {
		super(reason);
		this.name = "FastInviteError";
	}
}

type StoredInvite = {
	id: string;
	workspace_id: string;
	role: "owner" | "admin" | "member" | "viewer";
	email: string | null;
	status: "pending" | "accepted" | "revoked";
	expires_at: Date | null;
	max_uses: number | null;
	uses: number;
	attach_task_id: string | null;
	attach_kind: "assign" | "mention" | null;
	created_at: Date;
	claimed_by: string | null;
	created_by: string;
};

export type FastInviteClaim = {
	inviteId: string;
	workspaceId: string;
	userId: string;
	intendedEmail: string;
	expiresAt: string;
	keyVersion: number;
	commitment: string;
	grantRequestId: string | null;
	grantState: "pending" | "ready";
};

function assertRedeemable(invite: StoredInvite, now: Date): void {
	const state = inviteState(
		{
			status: invite.status,
			expiresAt: invite.expires_at?.getTime() ?? null,
			maxUses: invite.max_uses,
			uses: invite.uses,
		},
		now.getTime(),
	);
	if (state !== "valid") {
		throw new FastInviteError(state === "accepted" ? "exhausted" : state);
	}
}

function assertTarget(invite: StoredInvite, userEmail: string): void {
	if (
		invite.email != null &&
		invite.email.toLowerCase() !== userEmail.toLowerCase()
	) {
		throw new FastInviteError("email_mismatch");
	}
}

function assertFastEligible(
	invite: StoredInvite,
): asserts invite is StoredInvite & {
	email: string;
	expires_at: Date;
} {
	if (
		invite.email == null ||
		invite.expires_at == null ||
		invite.max_uses !== 1 ||
		invite.expires_at.getTime() - invite.created_at.getTime() >
			FAST_INVITE_TTL_MS ||
		invite.expires_at.getTime() <= invite.created_at.getTime()
	) {
		throw new FastInviteError("not_fast_eligible");
	}
}

async function lockedInvite(
	client: PoolClient,
	token: string,
): Promise<StoredInvite> {
	const found = await client.query<StoredInvite>(
		`select id, workspace_id, role, email, status, expires_at, max_uses,
		        uses, attach_task_id, attach_kind, created_at, claimed_by, created_by
		 from invite where token = $1
		 and exists (select 1 from workspace w where w.id = invite.workspace_id and w.kind = 'shared')
		 for update`,
		[token],
	);
	const invite = found.rows[0];
	if (!invite) throw new FastInviteError("not_found");
	return invite;
}

async function discoveredInvite(
	client: PoolClient,
	token: string,
): Promise<StoredInvite> {
	const found = await client.query<StoredInvite>(
		`select id, workspace_id, role, email, status, expires_at, max_uses,
		 uses, attach_task_id, attach_kind, created_at, claimed_by, created_by
		 from invite where token = $1`,
		[token],
	);
	if (found.rows.length !== 1) throw new FastInviteError("not_found");
	return found.rows[0];
}

function sameAttachment(
	discovered: StoredInvite,
	locked: StoredInvite,
): boolean {
	return (
		discovered.id === locked.id &&
		discovered.workspace_id === locked.workspace_id &&
		discovered.attach_task_id === locked.attach_task_id &&
		discovered.attach_kind === locked.attach_kind &&
		discovered.role === locked.role &&
		discovered.created_by === locked.created_by
	);
}

async function liveUser(client: PoolClient, userId: string): Promise<void> {
	const rows = await client.query(
		'select id from "user" where id = $1 and deleted_at is null for key share',
		[userId],
	);
	if (rows.rowCount !== 1) throw new FastInviteError("not_found");
}

async function ensureActiveGrantRequest(
	client: PoolClient,
	userId: string,
	workspaceId: string,
): Promise<void> {
	await client.query(
		`insert into key_grant_request (id, membership_id, user_id, workspace_id,
		 requested_version)
		 select $1, m.id, $2, $3, wk.version
		 from membership m
		 join workspace_key wk on wk.workspace_id = $3 and wk.active
		 where m.workspace_id = $3 and m.user_id = $2
		   and not exists (
			select 1 from membership_key mk
			where mk.membership_id = m.id and mk.key_version = wk.version)
		 on conflict do nothing`,
		[`kgr_${crypto.randomUUID()}`, userId, workspaceId],
	);
}

export async function claimFastInvite(
	pool: Pool,
	token: string,
	userId: string,
	userEmail: string,
	now = new Date(),
): Promise<FastInviteClaim> {
	return await withUserContext(pool, userId, async (client) => {
		const observed = await discoveredInvite(client, token);
		const attachedAssign =
			observed.attach_task_id != null && observed.attach_kind === "assign";
		const completedObserved =
			observed.status === "accepted" &&
			observed.claimed_by === userId &&
			observed.uses === 1;
		let lockedTask: Awaited<ReturnType<typeof lockInviteTask>> | null = null;
		const query = inviteQueryFromPg(client);
		if (attachedAssign && !completedObserved) {
			try {
				lockedTask = await lockInviteTask(query, client, {
					taskId: observed.attach_task_id as string,
					workspaceId: observed.workspace_id,
					actorId: userId,
					inviteeId: userId,
					inviterId: observed.created_by,
					membershipRole: observed.role,
				});
				await lockInviteEvidence(query, lockedTask);
			} catch (error) {
				if (error instanceof InviteTaskUnavailable)
					throw new FastInviteError(
						error.reason === "pending" ? "conflict" : "not_found",
					);
				throw error;
			}
		} else if (completedObserved) {
			await liveUser(client, userId);
		} else {
			try {
				await lockInviteMembership(query, {
					workspaceId: observed.workspace_id,
					actorId: userId,
					inviterId: observed.created_by,
					role: observed.role,
					insert: true,
				});
			} catch (error) {
				if (error instanceof InviteTaskUnavailable)
					throw new FastInviteError("not_found");
				throw error;
			}
		}
		const invite = await lockedInvite(client, token);
		if (!sameAttachment(observed, invite))
			throw new FastInviteError("conflict");
		assertFastEligible(invite);
		const completedByCaller =
			invite.status === "accepted" &&
			invite.claimed_by === userId &&
			invite.uses === 1;
		const reservedByCaller =
			invite.status === "pending" &&
			invite.claimed_by === userId &&
			invite.uses < (invite.max_uses ?? 0);
		// Expiry closes the race for a new seat. It cannot close an existing
		// reservation: a reload after claim must be able to rebuild its fragment
		// grant or choose the durable asynchronous fallback.
		if (!completedByCaller && !reservedByCaller) {
			assertRedeemable(invite, now);
			assertTarget(invite, userEmail);
		}

		if (invite.claimed_by != null && invite.claimed_by !== userId) {
			throw new FastInviteError("exhausted");
		}
		if (completedByCaller && attachedAssign) {
			if (
				!(await committedInviteAssignment(
					query,
					invite.attach_task_id as string,
					invite.workspace_id,
					userId,
				))
			)
				throw new FastInviteError("conflict");
		} else if (completedByCaller) {
			// A completed reload only reads the previously committed grant state.
		} else if (attachedAssign && !lockedTask) {
			throw new FastInviteError("conflict");
		}
		if (!completedByCaller && invite.claimed_by == null) {
			const claimed = await client.query(
				`update invite set claimed_by = $2, claimed_at = $3
				 where id = $1 and claimed_by is null and status = 'pending'
				   and uses < max_uses and expires_at > $3`,
				[invite.id, userId, now],
			);
			if (claimed.rowCount !== 1) throw new FastInviteError("exhausted");
		}

		if (!completedByCaller) {
			await ensureActiveGrantRequest(client, userId, invite.workspace_id);
		}

		const context = await client.query<{
			version: number;
			commitment: string;
			request_id: string | null;
			membership_key_id: string | null;
		}>(
			`select wk.version, wk.commitment, r.id as request_id,
			        mk.id as membership_key_id
			 from membership m
			 join workspace_key wk
			   on wk.workspace_id = m.workspace_id and wk.active
			 left join membership_key mk
			   on mk.membership_id = m.id and mk.key_version = wk.version
			 left join key_grant_request r
			   on r.membership_id = m.id and r.requested_version = wk.version
			  and r.state in ('key_pending', 'ready')
			 where m.user_id = $1 and m.workspace_id = $2
			 order by wk.version desc, r.requested_at desc nulls last limit 1`,
			[userId, invite.workspace_id],
		);
		const row = context.rows[0];
		if (!row || (!row.membership_key_id && !row.request_id)) {
			throw new FastInviteError("not_fast_eligible");
		}

		return {
			inviteId: invite.id,
			workspaceId: invite.workspace_id,
			userId,
			intendedEmail: invite.email,
			expiresAt: invite.expires_at.toISOString(),
			keyVersion: row.version,
			commitment: row.commitment,
			grantRequestId: row.request_id,
			grantState: row.membership_key_id ? "ready" : "pending",
		};
	});
}

export type FastInviteGrantInput = {
	token: string;
	requestId: string;
	recipientPublicKey: string;
	enc: string;
	ciphertext: string;
};

export async function grantFastInvite(
	pool: Pool,
	userId: string,
	input: FastInviteGrantInput,
): Promise<"granted" | "already"> {
	return await withLiveUserContext(pool, userId, async (client) => {
		const found = await client.query<{
			membership_id: string;
			workspace_id: string;
			requested_version: number;
			public_key: string;
		}>(
			`select r.membership_id, r.workspace_id, r.requested_version,
			        uk.public_key
			 from invite i
			 join workspace w on w.id = i.workspace_id and w.kind = 'shared'
			 join key_grant_request r
			   on r.id = $2 and r.user_id = $3 and r.workspace_id = i.workspace_id
			  and r.state in ('key_pending', 'ready')
			 join workspace_key wk
			   on wk.workspace_id = r.workspace_id
			  and wk.version = r.requested_version and wk.active
			 join user_key uk
			   on uk.user_id = $3 and uk.retired_at is null and uk.state = 'ready'
			 where i.token = $1 and i.claimed_by = $3 and i.status = 'pending'
			`,
			[input.token, input.requestId, userId],
		);
		const request = found.rows[0];
		if (!request) throw new FastInviteError("not_found");
		if (request.public_key !== input.recipientPublicKey) {
			throw new FastInviteError("stale_recipient_key");
		}

		const existing = await client.query<{ enc: string; ciphertext: string }>(
			`select enc, ciphertext from membership_key
			 where membership_id = $1 and key_version = $2`,
			[request.membership_id, request.requested_version],
		);
		const prior = existing.rows[0];
		if (prior) {
			if (prior.enc !== input.enc || prior.ciphertext !== input.ciphertext) {
				throw new FastInviteError("conflict");
			}
			await markGrantReady(client, input.requestId);
			return "already";
		}

		const written = await client.query(
			`insert into membership_key (id, membership_id, user_id, workspace_id,
			 key_version, enc, ciphertext, recipient_public_key, granted_by)
			 select $1, $2, $3, $4, $5, $6, $7, $8, $3
			 where ${activeRecipientKeyGuard(3, 8)}
			 on conflict (membership_id, key_version) do nothing`,
			[
				`mk_${crypto.randomUUID()}`,
				request.membership_id,
				userId,
				request.workspace_id,
				request.requested_version,
				input.enc,
				input.ciphertext,
				input.recipientPublicKey,
			],
		);
		if (written.rowCount !== 1) throw new FastInviteError("conflict");
		await markGrantReady(client, input.requestId);
		return "granted";
	});
}

async function markGrantReady(
	client: PoolClient,
	requestId: string,
): Promise<void> {
	await client.query(
		`update key_grant_request set state = 'ready', granted_at = now()
		 where id = $1 and state = 'key_pending'`,
		[requestId],
	);
}

export async function finalizeFastInvite(
	pool: Pool,
	token: string,
	userId: string,
	mode: "fast" | "fallback",
	now = new Date(),
): Promise<{ workspaceId: string; grantRequestId: string | null }> {
	return await withUserContext(pool, userId, async (client) => {
		const observed = await discoveredInvite(client, token);
		const attachedAssign =
			observed.attach_task_id != null && observed.attach_kind === "assign";
		const completedObserved =
			observed.status === "accepted" &&
			observed.claimed_by === userId &&
			observed.uses === 1;
		const query = inviteQueryFromPg(client);
		let lockedTask: Awaited<ReturnType<typeof lockInviteTask>> | null = null;
		if (attachedAssign && !completedObserved) {
			try {
				lockedTask = await lockInviteTask(query, client, {
					taskId: observed.attach_task_id as string,
					workspaceId: observed.workspace_id,
					actorId: userId,
					inviteeId: userId,
					inviterId: observed.created_by,
				});
				await lockInviteEvidence(query, lockedTask);
			} catch (error) {
				if (error instanceof InviteTaskUnavailable)
					throw new FastInviteError(
						error.reason === "pending" ? "conflict" : "not_found",
					);
				throw error;
			}
		} else if (completedObserved) {
			await liveUser(client, userId);
		} else {
			try {
				await lockInviteMembership(query, {
					workspaceId: observed.workspace_id,
					actorId: userId,
					inviterId: observed.created_by,
					role: observed.role,
					insert: false,
				});
			} catch (error) {
				if (error instanceof InviteTaskUnavailable)
					throw new FastInviteError("not_found");
				throw error;
			}
		}
		const invite = await lockedInvite(client, token);
		if (!sameAttachment(observed, invite))
			throw new FastInviteError("conflict");
		if (
			invite.status === "accepted" &&
			invite.claimed_by === userId &&
			invite.uses === 1
		) {
			if (
				attachedAssign &&
				!(await committedInviteAssignment(
					query,
					invite.attach_task_id as string,
					invite.workspace_id,
					userId,
				))
			)
				throw new FastInviteError("conflict");
			return {
				workspaceId: invite.workspace_id,
				grantRequestId: await pendingRequestId(
					client,
					userId,
					invite.workspace_id,
				),
			};
		}
		if (invite.claimed_by !== userId) {
			assertRedeemable(invite, now);
			throw new FastInviteError("not_claimed");
		}
		// Expiry is enforced when claim reserves the seat. Once reserved, a slow
		// Argon2 derivation, suspended tab, or reload may finish later without
		// stranding the already-created membership and grant request. Revocation
		// and exhaustion remain terminal.
		if (invite.status === "revoked") throw new FastInviteError("revoked");
		if (
			invite.status !== "pending" ||
			(invite.max_uses != null && invite.uses >= invite.max_uses)
		) {
			throw new FastInviteError("exhausted");
		}

		if (mode === "fast") {
			const ready = await client.query(
				`select 1 from membership m
				 join workspace_key wk on wk.workspace_id = m.workspace_id and wk.active
				 join membership_key mk
				   on mk.membership_id = m.id and mk.key_version = wk.version
				 where m.user_id = $1 and m.workspace_id = $2`,
				[userId, invite.workspace_id],
			);
			if (ready.rowCount !== 1) throw new FastInviteError("grant_pending");
		}

		const consumed = await client.query(
			`update invite set uses = uses + 1,
			 status = case when max_uses is not null and uses + 1 >= max_uses
			               then 'accepted'::invite_status else status end
			 where id = $1 and claimed_by = $2 and status = 'pending'
			   and uses < max_uses`,
			[invite.id, userId],
		);
		if (consumed.rowCount !== 1) throw new FastInviteError("exhausted");

		if (lockedTask) {
			await client.query(
				`insert into task_assignee (id, task_id, user_id)
				 values ($1, $2, $3) on conflict do nothing`,
				[`${lockedTask.taskId}:${userId}`, lockedTask.taskId, userId],
			);
			await reconcileInviteAssignment(query, lockedTask);
		}
		return {
			workspaceId: invite.workspace_id,
			grantRequestId: await pendingRequestId(
				client,
				userId,
				invite.workspace_id,
			),
		};
	});
}

async function pendingRequestId(
	client: PoolClient,
	userId: string,
	workspaceId: string,
): Promise<string | null> {
	const found = await client.query<{ id: string }>(
		`select id from key_grant_request
		 where user_id = $1 and workspace_id = $2 and state = 'key_pending'
		 order by requested_at desc, id desc limit 1`,
		[userId, workspaceId],
	);
	return found.rows[0]?.id ?? null;
}
