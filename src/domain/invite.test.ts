import { describe, expect, test } from "vitest";
import { canRedeem, inviteState, newInviteToken } from "./invite.ts";

const NOW = 1_700_000_000_000;

const base = {
	status: "pending" as const,
	expiresAt: null as number | null,
	maxUses: null as number | null,
	uses: 0,
};

describe("inviteState", () => {
	test("pending, no expiry, uses < maxUses -> valid", () => {
		expect(inviteState({ ...base, maxUses: 5, uses: 1 }, NOW)).toBe("valid");
	});

	test("expiresAt in the past -> expired", () => {
		expect(inviteState({ ...base, expiresAt: NOW - 1 }, NOW)).toBe("expired");
	});

	test("expiresAt in the future -> valid", () => {
		expect(inviteState({ ...base, expiresAt: NOW + 1 }, NOW)).toBe("valid");
	});

	test("uses >= maxUses -> exhausted", () => {
		expect(inviteState({ ...base, maxUses: 3, uses: 3 }, NOW)).toBe(
			"exhausted",
		);
	});

	test("status revoked -> revoked", () => {
		expect(inviteState({ ...base, status: "revoked" }, NOW)).toBe("revoked");
	});

	test("status accepted (maxUses 1) -> accepted", () => {
		expect(
			inviteState({ ...base, status: "accepted", maxUses: 1, uses: 1 }, NOW),
		).toBe("accepted");
	});

	test("maxUses null (link/code) never exhausts, even with huge uses", () => {
		expect(inviteState({ ...base, maxUses: null, uses: 1_000_000 }, NOW)).toBe(
			"valid",
		);
	});

	// Precedence: terminal status (revoked/accepted) first, then expired, then
	// exhausted, then valid. Terminal status short-circuits regardless of
	// expiry/uses; among pending invites, an expired-and-exhausted invite
	// reports "expired" (expiry checked before exhaustion).
	test("revoked outranks expired and exhausted", () => {
		expect(
			inviteState(
				{ status: "revoked", expiresAt: NOW - 1, maxUses: 1, uses: 1 },
				NOW,
			),
		).toBe("revoked");
	});

	test("accepted outranks expired and exhausted", () => {
		expect(
			inviteState(
				{ status: "accepted", expiresAt: NOW - 1, maxUses: 1, uses: 1 },
				NOW,
			),
		).toBe("accepted");
	});

	test("both expired and exhausted -> expired (expiry checked first)", () => {
		expect(
			inviteState(
				{ status: "pending", expiresAt: NOW - 1, maxUses: 1, uses: 1 },
				NOW,
			),
		).toBe("expired");
	});
});

describe("canRedeem", () => {
	test("true when inviteState is valid", () => {
		expect(canRedeem({ ...base, maxUses: 5, uses: 1 }, NOW)).toBe(true);
	});

	test("false when expired", () => {
		expect(canRedeem({ ...base, expiresAt: NOW - 1 }, NOW)).toBe(false);
	});

	test("false when exhausted", () => {
		expect(canRedeem({ ...base, maxUses: 1, uses: 1 }, NOW)).toBe(false);
	});

	test("false when revoked", () => {
		expect(canRedeem({ ...base, status: "revoked" }, NOW)).toBe(false);
	});

	test("false when accepted", () => {
		expect(
			canRedeem({ ...base, status: "accepted", maxUses: 1, uses: 1 }, NOW),
		).toBe(false);
	});
});

describe("newInviteToken", () => {
	test("returns a uuid-shaped string", () => {
		const token = newInviteToken();
		expect(token).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	test("two calls differ", () => {
		expect(newInviteToken()).not.toBe(newInviteToken());
	});
});
