// Email-invite registration bypass. Only a non-null invite email that matches a
// pending, redeemable invite grants a bypass -- open link/code invites (email
// null) MUST NOT mint accounts in a closed/bootstrap instance.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { db } from "../db/client.ts";
import { invite, workspace } from "../db/schema.ts";
import { canRedeem } from "../domain/invite.ts";

type InviteQueryDb = Pick<typeof db, "select">;

export async function emailHasRedeemableInvite(
	email: string | null | undefined,
	database: InviteQueryDb,
	now: number,
	token?: string,
): Promise<boolean> {
	// Non-null email is load-bearing: an open (email-null) invite must never match.
	// The SQL equality below cannot match a null column, and this guard rejects an
	// empty/missing signup email before it reaches the query.
	if (!email) return false;
	const rows = await database
		.select({
			status: invite.status,
			expiresAt: invite.expiresAt,
			maxUses: invite.maxUses,
			uses: invite.uses,
		})
		.from(invite)
		.innerJoin(workspace, eq(invite.workspaceId, workspace.id))
		.where(
			and(
				sql`lower(${invite.email}) = ${email.toLowerCase()}`,
				eq(invite.status, "pending"),
				isNull(invite.claimedBy),
				...(token === undefined ? [] : [eq(invite.token, token)]),
				eq(workspace.kind, "shared"),
			),
		);
	return rows.some((row) =>
		canRedeem(
			{
				status: row.status,
				expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
				maxUses: row.maxUses,
				uses: row.uses,
			},
			now,
		),
	);
}

// Password registration requires the bearer as well as the intended address.
export async function emailHasTokenInvite(
	email: string,
	token: unknown,
	database: InviteQueryDb,
	now: number,
): Promise<boolean> {
	if (typeof token !== "string" || !token || token.length > 256) return false;
	return emailHasRedeemableInvite(
		email.trim().toLowerCase(),
		database,
		now,
		token,
	);
}
