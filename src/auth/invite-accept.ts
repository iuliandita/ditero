// Invite redemption. acceptInvite runs the whole redeem in ONE transaction so the
// membership grant, uses increment, and optional task attach commit atomically.
// previewInvite is the unauthenticated read the signup screen uses; it leaks only
// {valid, workspaceName, email} — never the token, role, ids, or attach details.
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.ts";
import { invite, membership, taskAssignee, workspace } from "../db/schema.ts";
import { canRedeem, type InviteRow, inviteState } from "../domain/invite.ts";

export type AcceptFailure =
	| "not_found"
	| "expired"
	| "exhausted"
	| "revoked"
	| "email_mismatch";

export class InviteAcceptError extends Error {
	constructor(
		public reason: AcceptFailure,
		message: string,
	) {
		super(message);
		this.name = "InviteAcceptError";
	}
}

function domainRow(inv: {
	status: "pending" | "accepted" | "revoked";
	expiresAt: Date | null;
	maxUses: number | null;
	uses: number;
}): InviteRow {
	return {
		status: inv.status,
		expiresAt: inv.expiresAt ? inv.expiresAt.getTime() : null,
		maxUses: inv.maxUses,
		uses: inv.uses,
	};
}

export async function acceptInvite(
	token: string,
	userId: string,
	userEmail: string,
	database: typeof defaultDb = defaultDb,
	now: number = Date.now(),
): Promise<{ workspaceId: string; grantRequestId: string | null }> {
	return database.transaction(async (tx) => {
		const [inv] = await tx
			.select()
			.from(invite)
			.where(eq(invite.token, token))
			.limit(1);
		if (!inv) throw new InviteAcceptError("not_found", "invite not found");

		// Friendly, distinct pre-check (revoked/accepted/expired/exhausted) BEFORE any
		// write; the authoritative guard is the conditional UPDATE below.
		const state = inviteState(domainRow(inv), now);
		if (state !== "valid") {
			// 'accepted' means a bounded invite already hit maxUses -> exhausted.
			const reason: AcceptFailure = state === "accepted" ? "exhausted" : state;
			throw new InviteAcceptError(reason, `invite ${reason}`);
		}

		// Email-targeted invites bind to the invitee's address: a leaked email-invite
		// link cannot grant its role to a different account. Open (email-null) invites
		// stay redeemable by anyone holding the link.
		if (
			inv.email != null &&
			userEmail.toLowerCase() !== inv.email.toLowerCase()
		) {
			throw new InviteAcceptError(
				"email_mismatch",
				"this invite is for a different email",
			);
		}
		// A fragment flow reserves its single-use seat before it enrolls and stores
		// the WDK grant. Only /finalize may consume that reservation; letting this
		// legacy endpoint race it would recreate the exact membership-without-key
		// window the fast path closes.
		if (inv.claimedBy != null) {
			throw new InviteAcceptError("exhausted", "invite already claimed");
		}

		// Authoritative + atomic claim: one conditional UPDATE increments uses and
		// flips to 'accepted' at the cap. The WHERE re-checks status/uses/expiry, so
		// two concurrent redemptions of a maxUses=1 invite cannot both win -- the loser
		// matches 0 rows. Membership + attach run only after the claim succeeds.
		const claimed = await tx
			.update(invite)
			.set({
				uses: sql`${invite.uses} + 1`,
				status: sql`CASE WHEN ${invite.maxUses} IS NOT NULL AND ${invite.uses} + 1 >= ${invite.maxUses} THEN 'accepted' ELSE ${invite.status} END`,
			})
			.where(
				and(
					eq(invite.id, inv.id),
					eq(invite.status, "pending"),
					isNull(invite.claimedBy),
					or(isNull(invite.maxUses), lt(invite.uses, invite.maxUses)),
					or(isNull(invite.expiresAt), gt(invite.expiresAt, new Date(now))),
				),
			)
			.returning({ id: invite.id });
		if (claimed.length === 0) {
			// Lost the race, or concurrently revoked/expired/exhausted between the
			// pre-check and here. Treat as exhausted; do NOT grant membership/attach.
			throw new InviteAcceptError("exhausted", "invite exhausted");
		}

		// Already-member is a no-op (unique userId+workspaceId).
		await tx
			.insert(membership)
			.values({
				id: crypto.randomUUID(),
				userId,
				workspaceId: inv.workspaceId,
				role: inv.role,
			})
			.onConflictDoNothing();

		// 'assign' attaches a task_assignee row; 'mention' resolves to membership only.
		if (inv.attachTaskId != null && inv.attachKind === "assign") {
			await tx
				.insert(taskAssignee)
				.values({
					id: `${inv.attachTaskId}:${userId}`,
					taskId: inv.attachTaskId,
					userId,
				})
				.onConflictDoNothing();
		}

		// M-E2E Task 15. Same transaction as the membership, so the two cannot
		// disagree: killing the transaction leaves neither. Membership itself is
		// NEVER gated on this -- an absent or failed request costs the newcomer
		// encrypted attachments and nothing else (design 8.1).
		//
		// ditero.user_id is set explicitly because key_grant_request carries
		// FORCE RLS and this path does not run through withUserContext. The
		// runtime role cannot bypass RLS, so without it the insert writes
		// nothing here while passing in tests, whose connection is a superuser.
		await tx.execute(sql`select set_config('ditero.user_id', ${userId}, true)`);
		const grantRequestId = await requestActiveKeyDrizzle(
			tx,
			userId,
			inv.workspaceId,
		);

		// Returned rather than notified from in here: the outbox write must land
		// AFTER this transaction commits, or a rolled-back acceptance announces a
		// grant nobody is waiting for. Same boundary events.ts settled on, and
		// the same trade -- a crash between commit and enqueue loses a
		// notification, which is recoverable in a way a phantom one is not.
		return { workspaceId: inv.workspaceId, grantRequestId };
	});
}

