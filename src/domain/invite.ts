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
