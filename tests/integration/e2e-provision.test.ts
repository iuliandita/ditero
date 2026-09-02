import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import { withRegistrationBypass } from "../../src/auth/registration-bypass.ts";
import {
	generateIdentityKeyPair,
	importRecipientPrivateKey,
	importRecipientPublicKey,
	openWdk,
	publicKeyFingerprint,
	sealWdk,
} from "../../src/domain/e2e/hpke.ts";
import { CURRENT_KDF_VERSION } from "../../src/domain/e2e/kdf.ts";
import { commitWdk } from "../../src/domain/e2e/wdk-commitment.ts";
import { app } from "../../src/server/index.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

// M-E2E Task 14. Provisioning mints workspace_key v1 and the owner's own grant
// in one step. The WDK never reaches the server -- only the commitment (design
// 4.4) and an HPKE wrap addressed to the caller -- so every rule the server can
// enforce is about WHO may mint and about not letting two mints fork the
// workspace into two v1 keys whose files are mutually unreadable.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const ORIGIN = "http://localhost:5173";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

const WRAP = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";

type Identity = { publicKey: string; privateKey: Uint8Array };

async function newIdentity(): Promise<Identity> {
	const pair = await generateIdentityKeyPair();
	return { publicKey: b64(pair.publicKey), privateKey: pair.privateKey };
}

async function signUp(email: string): Promise<string> {
	// Wrapped in the bypass because registration mode is bootstrap here, so only
	// the first account may self-register. This is the same seam the invite and
	// managed-account paths use, so the users it creates are ordinary ones with
	// real credentials and real sessions -- not hand-forged session rows, which
	// would test a cookie this app never issues.
	const response = await withRegistrationBypass(() =>
		handleAuthRequest(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({ name: "Prov", email, password: "pw-123456" }),
			}),
		),
	);
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

