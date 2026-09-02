import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import {
	aad,
	decryptWrapped,
	encryptWrapped,
} from "../../src/domain/e2e/envelope.ts";
import {
	CURRENT_KDF_VERSION,
	deriveKek,
	generateSalt,
	KDF_PARAMS,
	type KdfParams,
} from "../../src/domain/e2e/kdf.ts";
import {
	generateRecoveryCode,
	normaliseRecoveryCode,
} from "../../src/domain/e2e/recovery-code.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
} from "../../src/domain/e2e/wire.ts";
import { app } from "../../src/server/index.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

// M-E2E Task 12. The properties here are all about what a rewrap must NOT
// touch: recovery restores the SAME keypair (a new one would orphan every
// grant), changing one secret leaves the other's wrap byte-identical, and
// changing the ACCOUNT password touches neither -- which is the whole reason
// the E2E passphrase is a separate secret at all.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });

const ORIGIN = "http://localhost:5173";
const ACCOUNT_PASSWORD = "pw-123456";

let cookie: string;
let userId: string;
let seq = 0;

async function signUp(
	email: string,
): Promise<{ cookie: string; userId: string }> {
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({
				name: "Recover",
				email,
				password: ACCOUNT_PASSWORD,
			}),
		}),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { user: { id: string } };
	return {
		cookie: response.headers
			.getSetCookie()
			.map((value) => value.split(";", 1)[0])
			.join("; "),
		userId: body.user.id,
	};
}

