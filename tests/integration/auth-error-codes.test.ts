import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";

// src/web/lib/auth-messages.ts localizes Better Auth failures by their machine
// code rather than their English prose. That only works while the server keeps
// emitting a `code` alongside `message`. These assertions pin the contract: if
// a Better Auth upgrade drops or renames a code, the mapper degrades silently
// back to English and nothing else in the suite would notice.

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

async function post(
	path: string,
	body: unknown,
	ip = "203.0.113.77",
	origin = "http://localhost:5173",
) {
	const response = await handleAuthRequest(
		new Request(`http://localhost:3000/api/auth${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin,
				"x-forwarded-for": ip,
			},
			body: JSON.stringify(body),
		}),
		ip,
	);
	return (await response.json()) as { code?: string; message?: string };
}

describe("Better Auth error codes", () => {
	beforeEach(async () => {
		await db.delete(tables.rateLimit);
	});

	test("a rejected sign-in names a stable code, not only prose", async () => {
		const body = await post("/sign-in/email", {
			email: "nobody@test.invalid",
			password: "wrong-password",
		});
		expect(body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
		expect(body.message).toBeTruthy();
	});

	// The row is inserted directly rather than registered: the suite runs in
	// bootstrap mode, so by this file every sign-up is refused by our own
	// `user.create.before` hook and the account would never exist. Better Auth
	// rejects a duplicate email before reaching that hook, which is the ordering
	// this assertion depends on.
	test("a duplicate email is refused by code, not only by prose", async () => {
		const email = "codes-integration@test.invalid";
		await db.delete(tables.user).where(eq(tables.user.email, email));
		await db.insert(tables.user).values({
			id: "codes-integration-user",
			name: "Codes",
			email,
		});

		const duplicate = await post("/sign-up/email", {
			name: "Codes",
			email,
			password: "pw-123456",
		});
		expect(duplicate.code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");

		await db.delete(tables.user).where(eq(tables.user.email, email));
	});

	// Password length is validated ahead of the create hook, so this one needs
	// no existing account and stays reachable with registration closed.
	test("a too-short password is refused by code", async () => {
		const short = await post("/sign-up/email", {
			name: "Codes",
			email: "codes-short@test.invalid",
			password: "x",
		});
		expect(short.code).toBe("PASSWORD_TOO_SHORT");
	});

	// #193: the two 403s an operator actually meets. Both were code-less, so the
	// form rendered one flat string for an invite-only instance working exactly
	// as configured and for a server that distrusts the address in the URL bar.
	test("the registration gate names itself, not just a 403", async () => {
		const email = "codes-gate@test.invalid";
		const seedEmail = "codes-gate-seed@test.invalid";
		await db.delete(tables.user).where(eq(tables.user.email, email));
		await db.delete(tables.user).where(eq(tables.user.email, seedEmail));
		// The gate only refuses once an account exists; bootstrap mode hands the
		// very first sign-up through.
		await db
			.insert(tables.user)
			.values({ id: "codes-gate-seed", name: "Seed", email: seedEmail });

		const refused = await post("/sign-up/email", {
			name: "Gate",
			email,
			password: "pw-123456",
		});
		expect(refused.code).toBe("REGISTRATION_INVITE_REQUIRED");
		expect(refused.message).toBe("Registration requires an invitation");

		await db.delete(tables.user).where(eq(tables.user.email, seedEmail));
	});

	// Better Auth's own rejection, pinned for the same reason as the codes
	// above: the mapper localizes it, and an upgrade that drops the code
	// silently returns the form to an unexplained failure.
	test("an untrusted origin answers INVALID_ORIGIN", async () => {
		const refused = await post(
			"/sign-in/email",
			{ email: "nobody@test.invalid", password: "wrong-password" },
			"203.0.113.78",
			"http://evil.test.invalid",
		);
		expect(refused.code).toBe("INVALID_ORIGIN");
	});

	// Not a BASE_ERROR_CODES entry -- it comes from the HTTP status -- but it is
	// what an unauthenticated passkey or 2FA call actually returns, so the map
	// has to carry it.
	test("an unauthenticated privileged call answers UNAUTHORIZED", async () => {
		expect((await post("/two-factor/enable", { password: "x" })).code).toBe(
			"UNAUTHORIZED",
		);
		expect((await post("/passkey/delete-passkey", { id: "x" })).code).toBe(
			"UNAUTHORIZED",
		);
	});
});