/**
 * Lives here rather than in `grants.ts` because this is the only caller and it
 * is the only path in the subsystem that is not already inside
 * `withUserContext` -- everything else there takes a raw PoolClient, which this
 * transaction has none of.
 *
 * Writes nothing when the workspace has no active key yet or the member already
 * holds one. An absent request means there is nothing to wait for, not a
 * failure: membership is never gated on key availability.
 */
async function requestActiveKeyDrizzle(
	tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
	userId: string,
	workspaceId: string,
): Promise<string | null> {
	const id = `kgr_${crypto.randomUUID()}`;
	const created = (await tx.execute(sql`
		insert into key_grant_request (id, membership_id, user_id, workspace_id,
		 requested_version)
		select ${id}, m.id, ${userId}, ${workspaceId}, wk.version
		from membership m
		join workspace_key wk on wk.workspace_id = ${workspaceId} and wk.active
		where m.workspace_id = ${workspaceId} and m.user_id = ${userId}
		  and not exists (
			select 1 from membership_key mk
			where mk.membership_id = m.id and mk.key_version = wk.version)
		on conflict do nothing
		returning id`)) as { rows?: unknown[] };
	return created.rows?.length ? id : null;
}

export type InvitePreview = {
	valid: boolean;
	workspaceName?: string;
	email?: string | null;
};

export async function previewInvite(
	token: string,
	database: typeof defaultDb = defaultDb,
	now: number = Date.now(),
): Promise<InvitePreview> {
	const [row] = await database
		.select({
			status: invite.status,
			expiresAt: invite.expiresAt,
			maxUses: invite.maxUses,
			uses: invite.uses,
			email: invite.email,
			workspaceName: workspace.name,
		})
		.from(invite)
		.innerJoin(workspace, eq(invite.workspaceId, workspace.id))
		.where(eq(invite.token, token))
		.limit(1);
	if (!row || !canRedeem(domainRow(row), now)) return { valid: false };
	return { valid: true, workspaceName: row.workspaceName, email: row.email };
}
