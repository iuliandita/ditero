import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/client.ts";
import { invite, user, verification, workspace } from "../db/schema.ts";
import { canRedeem } from "../domain/invite.ts";
import { mailableAddress } from "../domain/mail-address.ts";
import {
	ackBaseUrl,
	takeRateToken,
} from "../server/notifications/capability.ts";
import type { InviteQuery } from "./invite-task-activation.ts";
import { sendAuthMail } from "./mail.ts";

export const INVITE_MAILBOX_TTL_MS = 15 * 60_000;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export class InviteMailboxError extends Error {
	constructor(
		reason:
			| "email_mismatch"
			| "email_verification_required" = "email_verification_required",
	) {
		super(reason);
	}
}

// Called under the account lock, before either path inserts membership.
export async function assertInviteMailbox(
	query: InviteQuery,
	userId: string,
	email: string | null | undefined,
): Promise<void> {
	if (email == null || !process.env.DITERO_SMTP_HOST?.trim()) return;
	const rows = await query(
		'select email, email_verified from "user" where id=$1 and deleted_at is null',
		[userId],
	);
	const account = rows[0];
	if (
		rows.length !== 1 ||
		typeof account.email !== "string" ||
		account.email.trim().toLowerCase() !== email.trim().toLowerCase()
	)
		throw new InviteMailboxError("email_mismatch");
	if (account.email_verified !== true) throw new InviteMailboxError();
}

// Every send request returns the same acknowledgement, including throttled sends.
// Existing unexpired links survive resend attempts, so the cooldown cannot revoke proof.
export async function sendInviteMailboxProof(
	token: string,
	userId: string,
	database: typeof defaultDb = defaultDb,
	now = Date.now(),
): Promise<void> {
	if (!process.env.DITERO_SMTP_HOST?.trim()) return;
	const base = ackBaseUrl(process.env);
	if (!base) {
		console.error("auth mail: invite verification needs a public URL");
		return;
	}
	const [row] = await database
		.select({
			id: invite.id,
			email: invite.email,
			status: invite.status,
			expiresAt: invite.expiresAt,
			maxUses: invite.maxUses,
			uses: invite.uses,
			claimedBy: invite.claimedBy,
			accountEmail: user.email,
			verified: user.emailVerified,
			name: user.name,
		})
		.from(invite)
		.innerJoin(workspace, eq(workspace.id, invite.workspaceId))
		.innerJoin(user, and(eq(user.id, userId), sql`${user.deletedAt} is null`))
		.where(and(eq(invite.token, token), eq(workspace.kind, "shared")))
		.limit(1);
	if (
		!row?.email ||
		row.claimedBy ||
		row.verified ||
		row.email.trim().toLowerCase() !== row.accountEmail.trim().toLowerCase() ||
		mailableAddress(row.email) === null ||
		!canRedeem({ ...row, expiresAt: row.expiresAt?.getTime() ?? null }, now)
	)
		return;
	const email = row.email.trim().toLowerCase();
	const identifier = `invite-mailbox:${hash(`${row.id}:${email}`)}`;
	if (!(await takeRateToken(database, identifier, 1, 1 / 60))) return;
	const proof = randomBytes(32).toString("base64url");
	await database.transaction(async (tx) => {
		await tx
			.delete(verification)
			.where(
				and(
					eq(verification.identifier, identifier),
					lte(verification.expiresAt, new Date(now)),
				),
			);
		await tx.insert(verification).values({
			id: `invite-proof:${hash(proof)}`,
			identifier,
			value: JSON.stringify({ userId, email }),
			expiresAt: new Date(now + INVITE_MAILBOX_TTL_MS),
		});
	});
	const link = new URL("/accept", base);
	link.hash = new URLSearchParams({ confirm: "email", proof }).toString();
	sendAuthMail("verify", { id: userId, email, name: row.name }, link.href, {
		database,
	});
}

export async function proveInviteMailbox(
	proof: string,
	userId: string,
	database: typeof defaultDb = defaultDb,
	now = Date.now(),
): Promise<boolean> {
	if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
	return database.transaction(async (tx) => {
		const [account] = await tx
			.select()
			.from(user)
			.where(eq(user.id, userId))
			.for("update");
		if (!account || account.deletedAt) return false;
		const [consumed] = await tx
			.delete(verification)
			.where(
				and(
					eq(verification.id, `invite-proof:${hash(proof)}`),
					gt(verification.expiresAt, new Date(now)),
					eq(
						verification.value,
						JSON.stringify({
							userId,
							email: account.email.trim().toLowerCase(),
						}),
					),
				),
			)
			.returning({ id: verification.id });
		if (!consumed) return false;
		await tx
			.update(user)
			.set({ emailVerified: true })
			.where(eq(user.id, userId));
		return true;
	});
}
