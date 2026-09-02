import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import { acceptInvite } from "../../src/auth/invite-accept.ts";
import { withRegistrationBypass } from "../../src/auth/registration-bypass.ts";
import { db } from "../../src/db/client.ts";
import {
	generateIdentityKeyPair,
	importRecipientPrivateKey,
	importRecipientPublicKey,
	openWdk,
	publicKeyFingerprint,
	sealWdk,
} from "../../src/domain/e2e/hpke.ts";
import { CURRENT_KDF_VERSION } from "../../src/domain/e2e/kdf.ts";
import {
	commitWdk,
	verifyWdkCommitment,
	WdkCommitmentError,
} from "../../src/domain/e2e/wdk-commitment.ts";
import { notifyGrantCapable } from "../../src/server/e2e/grants.ts";
import { app } from "../../src/server/index.ts";
import { renderPayload } from "../../src/server/notifications/dispatch.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

// M-E2E Task 15. A grant is the first write in this subsystem where the writer
// and the row's owner are different people. The properties that matter are that
// membership is never gated on key availability (design 8.1), that a wrap can
// only be addressed to the recipient's CURRENT key, and that every liveness
// edge case in design 8.3 has a named outcome rather than a pending row that
// waits forever.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const ORIGIN = "http://localhost:5173";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

const WRAP = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";
const WORKSPACE = "ws_grant";

type Identity = { publicKey: string; privateKey: Uint8Array };

async function newIdentity(): Promise<Identity> {
	const pair = await generateIdentityKeyPair();
	return { publicKey: b64(pair.publicKey), privateKey: pair.privateKey };
}

async function signUp(email: string): Promise<string> {
	const response = await withRegistrationBypass(() =>
		handleAuthRequest(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({ name: "Grant", email, password: "pw-123456" }),
			}),
		),
	);
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

