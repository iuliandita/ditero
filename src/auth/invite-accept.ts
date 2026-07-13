// Invite redemption. acceptInvite runs the whole redeem in ONE transaction so the
// membership grant, uses increment, and optional task attach commit atomically.
// previewInvite is the unauthenticated read the signup screen uses; it leaks only
// {valid, workspaceName, email} — never the token, role, ids, or attach details.
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db/client.ts";
import { invite, membership, taskAssignee, workspace } from "../db/schema.ts";
import { canRedeem, type InviteRow, inviteState } from "../domain/invite.ts";

export type AcceptFailure = "not_found" | "expired" | "exhausted" | "revoked";

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
	database: typeof defaultDb = defaultDb,
	now: number = Date.now(),
): Promise<{ workspaceId: string }> {
	return database.transaction(async (tx) => {
		const [inv] = await tx
			.select()
			.from(invite)
			.where(eq(invite.token, token))
			.limit(1);
		if (!inv) throw new InviteAcceptError("not_found", "invite not found");

		const state = inviteState(domainRow(inv), now);
		if (state !== "valid") {
			// 'accepted' means a bounded invite already hit maxUses -> exhausted.
			const reason: AcceptFailure = state === "accepted" ? "exhausted" : state;
			throw new InviteAcceptError(reason, `invite ${reason}`);
		}

		// Already-member is a no-op (unique userId+workspaceId), but we still resolve
		// the attach and the uses increment below.
		await tx
			.insert(membership)
			.values({
				id: crypto.randomUUID(),
				userId,
				workspaceId: inv.workspaceId,
				role: inv.role,
			})
			.onConflictDoNothing();

		const nextUses = inv.uses + 1;
		const reachedCap = inv.maxUses != null && nextUses >= inv.maxUses;
		await tx
			.update(invite)
			.set({ uses: nextUses, ...(reachedCap ? { status: "accepted" } : {}) })
			.where(eq(invite.id, inv.id));

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

		return { workspaceId: inv.workspaceId };
	});
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
