import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import { CURRENT_KDF_VERSION, KDF_PARAMS } from "../../src/domain/e2e/kdf.ts";
import { app } from "../../src/server/index.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

// M-E2E Task 8. Enrollment is the one write that establishes an identity, so
// the property that matters is immutability: a second enroll with a different
// public key is a conflict, never an overwrite. Replacing an identity is
// identity rotation (Task 13), which has its own preconditions.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });

const ORIGIN = "http://localhost:5173";

// 32 bytes base64url, unpadded: the wire form of an X25519 public key.
const KEY_A = Buffer.alloc(32, 1).toString("base64url");
const KEY_B = Buffer.alloc(32, 2).toString("base64url");

const WRAPPED = "d3JhcHBlZC1ibG9i";
// Distinct from WRAPPED so "the recovery wrap is withheld" cannot pass by the
// two blobs happening to be the same string.
const RECOVERY_WRAPPED = "cmVjb3ZlcnktYmxvYg";
const SALT = "c2FsdA";

function body(publicKey: string, over?: Record<string, unknown>) {
	return JSON.stringify({
		publicKey,
		passphraseWrapped: WRAPPED,
		recoveryWrapped: WRAPPED,
		passphraseSalt: SALT,
		recoverySalt: SALT,
		formatVersion: CURRENT_KDF_VERSION,
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

function identity(init: { cookie?: string; origin?: string }) {
	const headers: Record<string, string> = {};
	if (init.origin) headers.origin = init.origin;
	if (init.cookie) headers.cookie = init.cookie;
	return app.handle(
		new Request("http://localhost:3000/api/e2e/identity", { headers }),
	);
}

let cookie: string;
let seq = 0;

beforeEach(async () => {
	await resetAuthFixture(pool);
	seq += 1;
	cookie = await signUp(`enroll-${Date.now()}-${seq}@test.invalid`);
	process.env.DITERO_E2E_ENABLED = "true";
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

async function storedKeys(): Promise<{ publicKey: string; state: string }[]> {
	const rows = await pool.query<{ public_key: string; state: string }>(
		"select public_key, state from user_key",
	);
	return rows.rows.map((r) => ({ publicKey: r.public_key, state: r.state }));
}

async function storedFormatVersions(): Promise<number[]> {
	const rows = await pool.query<{ format_version: number }>(
		"select format_version from user_key_secret",
	);
	return rows.rows.map((r) => r.format_version);
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

	// #168. The client sends the KDF version it actually derived under and the
	// server stores that, never its own CURRENT_KDF_VERSION: a client deriving
	// under v1 whose wrap is recorded as v2 fails to unlock forever, with no
	// passphrase that fixes it. The column carries NO database default, so a
	// server that stopped passing the field would fail this insert outright
	// rather than quietly stamp 1 -- which is what makes this assertion
	// load-bearing while only one version is registered.
	test("stores the KDF version the client derived under", async () => {
		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);
		expect(await storedFormatVersions()).toEqual([CURRENT_KDF_VERSION]);
	});

	test("refuses a KDF version that is not registered", async () => {
		const unknown = [0, -1, 1.5, 99];
		// Guards the probe, not the endpoint: a value that IS registered would
		// make this test assert the opposite of its name and still pass the day
		// a v2 lands. It has already earned its keep -- "1" was in this list
		// until it fired, because KDF_PARAMS is string-keyed like every object,
		// so Object.hasOwn(KDF_PARAMS, "1") is true. The string is rejected by
		// z.number() one step earlier, which is a different rule than the one
		// under test here; it is probed as a type below.
		expect(
			unknown.every((value) => !Object.hasOwn(KDF_PARAMS, value)),
			"the probe values must all be genuinely unregistered",
		).toBe(true);
		for (const value of unknown) {
			const response = await enroll(body(KEY_A, { formatVersion: value }), {
				cookie,
			});
			expect(response.status, `formatVersion ${JSON.stringify(value)}`).toBe(
				400,
			);
		}
		expect(await storedKeys()).toEqual([]);
	});

	// The registry is keyed by string, so a JSON string that spells a live
	// version would satisfy Object.hasOwn. Only z.number() stands between that
	// and a stored row, which makes the type check part of the rule rather than
	// incidental input hygiene.
	test("refuses a KDF version that is not a number", async () => {
		for (const value of [String(CURRENT_KDF_VERSION), null, true, [1], {}]) {
			const response = await enroll(body(KEY_A, { formatVersion: value }), {
				cookie,
			});
			expect(response.status, `formatVersion ${JSON.stringify(value)}`).toBe(
				400,
			);
		}
		expect(await storedKeys()).toEqual([]);
	});

	test("refuses an enrollment that omits the KDF version", async () => {
		const payload = JSON.parse(body(KEY_A));
		delete payload.formatVersion;
		const response = await enroll(JSON.stringify(payload), { cookie });
		expect(response.status).toBe(400);
		expect(await storedKeys()).toEqual([]);
	});

	test("reports enrollment state without returning key material", async () => {
		const before = await identity({ cookie });
		expect(before.status).toBe(200);
		expect(await before.json()).toEqual({
			enrolled: false,
			publicKey: null,
			formatVersion: null,
			passphraseWrapped: null,
			passphraseSalt: null,
		});

		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);

		const after = await identity({ cookie });
		expect(after.status).toBe(200);
		expect(await after.json()).toEqual({
			enrolled: true,
			publicKey: KEY_A,
			formatVersion: CURRENT_KDF_VERSION,
			// Task 11: the unlock path's input. Returned to its owner only.
			passphraseWrapped: WRAPPED,
			passphraseSalt: SALT,
		});
	});

	// The recovery wrap opens the same private key under a secret the user is
	// told to keep offline. A route answering "can I unlock here?" has no reason
	// to hand it out, and Task 12's recover path fetches it separately.
	test("identity withholds the recovery wrap", async () => {
		expect(
			(
				await enroll(body(KEY_A, { recoveryWrapped: RECOVERY_WRAPPED }), {
					cookie,
				})
			).status,
		).toBe(200);
		const text = await (await identity({ cookie })).text();
		// Presence assertion first: the passphrase wrap IS there, so the absence
		// below is about which field was withheld and not about an empty body.
		expect(text).toContain(WRAPPED);
		expect(text).not.toContain(RECOVERY_WRAPPED);
	});

	test("identity requires a session", async () => {
		expect((await identity({})).status).toBe(401);
	});

	test("identity refuses a foreign origin", async () => {
		expect(
			(await identity({ cookie, origin: "https://evil.test" })).status,
		).toBe(403);
	});

	test("identity is absent while the feature flag is off", async () => {
		expect((await enroll(body(KEY_A), { cookie })).status).toBe(200);
		process.env.DITERO_E2E_ENABLED = "false";
		expect((await identity({ cookie })).status).toBe(404);
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