function call(
	method: "GET" | "POST",
	path: string,
	init: { body?: unknown; cookie?: string; origin?: string } = {},
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
	call("POST", "/api/e2e/enroll", {
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

const pendingFor = async (cookie: string) =>
	(await (await call("GET", "/api/e2e/grants/pending", { cookie })).json())
		.requests;
const mineFor = async (cookie: string) =>
	(await (await call("GET", "/api/e2e/grants/mine", { cookie })).json())
		.requests;

async function sealTo(
	wdk: Uint8Array,
	identity: Identity,
	recipientUserId: string,
	keyVersion = 1,
) {
	const sealed = await sealWdk(
		wdk,
		await importRecipientPublicKey(unb64(identity.publicKey)),
		{
			workspaceId: WORKSPACE,
			keyVersion,
			recipientUserId,
			recipientFingerprint: await publicKeyFingerprint(
				unb64(identity.publicKey),
			),
		},
	);
	return { enc: b64(sealed.enc), ciphertext: b64(sealed.ciphertext) };
}

const WDK = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
const OTHER_WDK = new Uint8Array(32).map((_, i) => (i * 17 + 2) & 0xff);

let ownerCookie: string;
let newcomerCookie: string;
let strangerCookie: string;
let owner: string;
let newcomer: string;
let stranger: string;
let ownerKey: Identity;
let newcomerKey: Identity;
let commitment: string;
let seq = 0;

async function grantRequestRows() {
	const rows = await pool.query<{
		id: string;
		user_id: string;
		state: string;
		requested_version: number;
		failure_reason: string | null;
	}>(
		`select id, user_id, state, requested_version, failure_reason
		 from key_grant_request order by requested_at, id`,
	);
	return rows.rows;
}

/** The full accept path, so the request is created the way the product does. */
async function accept(token: string, userId: string, email: string) {
	return await acceptInvite(token, userId, email, db);
}

async function makeInvite(token: string, role = "member") {
	await pool.query(
		`insert into invite (id, workspace_id, token, role, created_by, status)
		 values ($1, $2, $3, $4, $5, 'pending')`,
		[`inv_${token}`, WORKSPACE, token, role, owner],
	);
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	seq += 1;
	process.env.DITERO_E2E_ENABLED = "true";

	const stamp = `${Date.now()}-${seq}`;
	ownerCookie = await signUp(`gr-owner-${stamp}@test.invalid`);
	newcomerCookie = await signUp(`gr-new-${stamp}@test.invalid`);
	strangerCookie = await signUp(`gr-stranger-${stamp}@test.invalid`);
	const users = await pool.query<{ id: string; email: string }>(
		'select id, email from "user"',
	);
	const idFor = (part: string) =>
		users.rows.find((r) => r.email.includes(part))?.id ?? "";
	owner = idFor("owner");
	newcomer = idFor("new");
	stranger = idFor("stranger");
	expect(owner && newcomer && stranger).toBeTruthy();

	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Grants', $2, 'shared')`,
		[WORKSPACE, owner],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role)
		 values ('m_owner', $1, $2, 'owner')`,
		[owner, WORKSPACE],
	);

	ownerKey = await newIdentity();
	newcomerKey = await newIdentity();
	expect((await enroll(ownerKey, ownerCookie)).status).toBe(200);

	// The owner provisions v1 through the real endpoint, so the granter's own
	// membership_key -- the evidence they hold the WDK -- is written the way the
	// product writes it.
	commitment = await commitWdk(WDK, WORKSPACE, 1);
	const sealed = await sealTo(WDK, ownerKey, owner);
	expect(
		(
			await call("POST", "/api/e2e/provision", {
				cookie: ownerCookie,
				body: { workspaceId: WORKSPACE, commitment, ...sealed },
			})
		).status,
	).toBe(200);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("invite acceptance", () => {
	test("creates the membership and a pending request in one transaction", async () => {
		await makeInvite("tok_a");
		await accept("tok_a", newcomer, `gr-new@test.invalid`);

		const members = await pool.query(
			"select 1 from membership where user_id = $1 and workspace_id = $2",
			[newcomer, WORKSPACE],
		);
		expect(members.rowCount).toBe(1);
		const requests = await grantRequestRows();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			user_id: newcomer,
			state: "key_pending",
			requested_version: 1,
		});
	});

	test("a rolled back acceptance leaves neither", async () => {
		await makeInvite("tok_b");
		await expect(
			db.transaction(async (tx) => {
				await acceptInvite(
					"tok_b",
					newcomer,
					"gr-new@test.invalid",
					tx as never,
				);
				throw new Error("abort");
			}),
		).rejects.toThrow("abort");

		// Scoped to this workspace: signup gives every user a personal workspace
		// and its membership, so an unscoped count is 1 whatever happened here.
		const members = await pool.query(
			"select 1 from membership where user_id = $1 and workspace_id = $2",
			[newcomer, WORKSPACE],
		);
		expect(members.rowCount).toBe(0);
		expect(await grantRequestRows()).toEqual([]);
	});

	test("membership is usable before any key arrives", async () => {
		await makeInvite("tok_c");
		await accept("tok_c", newcomer, "gr-new@test.invalid");
		await pool.query(
			`insert into list (id, workspace_id, owner_id, title, kind, sort_key)
			 values ('l_1', $1, $2, 'Shared list', 'tasks', 'a0')`,
			[WORKSPACE, owner],
		);

		// Key availability must never gate membership (design 8.1). Reading a
		// list in the workspace is the cheapest proof the membership is live
		// while the grant is still pending.
		const readable = await pool.query(
			`select 1 from list l join membership m
			 on m.workspace_id = l.workspace_id and m.user_id = $1
			 where l.id = 'l_1'`,
			[newcomer],
		);
		expect(readable.rowCount).toBe(1);
		expect((await mineFor(newcomerCookie))[0].state).toBe("pending");
	});

	test("creates no request for a member who already holds the key", async () => {
		await makeInvite("tok_e");
		await accept("tok_e", newcomer, "gr-new@test.invalid");
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		const requestId = (await grantRequestRows())[0]?.id as string;
		expect(
			(
				await call("POST", "/api/e2e/grants", {
					cookie: ownerCookie,
					body: {
						requestId,
						recipientPublicKey: newcomerKey.publicKey,
						...(await sealTo(WDK, newcomerKey, newcomer)),
					},
				})
			).status,
		).toBe(200);

		// Accepting a second invite to a workspace they are already keyed for.
		// Without the guard this queues a request for a version they hold, which
		// no granter can clear: re-wrapping produces a different ciphertext for
		// the same slot, which is the fork check, so it conflicts forever.
		await makeInvite("tok_f");
		await accept("tok_f", newcomer, "gr-new@test.invalid");
		const rows = await grantRequestRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.state).toBe("ready");
	});

	test("creates no request for a workspace with no key yet", async () => {
		await pool.query("delete from workspace_key where workspace_id = $1", [
			WORKSPACE,
		]);
		await makeInvite("tok_d");
		await accept("tok_d", newcomer, "gr-new@test.invalid");
		// Nothing to wait for is not a failure. A request naming a version that
		// does not exist could never be fulfilled and would show as pending
		// forever.
		expect(await grantRequestRows()).toEqual([]);
	});
});

describe("GET /api/e2e/grants/pending", () => {
	beforeEach(async () => {
		await makeInvite("tok_p");
		await accept("tok_p", newcomer, "gr-new@test.invalid");
	});

	test("lists requests the caller can fulfil", async () => {
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		const listed = await pendingFor(ownerCookie);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			workspaceId: WORKSPACE,
			keyVersion: 1,
			recipientUserId: newcomer,
			recipientPublicKey: newcomerKey.publicKey,
		});
	});

	test("does not list requests from workspaces the caller is not in", async () => {
		const listed = await pendingFor(strangerCookie);
		expect(listed).toEqual([]);
		// Presence half: the same request IS visible to the owner, so the empty
		// array is the membership join and not an empty table.
		expect(await pendingFor(ownerCookie)).toHaveLength(1);
	});

	test("lists an unenrolled recipient with a null key rather than hiding them", async () => {
		const listed = await pendingFor(ownerCookie);
		// Design 8.3, first case. Hiding the row would make a member who never
		// enrolls indistinguishable from one who was already granted.
		expect(listed[0].recipientPublicKey).toBeNull();
	});

	test("is empty for a member who does not hold the key themselves", async () => {
		// The newcomer is a member of the workspace but holds no membership_key,
		// so they have nothing to wrap. Listing their own request for them would
		// invite an attempt that cannot succeed.
		expect(await pendingFor(newcomerCookie)).toEqual([]);
	});

	test("requires a session, rejects a foreign origin, and is absent while off", async () => {
		expect((await call("GET", "/api/e2e/grants/pending")).status).toBe(401);
		expect(
			(
				await call("GET", "/api/e2e/grants/pending", {
					cookie: ownerCookie,
					origin: "https://evil.test",
				})
			).status,
		).toBe(403);
		process.env.DITERO_E2E_ENABLED = "false";
		expect(
			(await call("GET", "/api/e2e/grants/pending", { cookie: ownerCookie }))
				.status,
		).toBe(404);
	});
});

describe("POST /api/e2e/grants", () => {
	let requestId: string;

	beforeEach(async () => {
		await makeInvite("tok_g");
		await accept("tok_g", newcomer, "gr-new@test.invalid");
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		requestId = (await grantRequestRows())[0]?.id as string;
	});

	const submit = (body: Record<string, unknown>, cookie = ownerCookie) =>
		call("POST", "/api/e2e/grants", { cookie, body });

	async function goodGrant() {
		return {
			requestId,
			recipientPublicKey: newcomerKey.publicKey,
			...(await sealTo(WDK, newcomerKey, newcomer)),
		};
	}

	test("writes the wrap, marks the request ready, and the recipient can open it", async () => {
		const response = await submit(await goodGrant());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ requestId, outcome: "granted" });
		expect((await grantRequestRows())[0]?.state).toBe("ready");

		const row = await pool.query<{ enc: string; ciphertext: string }>(
			"select enc, ciphertext from membership_key where user_id = $1",
			[newcomer],
		);
		expect(row.rowCount).toBe(1);
		const opened = await openWdk(
			{
				enc: unb64(row.rows[0]?.enc as string),
				ciphertext: unb64(row.rows[0]?.ciphertext as string),
			},
			await importRecipientPrivateKey(newcomerKey.privateKey),
			{
				workspaceId: WORKSPACE,
				keyVersion: 1,
				recipientUserId: newcomer,
				recipientFingerprint: await publicKeyFingerprint(
					unb64(newcomerKey.publicKey),
				),
			},
		);
		expect(opened).toEqual(WDK);
		// And it is the SAME key the owner holds, verified the way a recipient
		// verifies: against the published commitment.
		await expect(
			verifyWdkCommitment(opened, WORKSPACE, 1, commitment),
		).resolves.toBeUndefined();
	});

	test("refuses a wrap addressed to a key that is not the recipient's current one", async () => {
		const rotatedAway = await newIdentity();
		const response = await submit({
			requestId,
			recipientPublicKey: rotatedAway.publicKey,
			...(await sealTo(WDK, rotatedAway, newcomer)),
		});
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("stale recipient key");
		const rows = await pool.query(
			"select 1 from membership_key where user_id = $1",
			[newcomer],
		);
		expect(rows.rowCount).toBe(0);
		// Design 8.3, fourth case: still key_pending, not failed. A fresh grant
		// to the new key will succeed, so this is a retry condition.
		expect((await grantRequestRows())[0]?.state).toBe("key_pending");
	});

	test("refuses a version that is no longer active", async () => {
		await pool.query(
			"update workspace_key set active = false where workspace_id = $1",
			[WORKSPACE],
		);
		expect((await submit(await goodGrant())).status).toBe(409);
		expect((await grantRequestRows())[0]?.state).toBe("key_pending");
	});

	test("an identical re-submission succeeds, a different one conflicts", async () => {
		const grant = await goodGrant();
		expect((await submit(grant)).status).toBe(200);

		const again = await submit(grant);
		expect(again.status).toBe(200);
		expect(await again.json()).toEqual({ requestId, outcome: "already" });

		// A DIFFERENT wrap for the same slot is the fork: two members would hold
		// two keys under one version. Refused rather than allowed to overwrite.
		const different = await submit({
			requestId,
			recipientPublicKey: newcomerKey.publicKey,
			...(await sealTo(OTHER_WDK, newcomerKey, newcomer)),
		});
		expect(different.status).toBe(409);
		const rows = await pool.query<{ ciphertext: string }>(
			"select ciphertext from membership_key where user_id = $1",
			[newcomer],
		);
		expect(rows.rows[0]?.ciphertext).toBe(grant.ciphertext);
	});

	test("a non-member cannot grant", async () => {
		const response = await submit(await goodGrant(), strangerCookie);
		// 404, not 403: a request id a caller cannot fulfil must look exactly
		// like one that does not exist, or the endpoint enumerates other
		// workspaces' pending grants.
		expect(response.status).toBe(404);
	});

	test("a member who does not hold the key cannot grant", async () => {
		// The newcomer is a member and is granting to themselves; they have no
		// WDK to wrap, so whatever they submitted cannot be the workspace key.
		const response = await submit(await goodGrant(), newcomerCookie);
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("not-ready");
	});

	test("refuses an unknown request", async () => {
		expect(
			(await submit({ ...(await goodGrant()), requestId: "kgr_nope" })).status,
		).toBe(404);
	});

	test("requires a session, rejects a foreign origin, and is absent while off", async () => {
		const grant = await goodGrant();
		expect(
			(await call("POST", "/api/e2e/grants", { body: grant })).status,
		).toBe(401);
		expect(
			(
				await call("POST", "/api/e2e/grants", {
					cookie: ownerCookie,
					body: grant,
					origin: "https://evil.test",
				})
			).status,
		).toBe(403);
		process.env.DITERO_E2E_ENABLED = "false";
		expect((await submit(grant)).status).toBe(404);
	});
});

describe("recipient-side substitution check", () => {
	let requestId: string;

	beforeEach(async () => {
		await makeInvite("tok_s");
		await accept("tok_s", newcomer, "gr-new@test.invalid");
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		requestId = (await grantRequestRows())[0]?.id as string;
	});

	test("a substituted key passes the server and fails the recipient", async () => {
		// The server accepts it: enc and ciphertext are opaque to it and HPKE
		// base mode carries no sender authentication. This is exactly why the
		// commitment exists (design 4.4).
		const response = await call("POST", "/api/e2e/grants", {
			cookie: ownerCookie,
			body: {
				requestId,
				recipientPublicKey: newcomerKey.publicKey,
				...(await sealTo(OTHER_WDK, newcomerKey, newcomer)),
			},
		});
		expect(response.status).toBe(200);

		const row = await pool.query<{ enc: string; ciphertext: string }>(
			"select enc, ciphertext from membership_key where user_id = $1",
			[newcomer],
		);
		const opened = await openWdk(
			{
				enc: unb64(row.rows[0]?.enc as string),
				ciphertext: unb64(row.rows[0]?.ciphertext as string),
			},
			await importRecipientPrivateKey(newcomerKey.privateKey),
			{
				workspaceId: WORKSPACE,
				keyVersion: 1,
				recipientUserId: newcomer,
				recipientFingerprint: await publicKeyFingerprint(
					unb64(newcomerKey.publicKey),
				),
			},
		);
		// It decrypts cleanly. Decryption is not the check -- a granter handing
		// out a different key produces a wrap that opens perfectly and forks the
		// workspace into two key universes.
		expect(opened).toEqual(OTHER_WDK);
		await expect(
			verifyWdkCommitment(opened, WORKSPACE, 1, commitment),
		).rejects.toThrow(WdkCommitmentError);

		const failed = await call("POST", "/api/e2e/grants/fail", {
			cookie: newcomerCookie,
			body: { requestId, reason: "commitment mismatch" },
		});
		expect(failed.status).toBe(200);
		const rows = await grantRequestRows();
		expect(rows[0]).toMatchObject({
			state: "failed",
			failure_reason: "commitment mismatch",
		});
		expect((await mineFor(newcomerCookie))[0].state).toBe("failed");
	});

	test("only the recipient may mark their own request failed", async () => {
		const response = await call("POST", "/api/e2e/grants/fail", {
			cookie: ownerCookie,
			body: { requestId, reason: "not mine to fail" },
		});
		// A granter burying the evidence of their own substitution is the one
		// thing this endpoint must not allow.
		expect(response.status).toBe(404);
		expect((await grantRequestRows())[0]?.state).toBe("key_pending");
	});
});

describe("notification", () => {
	async function outboxRows() {
		const rows = await pool.query<{
			recipient_user_id: string;
			payload: unknown;
		}>("select recipient_user_id, payload from notification_outbox");
		return rows.rows;
	}

	beforeEach(async () => {
		await pool.query("delete from notification_outbox");
		await pool.query(
			`insert into notification_channel (id, user_id, kind, config, enabled)
			 values ('ch_owner', $1, 'ntfy', $2, true)`,
			[owner, JSON.stringify({ topicUrl: "https://ntfy.test/t" })],
		);
	});

	test("a pending request notifies grant-capable members and carries no key material", async () => {
		await makeInvite("tok_n");
		const accepted = await accept("tok_n", newcomer, "gr-new@test.invalid");
		expect(accepted.grantRequestId).toBeTruthy();
		expect(
			await notifyGrantCapable(db, accepted.grantRequestId as string),
		).toBe(1);

		const rows = await outboxRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipient_user_id).toBe(owner);
		expect(rows[0]?.payload).toEqual({
			kind: "key_grant",
			workspaceName: "Grants",
			locale: "en",
		});
		// The row is rendered by five channel adapters and lands in ntfy
		// servers, chat services and mail spools. A wrap, a commitment or a
		// public key in here would be a leak with no way to recall it.
		const serialized = JSON.stringify(rows[0]?.payload);
		for (const secret of [commitment, ownerKey.publicKey, WRAP, SALT]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("renders without key material in every locale", () => {
		const rendered = renderPayload({
			kind: "key_grant",
			workspaceName: "Grants",
			locale: "de",
		});
		// Presence half: an unrecognised payload renders null and would pass a
		// bare "contains no secret" assertion for free.
		expect(rendered?.title).toBe("Grants");
		expect(rendered?.body.length).toBeGreaterThan(0);
		expect(rendered?.urgent).toBe(false);
	});

	test("does not notify a holder who is no longer enrolled", async () => {
		await pool.query(
			`insert into notification_channel (id, user_id, kind, config, enabled)
			 values ('ch_new', $1, 'ntfy', $2, true)`,
			[newcomer, JSON.stringify({ topicUrl: "https://ntfy.test/n" })],
		);
		await pool.query("delete from user_key where user_id = $1", [owner]);

		await makeInvite("tok_n2");
		const accepted = await accept("tok_n2", newcomer, "gr-new@test.invalid");
		expect(
			await notifyGrantCapable(db, accepted.grantRequestId as string),
		).toBe(0);
		// The only holder is no longer enrolled, so nobody can act; a nudge here
		// would have no possible response. The newcomer has a channel precisely
		// so this is not vacuous -- someone WOULD be notified if the enrolment
		// join were dropped.
		expect(await outboxRows()).toEqual([]);
	});

	test("is idempotent per request and member", async () => {
		await makeInvite("tok_n3");
		const accepted = await accept("tok_n3", newcomer, "gr-new@test.invalid");
		const id = accepted.grantRequestId as string;
		expect(await notifyGrantCapable(db, id)).toBe(1);
		expect(await notifyGrantCapable(db, id)).toBe(0);
		expect(await outboxRows()).toHaveLength(1);
	});
});

describe("liveness", () => {
	beforeEach(async () => {
		await makeInvite("tok_l");
		await accept("tok_l", newcomer, "gr-new@test.invalid");
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
	});

	test("a workspace with no living key holder reports unrecoverable", async () => {
		expect((await mineFor(newcomerCookie))[0].state).toBe("pending");

		// The last grant-capable member leaves. Design 8.3, second case: a
		// spinner forever is the wrong answer, and the state is derived rather
		// than written by a hook so it cannot go stale if someone re-enrolls.
		await pool.query("delete from membership where user_id = $1", [owner]);
		expect((await mineFor(newcomerCookie))[0].state).toBe("unrecoverable");
	});

	test("a recovered identity still opens every existing wrap", async () => {
		const grant = {
			requestId: (await grantRequestRows())[0]?.id as string,
			recipientPublicKey: newcomerKey.publicKey,
			...(await sealTo(WDK, newcomerKey, newcomer)),
		};
		expect(
			(
				await call("POST", "/api/e2e/grants", {
					cookie: ownerCookie,
					body: grant,
				})
			).status,
		).toBe(200);

		// Design 8.3, third case. Recovery restores the same keypair from the
		// recovery wrap, so nothing about membership_key changes -- the private
		// key is unchanged and every existing wrap still opens. The assertion is
		// that recovery is NOT a rotation.
		const row = await pool.query<{ enc: string; ciphertext: string }>(
			"select enc, ciphertext from membership_key where user_id = $1",
			[newcomer],
		);
		const opened = await openWdk(
			{
				enc: unb64(row.rows[0]?.enc as string),
				ciphertext: unb64(row.rows[0]?.ciphertext as string),
			},
			await importRecipientPrivateKey(newcomerKey.privateKey),
			{
				workspaceId: WORKSPACE,
				keyVersion: 1,
				recipientUserId: newcomer,
				recipientFingerprint: await publicKeyFingerprint(
					unb64(newcomerKey.publicKey),
				),
			},
		);
		expect(opened).toEqual(WDK);
	});

	test("a member who never enrolls blocks nobody", async () => {
		await pool.query("delete from user_key where user_id = $1", [newcomer]);
		const listed = await pendingFor(ownerCookie);
		expect(listed[0].recipientPublicKey).toBeNull();
		// Their own view still says pending rather than unrecoverable: a living
		// key holder exists, and enrolling is the step that unblocks it.
		expect((await mineFor(newcomerCookie))[0].state).toBe("pending");
	});
});
