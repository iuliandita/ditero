import type { ChannelErrorCode } from "./notification-retry.ts";

// Reported to the inviter alongside the created invite, so it is a wire
// contract both halves read: the server mail path produces it, the invite
// dialog renders it. Creation never fails on a mail problem -- the row and its
// link stay usable out-of-band, so rolling the invite back, or answering 5xx
// while it exists, would destroy something that works over something that did
// not.
export type InviteMailStatus =
	| { status: "sent" }
	// No address on the invite: a link/code invite was never going to be mailed.
	| { status: "skipped" }
	| { status: "smtp_disabled" }
	| { status: "no_public_url" }
	| { status: "invalid_address" }
	| { status: "failed"; retryable: boolean; category: ChannelErrorCode };

export type InviteRow = {
	status: "pending" | "accepted" | "revoked";
	expiresAt: number | null; // epoch ms
	maxUses: number | null;
	uses: number;
};

export type InviteState =
	| "valid"
	| "expired"
	| "exhausted"
	| "revoked"
	| "accepted";

// Precedence: terminal status (revoked/accepted) first, checked before
// expiry/uses; then expired; then exhausted; then valid. maxUses null means
// unlimited (link/code invites never exhaust).
export function inviteState(inv: InviteRow, now: number): InviteState {
	if (inv.status === "revoked") return "revoked";
	if (inv.status === "accepted") return "accepted";
	if (inv.expiresAt !== null && inv.expiresAt < now) return "expired";
	if (inv.maxUses !== null && inv.uses >= inv.maxUses) return "exhausted";
	return "valid";
}

export function canRedeem(inv: InviteRow, now: number): boolean {
	return inviteState(inv, now) === "valid";
}

export function newInviteToken(): string {
	return crypto.randomUUID();
}
