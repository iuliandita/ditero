import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import {
	generateIdentityKeyPair,
	importRecipientPrivateKey,
	importRecipientPublicKey,
	openWdk,
	publicKeyFingerprint,
	sealWdk,
} from "../../src/domain/e2e/hpke.ts";
import { CURRENT_KDF_VERSION } from "../../src/domain/e2e/kdf.ts";
import { activeRecipientKeyGuard } from "../../src/server/e2e/identity-rotation.ts";
import { app } from "../../src/server/index.ts";

// M-E2E Task 13. Rotation is the design's answer to a compromised device
// (design 12): the user rewraps every WDK they already hold to a fresh keypair
// and retires the old one. The properties that matter are that the rewrap set
// is COMPLETE -- a partial rotation loses access to the versions it skipped,
// and the loss only surfaces when someone opens an old file months later -- and
// that the retired key immediately stops being a valid grant target.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });

const ORIGIN = "http://localhost:5173";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

const fingerprintOf = (publicKey: string) =>
	publicKeyFingerprint(unb64(publicKey));

const WRAP = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";

type Identity = {
	publicKey: string;
	privateKey: Uint8Array;
};

async function newIdentity(): Promise<Identity> {
	const pair = await generateIdentityKeyPair();
	return { publicKey: b64(pair.publicKey), privateKey: pair.privateKey };
}

async function signUp(email: string): Promise<string> {
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ name: "Rot", email, password: "pw-123456" }),
		}),
	);
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

