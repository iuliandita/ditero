import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";
import { app } from "../../src/server/index.ts";

// M-E2E Task 8. Enrollment is the one write that establishes an identity, so
// the property that matters is immutability: a second enroll with a different
// public key is a conflict, never an overwrite. Replacing an identity is
// identity rotation (Task 13), which has its own preconditions.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

const ORIGIN = "http://localhost:5173";

// 32 bytes base64url, unpadded: the wire form of an X25519 public key.
const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");

const WRAPPED = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";

function body(publicKey: string, over?: Record<string, unknown>) {
	return JSON.stringify({
		publicKey,
		passphraseWrapped: WRAPPED,
		recoveryWrapped: WRAPPED,
		passphraseSalt: SALT,
		recoverySalt: SALT,
		...over,
	});
}

async function signUp(email: string): Promise<string> {
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ name: "Enroll", email, password: "pw-123456" }),
		}),
	);
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

function enroll(payload: string, init: { cookie?: string; origin?: string }) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		origin: init.origin ?? ORIGIN,
	};
	if (init.cookie) headers.cookie = init.cookie;
	return app.handle(
		new Request("http://localhost:3000/api/e2e/enroll", {
			method: "POST",
			headers,
			body: payload,
		}),
	);
}

let cookie: string;
let seq = 0;

beforeEach(async () => {
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	// Signup is rate-limited per IP and this file signs up once per test.
	await db.delete(tables.rateLimit);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
	seq += 1;
	cookie = await signUp(`enroll-${Date.now()}-${seq}@test.invalid`);
	process.env.DITERO_E2E_ENABLED = "true";
});

afterAll(async () => {
	process.env.DITERO_E2E_ENABLED = undefined;
	await pool.end();
});

async function storedKeys(): Promise<{ publicKey: string; state: string }[]> {
	const rows = await pool.query<{ public_key: string; state: string }>(
		"select public_key, state from user_key",
	);
	return rows.rows.map((r) => ({ publicKey: r.public_key, state: r.state }));
}

describe("POST /api/e2e/enroll", () => {
	test("creates one ready identity", async () => {
		const response = await enroll(body(KEY_A), { cookie });
		expect(response.status).toBe(200);
		expect(await storedKeys()).toEqual([{ publicKey: KEY_A, state: "ready" }]);
	});

	test("is idempotent for the same public key", async () => {
		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);
		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);
		expect(await storedKeys()).toEqual([{ publicKey: KEY_A, state: "ready" }]);
	});

	test("refuses a different public key with 409 and does not overwrite", async () => {
		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);
		const response = await enroll(body(KEY_B), { cookie });
		expect(response.status).toBe(409);
		expect(await storedKeys()).toEqual([{ publicKey: KEY_A, state: "ready" }]);
	});

	test("requires a session", async () => {
		const response = await enroll(body(KEY_A), {});
		expect(response.status).toBe(401);
		expect(await storedKeys()).toEqual([]);
	});

	test("refuses a foreign origin", async () => {
		const response = await enroll(body(KEY_A), {
			cookie,
			origin: "https://evil.test",
		});
		expect(response.status).toBe(403);
		expect(await storedKeys()).toEqual([]);
	});

	test("refuses a public key that is not 32 bytes", async () => {
		for (const bad of [
			Buffer.alloc(31, 1).toString("base64url"),
			Buffer.alloc(33, 1).toString("base64url"),
			"not base64url!!",
			"",
		]) {
			const response = await enroll(body(bad), { cookie });
			expect(response.status, `publicKey ${JSON.stringify(bad)}`).toBe(400);
		}
		expect(await storedKeys()).toEqual([]);
	});

	test("refuses a wrapped blob over the input cap", async () => {
		const huge = "A".repeat(64 * 1024 + 1);
		for (const field of ["passphraseWrapped", "recoveryWrapped"]) {
			const response = await enroll(body(KEY_A, { [field]: huge }), { cookie });
			expect(response.status, field).toBe(400);
		}
		expect(await storedKeys()).toEqual([]);
	});

	test("never echoes a wrapped blob", async () => {
		const response = await enroll(body(KEY_A), { cookie });
		const text = await response.text();
		expect(text).not.toContain(WRAPPED);
		expect(text).not.toContain(SALT);
		// Presence assertion: the response has a body at all, so the absences
		// above are about its contents rather than an empty string.
		expect(text.length).toBeGreaterThan(0);
	});

	// Task 7's contract: disabled means absent, not forbidden. A 403 tells an
	// unauthenticated prober the feature exists and is merely closed to them.
	test("is absent while the feature flag is off", async () => {
		process.env.DITERO_E2E_ENABLED = "false";
		const response = await enroll(body(KEY_A), { cookie });
		expect(response.status).toBe(404);
		expect(await storedKeys()).toEqual([]);
	});
});