function request(
	method: "GET" | "POST",
	path: string,
	init: { body?: unknown; cookie?: string; origin?: string },
) {
	const headers: Record<string, string> = { origin: init.origin ?? ORIGIN };
	if (init.cookie) headers.cookie = init.cookie;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	return app.handle(
		new Request(`http://localhost:3000${path}`, {
			method,
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);
}

const enroll = (identity: Identity, cookie: string) =>
	request("POST", "/api/e2e/enroll", {
		cookie,
		body: {
			publicKey: identity.publicKey,
			passphraseWrapped: WRAP,
			recoveryWrapped: WRAP,
			passphraseSalt: SALT,
			recoverySalt: SALT,
			formatVersion: CURRENT_KDF_VERSION,
		},
	});

const pending = (cookie?: string, origin?: string) =>
	request("GET", "/api/e2e/provision/pending", { cookie, origin });

const provision = (body: unknown, cookie?: string, origin?: string) =>
	request("POST", "/api/e2e/provision", { body, cookie, origin });

/** The client half: mint a WDK, commit to it, seal it to the caller's key. */
async function mint(
	workspaceId: string,
	identity: Identity,
	userId: string,
	wdk = crypto.getRandomValues(new Uint8Array(32)),
) {
	const sealed = await sealWdk(
		wdk,
		await importRecipientPublicKey(unb64(identity.publicKey)),
		{
			workspaceId,
			keyVersion: 1,
			recipientUserId: userId,
			recipientFingerprint: await publicKeyFingerprint(
				unb64(identity.publicKey),
			),
		},
	);
	return {
		wdk,
		body: {
			workspaceId,
			commitment: await commitWdk(wdk, workspaceId, 1),
			enc: b64(sealed.enc),
			ciphertext: b64(sealed.ciphertext),
		},
	};
}

async function workspaceKeys(workspaceId: string) {
	const rows = await pool.query<{ version: number; commitment: string }>(
		"select version, commitment from workspace_key where workspace_id = $1 order by version",
		[workspaceId],
	);
	return rows.rows;
}

async function membershipKeys(userId: string, workspaceId: string) {
	const rows = await pool.query<{
		key_version: number;
		enc: string;
		ciphertext: string;
		recipient_public_key: string;
	}>(
		`select key_version, enc, ciphertext, recipient_public_key
		 from membership_key where user_id = $1 and workspace_id = $2
		 order by key_version`,
		[userId, workspaceId],
	);
	return rows.rows;
}

let ownerCookie: string;
let memberCookie: string;
let strangerCookie: string;
let owner: string;
let member: string;
let stranger: string;
let ownerKey: Identity;
let seq = 0;

// The shared ids are fixed rather than generated: beforeEach empties every table
// these touch, so a collision across tests is impossible and a failure message
// naming 'ws_shared' is readable. PERSONAL is discovered instead, because signup
// creates it and `workspace_personal_owner` forbids a second one per owner.
const SHARED = "ws_shared";
const SHARED_2 = "ws_shared_2";
let PERSONAL = "";
let MEMBER_PERSONAL = "";

beforeEach(async () => {
	await resetAuthFixture(pool);
	seq += 1;
	process.env.DITERO_E2E_ENABLED = "true";

	const stamp = `${Date.now()}-${seq}`;
	ownerCookie = await signUp(`prov-owner-${stamp}@test.invalid`);
	memberCookie = await signUp(`prov-member-${stamp}@test.invalid`);
	strangerCookie = await signUp(`prov-stranger-${stamp}@test.invalid`);
	const users = await pool.query<{ id: string; email: string }>(
		'select id, email from "user"',
	);
	const idFor = (part: string) =>
		users.rows.find((r) => r.email.includes(part))?.id ?? "";
	owner = idFor("owner");
	member = idFor("member");
	stranger = idFor("stranger");
	expect(owner && member && stranger).toBeTruthy();

	// Signup already created one personal workspace per user, with the owner
	// membership, and `workspace_personal_owner` forbids a second. So "several
	// workspaces to provision" is personal PLUS the shared ones, not several
	// personal ones.
	const personal = await pool.query<{ id: string; owner_id: string }>(
		"select id, owner_id from workspace where kind = 'personal'",
	);
	PERSONAL = personal.rows.find((r) => r.owner_id === owner)?.id ?? "";
	MEMBER_PERSONAL = personal.rows.find((r) => r.owner_id === member)?.id ?? "";
	expect(PERSONAL && MEMBER_PERSONAL).toBeTruthy();

	await pool.query(
		`insert into workspace (id, name, owner_id, kind) values
		 ($1, 'Shared', $3, 'shared'), ($2, 'Shared 2', $3, 'shared')`,
		[SHARED, SHARED_2, owner],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ('m_own_s', $1, $3, 'owner'),
		 ('m_own_s2', $1, $4, 'owner'),
		 ('m_member_s', $2, $3, 'member')`,
		[owner, member, SHARED, SHARED_2],
	);

	ownerKey = await newIdentity();
	expect((await enroll(ownerKey, ownerCookie)).status).toBe(200);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("POST /api/e2e/provision", () => {
	test("mints v1 with the client's commitment and the owner's own grant", async () => {
		const { wdk, body } = await mint(PERSONAL, ownerKey, owner);
		const response = await provision(body, ownerCookie);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			workspaceId: PERSONAL,
			version: 1,
			outcome: "minted",
		});

		expect(await workspaceKeys(PERSONAL)).toEqual([
			{ version: 1, commitment: body.commitment },
		]);
		const grants = await membershipKeys(owner, PERSONAL);
		expect(grants).toHaveLength(1);
		expect(grants[0]?.recipient_public_key).toBe(ownerKey.publicKey);
		// The grant opens to the WDK the commitment pins. Asserting the row
		// exists would pass against a server that stored the wrong blob pair.
		expect(
			await openWdk(
				{
					enc: unb64(grants[0]?.enc as string),
					ciphertext: unb64(grants[0]?.ciphertext as string),
				},
				await importRecipientPrivateKey(ownerKey.privateKey),
				{
					workspaceId: PERSONAL,
					keyVersion: 1,
					recipientUserId: owner,
					recipientFingerprint: await publicKeyFingerprint(
						unb64(ownerKey.publicKey),
					),
				},
			),
		).toEqual(wdk);
	});

	test("is idempotent and never mints v2", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(body, ownerCookie)).status).toBe(200);

		const again = await provision(body, ownerCookie);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({
			workspaceId: PERSONAL,
			version: 1,
			outcome: "already",
		});
		expect(await workspaceKeys(PERSONAL)).toHaveLength(1);
		expect(await membershipKeys(owner, PERSONAL)).toHaveLength(1);
	});

	test("two concurrent mints produce exactly one v1, and the loser is told", async () => {
		const first = await mint(PERSONAL, ownerKey, owner);
		const second = await mint(PERSONAL, ownerKey, owner);
		expect(second.body.commitment).not.toBe(first.body.commitment);

		const [a, b] = await Promise.all([
			provision(first.body, ownerCookie),
			provision(second.body, ownerCookie),
		]);
		expect([a.status, b.status]).toEqual([200, 200]);
		const outcomes = [await a.json(), await b.json()].map((r) => r.outcome);
		expect(outcomes.filter((o) => o === "minted")).toHaveLength(1);
		expect(outcomes.filter((o) => o === "exists")).toHaveLength(1);

		// One key universe. Two v1 rows is the fork design 4.2 exists to stop;
		// two grants under different commitments is the same fork one table down.
		const keys = await workspaceKeys(PERSONAL);
		expect(keys).toHaveLength(1);
		expect([first.body.commitment, second.body.commitment]).toContain(
			keys[0]?.commitment,
		);
		expect(await membershipKeys(owner, PERSONAL)).toHaveLength(1);
	});

	test("the loser's grant is not written under the winner's commitment", async () => {
		const winner = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(winner.body, ownerCookie)).status).toBe(200);

		const loser = await mint(PERSONAL, ownerKey, owner);
		const response = await provision(loser.body, ownerCookie);
		expect(await response.json()).toEqual({
			workspaceId: PERSONAL,
			version: 1,
			outcome: "exists",
		});
		// The loser's ciphertext wraps a DIFFERENT WDK. Writing it as the owner's
		// grant would leave the row pinned by one commitment and openable to
		// another key -- the fork, arrived at by a retry instead of a race.
		const grants = await membershipKeys(owner, PERSONAL);
		expect(grants).toHaveLength(1);
		expect(
			await openWdk(
				{
					enc: unb64(grants[0]?.enc as string),
					ciphertext: unb64(grants[0]?.ciphertext as string),
				},
				await importRecipientPrivateKey(ownerKey.privateKey),
				{
					workspaceId: PERSONAL,
					keyVersion: 1,
					recipientUserId: owner,
					recipientFingerprint: await publicKeyFingerprint(
						unb64(ownerKey.publicKey),
					),
				},
			),
		).toEqual(winner.wdk);
	});

	test("an interrupted provision is repaired without minting v2", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(body, ownerCookie)).status).toBe(200);
		// The half-written state: the key row survived, the owner's grant did
		// not. The client still holds the WDK, so resubmitting the SAME
		// commitment is a repair rather than a second mint.
		await pool.query("delete from membership_key where workspace_id = $1", [
			PERSONAL,
		]);

		const response = await provision(body, ownerCookie);
		expect(await response.json()).toEqual({
			workspaceId: PERSONAL,
			version: 1,
			outcome: "repaired",
		});
		expect(await workspaceKeys(PERSONAL)).toHaveLength(1);
		expect(await membershipKeys(owner, PERSONAL)).toHaveLength(1);
	});

	test("a Member cannot mint", async () => {
		const memberKey = await newIdentity();
		expect((await enroll(memberKey, memberCookie)).status).toBe(200);
		const { body } = await mint(SHARED, memberKey, member);
		const response = await provision(body, memberCookie);
		expect(response.status).toBe(403);
		expect(await workspaceKeys(SHARED)).toEqual([]);
	});

	test("a non-member cannot mint", async () => {
		const strangerKey = await newIdentity();
		expect((await enroll(strangerKey, strangerCookie)).status).toBe(200);
		const { body } = await mint(SHARED, strangerKey, stranger);
		const response = await provision(body, strangerCookie);
		expect(response.status).toBe(403);
		expect(await workspaceKeys(SHARED)).toEqual([]);
	});

	test("an unenrolled caller cannot mint", async () => {
		await pool.query("delete from user_key where user_id = $1", [owner]);
		const { body } = await mint(PERSONAL, ownerKey, owner);
		const response = await provision(body, ownerCookie);
		// The grant records the public key it is addressed to, and the server
		// has none to record. Accepting the caller's word for it would let a
		// grant name a key the recipient never enrolled.
		expect(response.status).toBe(409);
		expect(await workspaceKeys(PERSONAL)).toEqual([]);
	});

	test("refuses a commitment the client did not compute in a known format", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		// Each is malformed for a different reason: empty, no separator,
		// unregistered version, and a registered version whose digest is not the
		// 64 lowercase hex characters v1 declares.
		for (const commitment of [
			"",
			"not-a-commitment",
			"9.abc",
			"1.zz",
			"01.aa",
		]) {
			const response = await provision({ ...body, commitment }, ownerCookie);
			expect(response.status, commitment).toBe(400);
		}
		expect(await workspaceKeys(PERSONAL)).toEqual([]);
	});

	test("requires a session", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(body)).status).toBe(401);
	});

	test("refuses a foreign origin", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect(
			(await provision(body, ownerCookie, "https://evil.test")).status,
		).toBe(403);
	});

	test("is absent while the feature flag is off", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		process.env.DITERO_E2E_ENABLED = "false";
		expect((await provision(body, ownerCookie)).status).toBe(404);
		expect(await workspaceKeys(PERSONAL)).toEqual([]);
	});
});

describe("GET /api/e2e/provision/pending", () => {
	test("enumerates every workspace the caller owns, not just one", async () => {
		const response = await pending(ownerCookie);
		expect(response.status).toBe(200);
		const body = await response.json();
		// An account that predates E2E owns several workspaces. Provisioning one
		// and calling it done leaves the rest permanently keyless, and nothing
		// later notices until a file will not encrypt.
		expect(body.workspaces.map((w: { id: string }) => w.id).sort()).toEqual(
			[PERSONAL, SHARED, SHARED_2].sort(),
		);
		expect(
			body.workspaces.every((w: { reason: string }) => w.reason === "no-key"),
		).toBe(true);
	});

	test("drops a workspace once it is fully provisioned", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(body, ownerCookie)).status).toBe(200);

		const listed = (await (await pending(ownerCookie)).json()).workspaces;
		expect(listed.map((w: { id: string }) => w.id).sort()).toEqual(
			[SHARED, SHARED_2].sort(),
		);
	});

	test("reports a workspace whose key exists but whose grant is missing", async () => {
		const { body } = await mint(PERSONAL, ownerKey, owner);
		expect((await provision(body, ownerCookie)).status).toBe(200);
		await pool.query("delete from membership_key where workspace_id = $1", [
			PERSONAL,
		]);

		const listed = (await (await pending(ownerCookie)).json()).workspaces;
		const entry = listed.find((w: { id: string }) => w.id === PERSONAL);
		// Distinguished from no-key because the client's response differs: it
		// must resubmit the commitment it already holds, not mint a new WDK.
		expect(entry).toEqual({
			id: PERSONAL,
			version: 1,
			reason: "no-grant",
			commitment: body.commitment,
		});
	});

	test("omits workspaces the caller may not mint for", async () => {
		const listed = (await (await pending(memberCookie)).json()).workspaces;
		// The presence half is the member's OWN personal workspace, which they
		// own and may mint for. SHARED, where they are only a Member, is absent:
		// listing it would put a 403 at the end of a list the server handed out.
		expect(listed.map((w: { id: string }) => w.id)).toEqual([MEMBER_PERSONAL]);
	});

	test("requires a session and rejects a foreign origin", async () => {
		expect((await pending()).status).toBe(401);
		expect((await pending(ownerCookie, "https://evil.test")).status).toBe(403);
	});

	test("is absent while the feature flag is off", async () => {
		process.env.DITERO_E2E_ENABLED = "false";
		expect((await pending(ownerCookie)).status).toBe(404);
	});
});