function post(
	path: string,
	payload: unknown,
	init: { cookie?: string; origin?: string } = {},
) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		origin: init.origin ?? ORIGIN,
	};
	if (init.cookie !== undefined) headers.cookie = init.cookie;
	return app.handle(
		new Request(`http://localhost:3000${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		}),
	);
}

function get(path: string, init: { cookie?: string; origin?: string } = {}) {
	const headers: Record<string, string> = {};
	if (init.origin) headers.origin = init.origin;
	if (init.cookie !== undefined) headers.cookie = init.cookie;
	return app.handle(new Request(`http://localhost:3000${path}`, { headers }));
}

type Wraps = {
	publicKey: string;
	passphraseWrapped: string;
	recoveryWrapped: string;
	passphraseSalt: string;
	recoverySalt: string;
	formatVersion: number;
};

async function storedWraps(): Promise<Wraps> {
	const rows = await pool.query<{
		public_key: string;
		passphrase_wrapped: string;
		recovery_wrapped: string;
		passphrase_salt: string;
		recovery_salt: string;
		format_version: number;
	}>(
		`select k.public_key, s.passphrase_wrapped, s.recovery_wrapped,
		 s.passphrase_salt, s.recovery_salt, s.format_version
		 from user_key k join user_key_secret s on s.user_key_id = k.id
		 where k.user_id = $1 and k.retired_at is null`,
		[userId],
	);
	const row = rows.rows[0];
	if (!row) throw new Error("no user_key row");
	return {
		publicKey: row.public_key,
		passphraseWrapped: row.passphrase_wrapped,
		recoveryWrapped: row.recovery_wrapped,
		passphraseSalt: row.passphrase_salt,
		recoverySalt: row.recovery_salt,
		formatVersion: row.format_version,
	};
}

// The identity's private key, held only by this test. Every assertion about
// "the same keypair" is checked by unwrapping to these exact bytes rather than
// by comparing the public key alone: the public key is immutable in the
// schema, so a public-key comparison would pass even against a wrap that opens
// to something else entirely.
const PRIVATE_KEY = new Uint8Array(32).map(
	(_, index) => (index * 7 + 3) & 0xff,
);

async function wrapUnder(
	secret: string,
	purpose: "passphrase" | "recovery",
	salt: Uint8Array,
): Promise<string> {
	const kek = await deriveKek(secret, salt, purpose, CURRENT_KDF_VERSION);
	return encodeWrapped(
		await encryptWrapped(
			PRIVATE_KEY,
			kek,
			purpose === "passphrase"
				? aad.privateKeyPassphrase(userId)
				: aad.privateKeyRecovery(userId),
		),
	);
}

async function openWith(
	secret: string,
	purpose: "passphrase" | "recovery",
	wrapped: string,
	salt: string,
	version: number,
): Promise<Uint8Array> {
	const kek = await deriveKek(secret, decodeBytes(salt), purpose, version);
	return await decryptWrapped(
		decodeWrapped(wrapped),
		kek,
		purpose === "passphrase"
			? aad.privateKeyPassphrase(userId)
			: aad.privateKeyRecovery(userId),
	);
}

const PASSPHRASE = "correct horse battery";
let recoveryCanonical: string;

/** Enrolls the fixed private key under a fresh passphrase and recovery code. */
async function enrollFixture(): Promise<void> {
	const recovery = await generateRecoveryCode();
	recoveryCanonical = recovery.canonical;
	const passphraseSalt = generateSalt();
	const recoverySalt = generateSalt();
	const response = await post(
		"/api/e2e/enroll",
		{
			publicKey: encodeBytes(new Uint8Array(32).fill(9)),
			passphraseWrapped: await wrapUnder(
				PASSPHRASE,
				"passphrase",
				passphraseSalt,
			),
			recoveryWrapped: await wrapUnder(
				recovery.canonical,
				"recovery",
				recoverySalt,
			),
			passphraseSalt: encodeBytes(passphraseSalt),
			recoverySalt: encodeBytes(recoverySalt),
			formatVersion: CURRENT_KDF_VERSION,
		},
		{ cookie },
	);
	expect(response.status).toBe(200);
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	seq += 1;
	({ cookie, userId } = await signUp(
		`recover-${Date.now()}-${seq}@test.invalid`,
	));
	process.env.DITERO_E2E_ENABLED = "true";
	await enrollFixture();
}, 30_000);

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("GET /api/e2e/identity/recovery", () => {
	test("returns the recovery wrap, which the unlock read withholds", async () => {
		const stored = await storedWraps();
		const response = await get("/api/e2e/identity/recovery", { cookie });
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toEqual({
			enrolled: true,
			recoveryWrapped: stored.recoveryWrapped,
			recoverySalt: stored.recoverySalt,
			formatVersion: CURRENT_KDF_VERSION,
		});
		// Presence of the recovery wrap here is only meaningful against its
		// absence there, so both halves are asserted in one place.
		const unlockRead = await get("/api/e2e/identity", { cookie });
		expect(await unlockRead.text()).not.toContain(stored.recoveryWrapped);
	});

	test("requires a session", async () => {
		expect((await get("/api/e2e/identity/recovery")).status).toBe(401);
	});

	test("refuses a foreign origin", async () => {
		const response = await get("/api/e2e/identity/recovery", {
			cookie,
			origin: "https://evil.test",
		});
		expect(response.status).toBe(403);
	});

	test("is absent while the feature flag is off", async () => {
		process.env.DITERO_E2E_ENABLED = "false";
		expect((await get("/api/e2e/identity/recovery", { cookie })).status).toBe(
			404,
		);
	});
});

describe("recovery unlock", () => {
	test("the correct code opens the SAME keypair", async () => {
		const response = await get("/api/e2e/identity/recovery", { cookie });
		const body = (await response.json()) as {
			recoveryWrapped: string;
			recoverySalt: string;
			formatVersion: number;
		};
		const opened = await openWith(
			await normaliseRecoveryCode(recoveryCanonical),
			"recovery",
			body.recoveryWrapped,
			body.recoverySalt,
			body.formatVersion,
		);
		// A recovery that minted a NEW identity would silently orphan every
		// existing grant, so the bytes -- not just the public key -- must match.
		expect(opened).toEqual(PRIVATE_KEY);
	});

	test("a wrong code fails and alters no wrap", async () => {
		const before = await storedWraps();
		const wrong = await generateRecoveryCode();
		const body = (await (
			await get("/api/e2e/identity/recovery", { cookie })
		).json()) as {
			recoveryWrapped: string;
			recoverySalt: string;
			formatVersion: number;
		};
		await expect(
			openWith(
				wrong.canonical,
				"recovery",
				body.recoveryWrapped,
				body.recoverySalt,
				body.formatVersion,
			),
		).rejects.toThrow();
		expect(await storedWraps()).toEqual(before);
	});
});