function post(
	path: string,
	payload: unknown,
	cookie?: string,
	origin?: string,
) {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		origin: origin ?? ORIGIN,
	};
	if (cookie) headers.cookie = cookie;
	return app.handle(
		new Request(`http://localhost:3000${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
		}),
	);
}

const enroll = (identity: Identity, cookie: string) =>
	post(
		"/api/e2e/enroll",
		{
			publicKey: identity.publicKey,
			passphraseWrapped: WRAP,
			recoveryWrapped: WRAP,
			passphraseSalt: SALT,
			recoverySalt: SALT,
			formatVersion: CURRENT_KDF_VERSION,
		},
		cookie,
	);

const rotate = (payload: Record<string, unknown>, cookie?: string) =>
	post("/api/e2e/identity/rotate", payload, cookie);

type Held = {
	id: string;
	membershipId: string;
	workspaceId: string;
	keyVersion: number;
	enc: string;
	ciphertext: string;
	recipientPublicKey: string;
};

async function heldKeys(userId: string): Promise<Held[]> {
	const rows = await pool.query<{
		id: string;
		membership_id: string;
		workspace_id: string;
		key_version: number;
		enc: string;
		ciphertext: string;
		recipient_public_key: string;
	}>(
		`select id, membership_id, workspace_id, key_version, enc, ciphertext,
		 recipient_public_key from membership_key where user_id = $1
		 order by key_version`,
		[userId],
	);
	return rows.rows.map((r) => ({
		id: r.id,
		membershipId: r.membership_id,
		workspaceId: r.workspace_id,
		keyVersion: r.key_version,
		enc: r.enc,
		ciphertext: r.ciphertext,
		recipientPublicKey: r.recipient_public_key,
	}));
}

async function identityRows(userId: string) {
	const rows = await pool.query<{ public_key: string; retired: boolean }>(
		`select public_key, retired_at is not null as retired from user_key
		 where user_id = $1 order by created_at, id`,
		[userId],
	);
	return rows.rows.map((r) => ({
		publicKey: r.public_key,
		retired: r.retired,
	}));
}

/** Seals `wdk` to `identity` exactly as a granting client would. */
async function seal(
	wdk: Uint8Array,
	identity: Identity,
	info: { workspaceId: string; keyVersion: number; recipientUserId: string },
) {
	const sealed = await sealWdk(
		wdk,
		await importRecipientPublicKey(unb64(identity.publicKey)),
		{
			...info,
			recipientFingerprint: await fingerprintOf(identity.publicKey),
		},
	);
	return { enc: b64(sealed.enc), ciphertext: b64(sealed.ciphertext) };
}

async function open(
	held: Held,
	identity: Identity,
	recipientUserId: string,
): Promise<Uint8Array> {
	return await openWdk(
		{ enc: unb64(held.enc), ciphertext: unb64(held.ciphertext) },
		await importRecipientPrivateKey(identity.privateKey),
		{
			workspaceId: held.workspaceId,
			keyVersion: held.keyVersion,
			recipientUserId,
			recipientFingerprint: await fingerprintOf(identity.publicKey),
		},
	);
}

/** The client half of a rotation: open every held wrap, re-seal it to `next`. */
async function rewrapAll(
	userId: string,
	current: Identity,
	next: Identity,
): Promise<{ membershipKeyId: string; enc: string; ciphertext: string }[]> {
	const held = await heldKeys(userId);
	const out = [];
	for (const row of held) {
		const wdk = await open(row, current, userId);
		const sealed = await seal(wdk, next, {
			workspaceId: row.workspaceId,
			keyVersion: row.keyVersion,
			recipientUserId: userId,
		});
		out.push({ membershipKeyId: row.id, ...sealed });
	}
	return out;
}

function rotateBody(
	next: Identity,
	previous: Identity,
	rewraps: { membershipKeyId: string; enc: string; ciphertext: string }[],
) {
	return {
		publicKey: next.publicKey,
		previousPublicKey: previous.publicKey,
		passphraseWrapped: `${WRAP}-next`,
		recoveryWrapped: `${WRAP}-next-r`,
		passphraseSalt: `${SALT}1`,
		recoverySalt: `${SALT}2`,
		formatVersion: CURRENT_KDF_VERSION,
		rewraps,
	};
}

const WDK_V1 = new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff);
const WDK_V2 = new Uint8Array(32).map((_, i) => (i * 11 + 7) & 0xff);

let cookie: string;
let alice: string;
let bob: string;
let aliceKey: Identity;
let bobKey: Identity;
let seq = 0;

beforeEach(async () => {
	await pool.query("delete from membership");
	await pool.query("delete from workspace");
	await pool.query("delete from rate_limit");
	await pool.query("delete from session");
	await pool.query("delete from account");
	await pool.query('delete from "user"');
	seq += 1;
	process.env.DITERO_E2E_ENABLED = "true";

	cookie = await signUp(`rot-alice-${Date.now()}-${seq}@test.invalid`);
	const users = await pool.query<{ id: string }>('select id from "user"');
	alice = users.rows[0]?.id ?? "";
	expect(alice).toBeTruthy();
	// Inserted rather than signed up: DITERO_REGISTRATION_MODE is bootstrap
	// here, so only the first account may self-register. Bob exists to own
	// membership_key rows the rotation must not touch and never makes a request,
	// so he needs no session.
	bob = "u_rot_bob";
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ($1, 'Bob', 'rot-bob@test.invalid', true, now(), now())`,
		[bob],
	);

	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ('ws_1', 'Shared', $1, 'shared')`,
		[alice],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role)
		 values ('m_alice', $1, 'ws_1', 'owner'), ('m_bob', $2, 'ws_1', 'member')`,
		[alice, bob],
	);
	await pool.query(
		`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
		 values ('wk_1', 'ws_1', 1, 'commit_1', $1),
		        ('wk_2', 'ws_1', 2, 'commit_2', $1)`,
		[alice],
	);

	aliceKey = await newIdentity();
	bobKey = await newIdentity();
	expect((await enroll(aliceKey, cookie)).status).toBe(200);

	for (const [version, wdk] of [
		[1, WDK_V1],
		[2, WDK_V2],
	] as const) {
		const sealed = await seal(wdk, aliceKey, {
			workspaceId: "ws_1",
			keyVersion: version,
			recipientUserId: alice,
		});
		await pool.query(
			`insert into membership_key (id, membership_id, user_id, workspace_id,
			 key_version, enc, ciphertext, recipient_public_key, granted_by)
			 values ($1, 'm_alice', $2, 'ws_1', $3, $4, $5, $6, $2)`,
			[
				`mk_alice_v${version}`,
				alice,
				version,
				sealed.enc,
				sealed.ciphertext,
				aliceKey.publicKey,
			],
		);
	}
	const bobSealed = await seal(WDK_V1, bobKey, {
		workspaceId: "ws_1",
		keyVersion: 1,
		recipientUserId: bob,
	});
	await pool.query(
		`insert into membership_key (id, membership_id, user_id, workspace_id,
		 key_version, enc, ciphertext, recipient_public_key, granted_by)
		 values ('mk_bob_v1', 'm_bob', $1, 'ws_1', 1, $2, $3, $4, $5)`,
		[bob, bobSealed.enc, bobSealed.ciphertext, bobKey.publicKey, alice],
	);
});

afterAll(async () => {
	process.env.DITERO_E2E_ENABLED = undefined;
	await pool.end();
});

