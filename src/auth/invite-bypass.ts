// Email-invite registration bypass. Only a non-null invite email that matches a
// pending, redeemable invite grants a bypass -- open link/code invites (email
// null) MUST NOT mint accounts in a closed/bootstrap instance.
import { and, eq } from "drizzle-orm";
import type { db } from "../db/client.ts";
import { invite } from "../db/schema.ts";
import { canRedeem } from "../domain/invite.ts";

type InviteQueryDb = Pick<typeof db, "select">;

export async function emailHasRedeemableInvite(
	email: string | null | undefined,
	database: InviteQueryDb,
	now: number,
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
		.where(and(eq(invite.email, email), eq(invite.status, "pending")));
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