describe("POST /api/e2e/rewrap", () => {
	async function rewrapPassphrase(
		next: string,
		over?: Record<string, unknown>,
	): Promise<Response> {
		const before = await storedWraps();
		const salt = generateSalt();
		return await post(
			"/api/e2e/rewrap",
			{
				passphrase: {
					wrapped: await wrapUnder(next, "passphrase", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.passphraseWrapped,
				},
				formatVersion: before.formatVersion,
				...over,
			},
			{ cookie },
		);
	}

	async function rewrapRecovery(over?: Record<string, unknown>): Promise<{
		response: Response;
		canonical: string;
	}> {
		const before = await storedWraps();
		const recovery = await generateRecoveryCode();
		const salt = generateSalt();
		const response = await post(
			"/api/e2e/rewrap",
			{
				recovery: {
					wrapped: await wrapUnder(recovery.canonical, "recovery", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.recoveryWrapped,
				},
				formatVersion: before.formatVersion,
				...over,
			},
			{ cookie },
		);
		return { response, canonical: recovery.canonical };
	}

	test("changing the passphrase rewraps only passphrase_wrapped", async () => {
		const before = await storedWraps();
		expect((await rewrapPassphrase("a whole new passphrase")).status).toBe(200);
		const after = await storedWraps();

		expect(after.passphraseWrapped).not.toBe(before.passphraseWrapped);
		expect(after.passphraseSalt).not.toBe(before.passphraseSalt);
		// The point of the test: the recovery code a user has on paper must
		// still work after a passphrase change, which is exactly what the app
		// promises them in e2e_change_passphrase_done.
		expect(after.recoveryWrapped).toBe(before.recoveryWrapped);
		expect(after.recoverySalt).toBe(before.recoverySalt);
		expect(after.publicKey).toBe(before.publicKey);

		expect(
			await openWith(
				"a whole new passphrase",
				"passphrase",
				after.passphraseWrapped,
				after.passphraseSalt,
				after.formatVersion,
			),
		).toEqual(PRIVATE_KEY);
		expect(
			await openWith(
				await normaliseRecoveryCode(recoveryCanonical),
				"recovery",
				after.recoveryWrapped,
				after.recoverySalt,
				after.formatVersion,
			),
		).toEqual(PRIVATE_KEY);
	});

	test("regenerating the recovery code rewraps only recovery_wrapped", async () => {
		const before = await storedWraps();
		const { response, canonical } = await rewrapRecovery();
		expect(response.status).toBe(200);
		const after = await storedWraps();

		expect(after.recoveryWrapped).not.toBe(before.recoveryWrapped);
		expect(after.recoverySalt).not.toBe(before.recoverySalt);
		expect(after.passphraseWrapped).toBe(before.passphraseWrapped);
		expect(after.passphraseSalt).toBe(before.passphraseSalt);

		expect(
			await openWith(
				canonical,
				"recovery",
				after.recoveryWrapped,
				after.recoverySalt,
				after.formatVersion,
			),
		).toEqual(PRIVATE_KEY);
		// The old code stops working the moment the new one exists, which is
		// what e2e_regenerate_warning tells the user before they commit.
		await expect(
			openWith(
				await normaliseRecoveryCode(recoveryCanonical),
				"recovery",
				after.recoveryWrapped,
				after.recoverySalt,
				after.formatVersion,
			),
		).rejects.toThrow();
	});

	test("the recovery reset replaces both wraps in one write", async () => {
		const before = await storedWraps();
		const recovery = await generateRecoveryCode();
		const passphraseSalt = generateSalt();
		const recoverySalt = generateSalt();
		const response = await post(
			"/api/e2e/rewrap",
			{
				passphrase: {
					wrapped: await wrapUnder(
						"reset passphrase",
						"passphrase",
						passphraseSalt,
					),
					salt: encodeBytes(passphraseSalt),
					previousWrapped: before.passphraseWrapped,
				},
				recovery: {
					wrapped: await wrapUnder(
						recovery.canonical,
						"recovery",
						recoverySalt,
					),
					salt: encodeBytes(recoverySalt),
					previousWrapped: before.recoveryWrapped,
				},
				formatVersion: before.formatVersion,
			},
			{ cookie },
		);
		expect(response.status).toBe(200);
		const after = await storedWraps();
		expect(after.passphraseWrapped).not.toBe(before.passphraseWrapped);
		expect(after.recoveryWrapped).not.toBe(before.recoveryWrapped);
		expect(
			await openWith(
				"reset passphrase",
				"passphrase",
				after.passphraseWrapped,
				after.passphraseSalt,
				after.formatVersion,
			),
		).toEqual(PRIVATE_KEY);
	});

	// The compare-and-set. Both callers read the same wrap, both build a
	// replacement for it, and only one may land: interleaving them would leave
	// a salt from one write beside a wrap from the other, which no secret opens.
	test("two concurrent rewrites of the same wrap resolve to one winner", async () => {
		const before = await storedWraps();
		const build = async (secret: string) => {
			const salt = generateSalt();
			return {
				passphrase: {
					wrapped: await wrapUnder(secret, "passphrase", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.passphraseWrapped,
				},
				formatVersion: before.formatVersion,
			};
		};
		const [first, second] = await Promise.all([
			build("first winner"),
			build("second winner"),
		]);
		const responses = await Promise.all([
			post("/api/e2e/rewrap", first, { cookie }),
			post("/api/e2e/rewrap", second, { cookie }),
		]);
		const codes = responses.map((r) => r.status).sort();
		expect(codes).toEqual([200, 409]);

		const after = await storedWraps();
		const winner = responses[0]?.status === 200 ? first : second;
		expect(after.passphraseWrapped).toBe(winner.passphrase.wrapped);
		expect(after.passphraseSalt).toBe(winner.passphrase.salt);
	});

	test("a stale previousWrapped is refused and changes nothing", async () => {
		const before = await storedWraps();
		const salt = generateSalt();
		const response = await post(
			"/api/e2e/rewrap",
			{
				passphrase: {
					wrapped: await wrapUnder("nope", "passphrase", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.recoveryWrapped,
				},
				formatVersion: before.formatVersion,
			},
			{ cookie },
		);
		expect(response.status).toBe(409);
		expect(await storedWraps()).toEqual(before);
	});

	test("refuses a body that replaces neither wrap", async () => {
		const before = await storedWraps();
		const response = await post(
			"/api/e2e/rewrap",
			{ formatVersion: before.formatVersion },
			{ cookie },
		);
		expect(response.status).toBe(400);
		expect(await storedWraps()).toEqual(before);
	});

	// One column, two wraps. A partial rewrap that also moved format_version
	// would re-stamp the wrap it did NOT touch with a version it was never
	// derived under -- the #168 defect, one endpoint later, and equally
	// unfixable by any secret the user knows.
	//
	// The rule is only reachable while TWO versions are registered, so the
	// registry gains one for the duration. Without it every probe value is
	// refused by the registry check one step earlier and this test passes
	// against a server that has no such rule at all -- which is what it did
	// on the first writing.
	describe("with a second KDF version registered", () => {
		const SECOND = CURRENT_KDF_VERSION + 1;
		beforeEach(() => {
			KDF_PARAMS[SECOND] = KDF_PARAMS[CURRENT_KDF_VERSION] as KdfParams;
		});
		afterEach(() => {
			delete KDF_PARAMS[SECOND];
		});

		test("a partial rewrap may not change format_version", async () => {
			const before = await storedWraps();
			expect(before.formatVersion).not.toBe(SECOND);
			const response = await rewrapPassphrase("another passphrase", {
				formatVersion: SECOND,
			});
			expect(response.status).toBe(400);
			expect(await storedWraps()).toEqual(before);
		});

		// The other half of the same rule: replacing BOTH wraps is the only
		// write that may move the shared column, because it is the only one
		// after which both wraps were derived under the version it names. The
		// server cannot verify that claim -- the wraps are opaque -- so this
		// asserts the column moved, not that anything was re-derived.
		test("a full rewrap may change format_version", async () => {
			const before = await storedWraps();
			const recovery = await generateRecoveryCode();
			const passphraseSalt = generateSalt();
			const recoverySalt = generateSalt();
			const response = await post(
				"/api/e2e/rewrap",
				{
					passphrase: {
						wrapped: await wrapUnder(
							"v2 passphrase",
							"passphrase",
							passphraseSalt,
						),
						salt: encodeBytes(passphraseSalt),
						previousWrapped: before.passphraseWrapped,
					},
					recovery: {
						wrapped: await wrapUnder(
							recovery.canonical,
							"recovery",
							recoverySalt,
						),
						salt: encodeBytes(recoverySalt),
						previousWrapped: before.recoveryWrapped,
					},
					formatVersion: SECOND,
				},
				{ cookie },
			);
			expect(response.status).toBe(200);
			expect((await storedWraps()).formatVersion).toBe(SECOND);
		});
	});

	test("requires a session", async () => {
		const before = await storedWraps();
		const salt = generateSalt();
		const response = await post("/api/e2e/rewrap", {
			passphrase: {
				wrapped: await wrapUnder("x", "passphrase", salt),
				salt: encodeBytes(salt),
				previousWrapped: before.passphraseWrapped,
			},
			formatVersion: before.formatVersion,
		});
		expect(response.status).toBe(401);
		expect(await storedWraps()).toEqual(before);
	});

	test("refuses a foreign origin", async () => {
		const before = await storedWraps();
		const salt = generateSalt();
		const response = await post(
			"/api/e2e/rewrap",
			{
				passphrase: {
					wrapped: await wrapUnder("x", "passphrase", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.passphraseWrapped,
				},
				formatVersion: before.formatVersion,
			},
			{ cookie, origin: "https://evil.test" },
		);
		expect(response.status).toBe(403);
		expect(await storedWraps()).toEqual(before);
	});

	test("is absent while the feature flag is off", async () => {
		const before = await storedWraps();
		process.env.DITERO_E2E_ENABLED = "false";
		const salt = generateSalt();
		const response = await post(
			"/api/e2e/rewrap",
			{
				passphrase: {
					wrapped: await wrapUnder("x", "passphrase", salt),
					salt: encodeBytes(salt),
					previousWrapped: before.passphraseWrapped,
				},
				formatVersion: before.formatVersion,
			},
			{ cookie },
		);
		expect(response.status).toBe(404);
		expect(await storedWraps()).toEqual(before);
	});

	test("never echoes a wrapped blob or a salt", async () => {
		const before = await storedWraps();
		const response = await rewrapPassphrase("echo check");
		const text = await response.text();
		expect(text.length).toBeGreaterThan(0);
		const after = await storedWraps();
		for (const secret of [
			before.passphraseWrapped,
			before.recoveryWrapped,
			after.passphraseWrapped,
			after.passphraseSalt,
		]) {
			expect(text).not.toContain(secret);
		}
	});
});

describe("the account password is a different secret", () => {
	test("changing it leaves both wraps byte-identical", async () => {
		const before = await storedWraps();
		const response = await handleAuthRequest(
			new Request("http://localhost:3000/api/auth/change-password", {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN, cookie },
				body: JSON.stringify({
					currentPassword: ACCOUNT_PASSWORD,
					newPassword: "a-brand-new-account-password",
				}),
			}),
		);
		expect(response.status).toBe(200);
		// This is the one users get wrong, and it is the reason the E2E
		// passphrase is separate at all: the account password protects the
		// session, and nothing it does can reach a wrap the server cannot read.
		expect(await storedWraps()).toEqual(before);
		expect(
			await openWith(
				PASSPHRASE,
				"passphrase",
				before.passphraseWrapped,
				before.passphraseSalt,
				before.formatVersion,
			),
		).toEqual(PRIVATE_KEY);
	}, 30_000);
});
