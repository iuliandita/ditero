import { describe, expect, test } from "vitest";
import type { db } from "../db/client.ts";
import { emailHasRedeemableInvite } from "./invite-bypass.ts";

type Row = {
	status: "pending" | "accepted" | "revoked";
	expiresAt: Date | null;
	maxUses: number | null;
	uses: number;
};

// Stub the drizzle select chain: `.select(cols).from(t).where(cond)` awaits to rows.
function fakeDb(rows: Row[], onQuery?: () => void): typeof db {
	const chain = {
		from: () => ({
			where: async () => {
				onQuery?.();
				return rows;
			},
		}),
	};
	return { select: () => chain } as unknown as typeof db;
}

const NOW = 1_000_000;
const pending: Row = {
	status: "pending",
	expiresAt: null,
	maxUses: null,
	uses: 0,
};

describe("emailHasRedeemableInvite", () => {
	test.each([
		undefined,
		null,
		"",
	] as const)("returns false without querying for missing email (%p)", async (email) => {
		let queried = false;
		const result = await emailHasRedeemableInvite(
			email,
			fakeDb([pending], () => {
				queried = true;
			}),
			NOW,
		);
		expect(result).toBe(false);
		expect(queried).toBe(false);
	});

	test("true for a pending redeemable invite", async () => {
		expect(
			await emailHasRedeemableInvite("a@test.invalid", fakeDb([pending]), NOW),
		).toBe(true);
	});

	test("false for an expired invite", async () => {
		const expired: Row = { ...pending, expiresAt: new Date(NOW - 1) };
		expect(
			await emailHasRedeemableInvite("a@test.invalid", fakeDb([expired]), NOW),
		).toBe(false);
	});

	test("false for an exhausted invite", async () => {
		const exhausted: Row = { ...pending, maxUses: 1, uses: 1 };
		expect(
			await emailHasRedeemableInvite(
				"a@test.invalid",
				fakeDb([exhausted]),
				NOW,
			),
		).toBe(false);
	});

	test("false when no invite rows match", async () => {
		expect(
			await emailHasRedeemableInvite("a@test.invalid", fakeDb([]), NOW),
		).toBe(false);
	});
});
