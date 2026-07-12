import { describe, expect, test, vi } from "vitest";
import { signInEmail } from "./email-sign-in.ts";

describe("signInEmail", () => {
	test("returns a two-factor challenge without treating it as a session", async () => {
		const request = vi.fn(async () =>
			Response.json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }),
		);
		await expect(
			signInEmail("a@test.invalid", "password", request),
		).resolves.toEqual({ kind: "two-factor" });
	});

	test("returns signed-in for a normal session response", async () => {
		const request = vi.fn(async () =>
			Response.json({ token: "token", user: { id: "user" } }),
		);
		await expect(
			signInEmail("a@test.invalid", "password", request),
		).resolves.toEqual({ kind: "signed-in" });
	});

	test("returns the server error message", async () => {
		const request = vi.fn(async () =>
			Response.json({ message: "Invalid credentials" }, { status: 401 }),
		);
		await expect(
			signInEmail("a@test.invalid", "bad", request),
		).resolves.toEqual({
			kind: "error",
			message: "Invalid credentials",
		});
	});
});
