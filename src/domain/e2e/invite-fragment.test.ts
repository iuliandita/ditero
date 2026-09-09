import { describe, expect, it } from "vitest";
import { KEY_BYTES } from "./envelope.ts";
import { openInviteFragment, sealInviteFragment } from "./invite-fragment.ts";

const ctx = {
	inviteId: "inv_1",
	workspaceId: "ws_1",
	keyVersion: 1,
	intendedEmail: "a@example.com",
	expiresAt: "2026-09-01T00:00:00.000Z",
};

const beforeExpiry = new Date("2026-08-31T23:59:59.000Z");

describe("invite fragment", () => {
	it("round-trips a WDK", async () => {
		const wdk = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
		const { fragment, payload } = await sealInviteFragment(wdk, ctx);
		expect(
			await openInviteFragment(fragment, payload, ctx, beforeExpiry),
		).toEqual(wdk);
	});

	it.each([
		["invite", { inviteId: "inv_2" }],
		["workspace", { workspaceId: "ws_2" }],
		["key version", { keyVersion: 2 }],
		["intended identity", { intendedEmail: "b@example.com" }],
	])("refuses a fragment moved to another %s", async (_name, replacement) => {
		const { fragment, payload } = await sealInviteFragment(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
			ctx,
		);
		await expect(
			openInviteFragment(
				fragment,
				payload,
				{ ...ctx, ...replacement },
				beforeExpiry,
			),
		).rejects.toThrow();
	});

	it("normalizes the intended email before binding it", async () => {
		const { fragment, payload } = await sealInviteFragment(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
			{ ...ctx, intendedEmail: "A@Example.COM" },
		);
		expect(
			await openInviteFragment(fragment, payload, ctx, beforeExpiry),
		).toHaveLength(KEY_BYTES);
	});

	it("refuses a fragment replayed after expiry", async () => {
		const { fragment, payload } = await sealInviteFragment(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
			ctx,
		);
		await expect(
			openInviteFragment(
				fragment,
				payload,
				ctx,
				new Date("2026-09-01T00:00:00.000Z"),
			),
		).rejects.toThrow("Invite fragment has expired");
	});

	it("refuses a wrong secret", async () => {
		const { payload } = await sealInviteFragment(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
			ctx,
		);
		const other = await sealInviteFragment(
			crypto.getRandomValues(new Uint8Array(KEY_BYTES)),
			ctx,
		);
		await expect(
			openInviteFragment(other.fragment, payload, ctx, beforeExpiry),
		).rejects.toThrow();
	});

	it.each([
		0,
		1.5,
		Number.NaN,
	])("refuses key version %s", async (keyVersion) => {
		await expect(
			sealInviteFragment(crypto.getRandomValues(new Uint8Array(KEY_BYTES)), {
				...ctx,
				keyVersion,
			}),
		).rejects.toThrow("keyVersion must be a positive integer");
	});

	it("refuses an invalid expiry", async () => {
		await expect(
			sealInviteFragment(crypto.getRandomValues(new Uint8Array(KEY_BYTES)), {
				...ctx,
				expiresAt: "not-a-date",
			}),
		).rejects.toThrow("expiresAt must be an ISO instant");
	});

	it("refuses a non-WDK payload", async () => {
		await expect(
			sealInviteFragment(new Uint8Array(KEY_BYTES - 1), ctx),
		).rejects.toThrow(`WDK must be ${KEY_BYTES} bytes`);
	});
});