describe("POST /api/e2e/identity/rotate", () => {
	test("the caller can open every WDK version they held before", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(rewraps).toHaveLength(2);

		const response = await rotate(rotateBody(next, aliceKey, rewraps), cookie);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			publicKey: next.publicKey,
			rewrapped: 2,
		});

		const held = await heldKeys(alice);
		expect(held.map((h) => h.recipientPublicKey)).toEqual([
			next.publicKey,
			next.publicKey,
		]);
		// The wraps open under the NEW private key, and the plaintexts are the
		// same workspace keys as before -- a rotation that silently substituted a
		// WDK would still decrypt cleanly, so the plaintext is the assertion.
		expect(await open(held[0] as Held, next, alice)).toEqual(WDK_V1);
		expect(await open(held[1] as Held, next, alice)).toEqual(WDK_V2);

		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: true },
			{ publicKey: next.publicKey, retired: false },
		]);
	});

	test("the old private key can no longer open the rewrapped keys", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(
			(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
		).toBe(200);

		const held = await heldKeys(alice);
		// Cryptographic revocation, which is the entire point of design 12: a
		// device that kept the old private key holds nothing that opens the
		// current wraps. Without this the endpoint would be a bookkeeping change.
		await expect(open(held[0] as Held, aliceKey, alice)).rejects.toThrow();
	});

	test("a partial rewrap set is rejected wholesale", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const before = await heldKeys(alice);

		const response = await rotate(
			rotateBody(next, aliceKey, rewraps.slice(0, 1)),
			cookie,
		);
		expect(response.status).toBe(400);
		// Nothing moved: a rotation that applied its one valid rewrap and then
		// failed would leave v2 addressed to a key the user has just been told is
		// dead, and the loss would surface only when someone opened an old file.
		expect(await heldKeys(alice)).toEqual(before);
		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: false },
		]);
	});

	test("a rewrap set naming a key the caller does not hold is rejected", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const stray = { ...(rewraps[0] as (typeof rewraps)[number]) };
		stray.membershipKeyId = "mk_bob_v1";

		const response = await rotate(
			rotateBody(next, aliceKey, [...rewraps, stray]),
			cookie,
		);
		expect(response.status).toBe(400);
		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: false },
		]);
	});

	test("other members' wraps are untouched", async () => {
		const bobBefore = await heldKeys(bob);
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(
			(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
		).toBe(200);

		expect(await heldKeys(bob)).toEqual(bobBefore);
		// Presence assertion: Bob's row exists and still opens, so the equality
		// above is about it being unchanged rather than about it being absent.
		expect(bobBefore).toHaveLength(1);
		expect(await open(bobBefore[0] as Held, bobKey, bob)).toEqual(WDK_V1);
	});

	test("no workspace_key row changes", async () => {
		const snapshot = () =>
			pool.query("select * from workspace_key order by version");
		const before = (await snapshot()).rows;
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(
			(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
		).toBe(200);
		expect((await snapshot()).rows).toEqual(before);
		expect(before).toHaveLength(2);
	});

	test("a grant addressed to the retired key is rejected", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(
			(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
		).toBe(200);

		// Task 15's grant endpoint is the guard's real consumer; the fragment
		// itself ships here because rotation is what makes a key stale.
		const grant = (recipientKey: string) =>
			pool.query(
				`insert into membership_key (id, membership_id, user_id, workspace_id,
				 key_version, enc, ciphertext, recipient_public_key, granted_by)
				 select 'mk_late', 'm_alice', $1, 'ws_1', 3, 'enc', 'ct', $2, $1
				 where ${activeRecipientKeyGuard(1, 2)}`,
				[alice, recipientKey],
			);

		expect((await grant(aliceKey.publicKey)).rowCount).toBe(0);
		// Presence half: the same insert against the CURRENT key lands, so the
		// zero above is the guard rejecting rather than the statement being
		// malformed in a way that could never insert anything.
		expect((await grant(next.publicKey)).rowCount).toBe(1);
	});

	test("a grant racing the rotation cannot land on the retired key", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);

		const granter = await pool.connect();
		try {
			await granter.query("begin");
			// The granter reads a live key and is then overtaken. The check has to
			// ride INSIDE the write for this to be safe: a read-then-insert would
			// have already decided, and would deliver a wrap addressed to a key the
			// recipient has just revoked.
			const seen = await granter.query(
				"select public_key from user_key where user_id = $1 and retired_at is null",
				[alice],
			);
			expect(seen.rows[0]?.public_key).toBe(aliceKey.publicKey);

			expect(
				(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
			).toBe(200);

			const landed = await granter.query(
				`insert into membership_key (id, membership_id, user_id, workspace_id,
				 key_version, enc, ciphertext, recipient_public_key, granted_by)
				 select 'mk_race', 'm_alice', $1, 'ws_1', 3, 'enc', 'ct', $2, $1
				 where ${activeRecipientKeyGuard(1, 2)}`,
				[alice, aliceKey.publicKey],
			);
			expect(landed.rowCount).toBe(0);
		} finally {
			// Always ends the transaction, and rollback rather than commit because
			// nothing here should land. A client released mid-transaction goes back
			// to the pool still holding its locks, and every later test that draws
			// it hangs -- which is how one failed assertion here turned into ten
			// unrelated 10s timeouts under a mutation probe.
			await granter.query("rollback").catch(() => {});
			granter.release();
		}
		expect(await heldKeys(alice)).toHaveLength(2);
	});

	test("refuses a rotation whose previous key is not the active one", async () => {
		const next = await newIdentity();
		const other = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const response = await rotate(rotateBody(next, other, rewraps), cookie);
		expect(response.status).toBe(409);
		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: false },
		]);
	});

	test("refuses a rotation to the key it is replacing", async () => {
		const rewraps = await rewrapAll(alice, aliceKey, aliceKey);
		// Not merely a no-op: it would report a successful revocation while
		// leaving the compromised key live, which is the one lie this endpoint
		// must never tell.
		const response = await rotate(
			rotateBody(aliceKey, aliceKey, rewraps),
			cookie,
		);
		expect(response.status).toBe(400);
	});

	test("requires a session", async () => {
		const next = await newIdentity();
		const response = await rotate(rotateBody(next, aliceKey, []));
		expect(response.status).toBe(401);
	});

	test("refuses a foreign origin", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const response = await post(
			"/api/e2e/identity/rotate",
			rotateBody(next, aliceKey, rewraps),
			cookie,
			"https://evil.test",
		);
		expect(response.status).toBe(403);
	});

	test("is absent while the feature flag is off", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		process.env.DITERO_E2E_ENABLED = "false";
		const response = await rotate(rotateBody(next, aliceKey, rewraps), cookie);
		expect(response.status).toBe(404);
		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: false },
		]);
	});

	// The three tests below guard the sweep this task forced: before rotation
	// existed, "the user's identity" and "the user's only user_key row" were the
	// same thing, so no query had to say which it meant. Every read here now
	// scopes to retired_at is null, and an unscoped one picks a row arbitrarily
	// rather than failing -- which is a wrong answer, not an error.
	test("the identity endpoint reports the rotated key", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const body = rotateBody(next, aliceKey, rewraps);
		expect((await rotate(body, cookie)).status).toBe(200);

		const response = await app.handle(
			new Request("http://localhost:3000/api/e2e/identity", {
				headers: { cookie, origin: ORIGIN },
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			enrolled: true,
			publicKey: next.publicKey,
			formatVersion: CURRENT_KDF_VERSION,
			passphraseWrapped: body.passphraseWrapped,
			passphraseSalt: body.passphraseSalt,
		});
	});

	test("the recovery endpoint reports the rotated wrap", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const body = rotateBody(next, aliceKey, rewraps);
		expect((await rotate(body, cookie)).status).toBe(200);

		const response = await app.handle(
			new Request("http://localhost:3000/api/e2e/identity/recovery", {
				headers: { cookie, origin: ORIGIN },
			}),
		);
		expect(await response.json()).toEqual({
			enrolled: true,
			recoveryWrapped: body.recoveryWrapped,
			recoverySalt: body.recoverySalt,
			formatVersion: CURRENT_KDF_VERSION,
		});
	});

	test("enrolling after a rotation conflicts instead of adding a row", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		expect(
			(await rotate(rotateBody(next, aliceKey, rewraps), cookie)).status,
		).toBe(200);

		// The retired key reads as someone else's identity now, which is the
		// answer that matters: a re-enrol must never resurrect it.
		expect((await enroll(aliceKey, cookie)).status).toBe(409);
		// Presence half, and the arbiter's own test: enroll infers its conflict
		// target from user_key_active, so a mismatched ON CONFLICT clause would
		// raise here rather than report idempotent success.
		expect((await enroll(next, cookie)).status).toBe(200);
		expect(await identityRows(alice)).toHaveLength(2);
	});

	test("refuses a rotation when the caller has no active identity", async () => {
		await pool.query("delete from user_key where user_id = $1", [alice]);
		const next = await newIdentity();
		const response = await rotate(rotateBody(next, aliceKey, []), cookie);
		expect(response.status).toBe(409);
		expect(await identityRows(alice)).toEqual([]);
	});

	test("a replayed rotation is refused rather than applied twice", async () => {
		const next = await newIdentity();
		const rewraps = await rewrapAll(alice, aliceKey, next);
		const body = rotateBody(next, aliceKey, rewraps);
		expect((await rotate(body, cookie)).status).toBe(200);

		// The double-submit case, and the reason the CAS token is the previous
		// public key rather than a nonce: the second attempt names an identity
		// that is now retired, so it cannot retire the fresh one it would
		// otherwise land on.
		expect((await rotate(body, cookie)).status).toBe(409);
		expect(await identityRows(alice)).toEqual([
			{ publicKey: aliceKey.publicKey, retired: true },
			{ publicKey: next.publicKey, retired: false },
		]);
	});
});
