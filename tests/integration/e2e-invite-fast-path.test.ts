import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import {
	claimFastInvite,
	finalizeFastInvite,
} from "../../src/auth/invite-fast-path.ts";
import { withRegistrationBypass } from "../../src/auth/registration-bypass.ts";
import {
	generateIdentityKeyPair,
	importRecipientPublicKey,
	publicKeyFingerprint,
	sealWdk,
} from "../../src/domain/e2e/hpke.ts";
import { CURRENT_KDF_VERSION } from "../../src/domain/e2e/kdf.ts";
import { commitWdk } from "../../src/domain/e2e/wdk-commitment.ts";
import { app } from "../../src/server/index.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const ORIGIN = "http://localhost:5173";
const WORKSPACE = "ws_invite_fast";
const WRAP = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";
const WDK = new Uint8Array(32).map((_, index) => (index * 19 + 7) & 0xff);

type Identity = { publicKey: string; privateKey: Uint8Array };

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const decode = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

async function identity(): Promise<Identity> {
	const pair = await generateIdentityKeyPair();
	return { publicKey: encode(pair.publicKey), privateKey: pair.privateKey };
}

async function signUp(email: string): Promise<string> {
	const response = await withRegistrationBypass(() =>
		handleAuthRequest(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({ name: "Invite", email, password: "pw-123456" }),
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
	init: { body?: unknown; cookie?: string } = {},
) {
	const headers: Record<string, string> = { origin: ORIGIN };
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

const enroll = (key: Identity, cookie: string) =>
	call("POST", "/api/e2e/enroll", {
		cookie,
		body: {
			publicKey: key.publicKey,
			passphraseWrapped: WRAP,
			recoveryWrapped: WRAP,
			passphraseSalt: SALT,
			recoverySalt: SALT,
			formatVersion: CURRENT_KDF_VERSION,
		},
	});

async function sealedFor(key: Identity, userId: string) {
	const sealed = await sealWdk(
		WDK,
		await importRecipientPublicKey(decode(key.publicKey)),
		{
			workspaceId: WORKSPACE,
			keyVersion: 1,
			recipientUserId: userId,
			recipientFingerprint: await publicKeyFingerprint(decode(key.publicKey)),
		},
	);
	return { enc: encode(sealed.enc), ciphertext: encode(sealed.ciphertext) };
}

let ownerCookie: string;
let newcomerCookie: string;
let strangerCookie: string;
let ownerId: string;
let newcomerId: string;
let strangerId: string;
let newcomerEmail: string;
let newcomerKey: Identity;
let expiresAt: Date;
let seq = 0;

async function makeInvite(token: string, ttlMinutes = 10): Promise<string> {
	const id = `inv_${token}`;
	expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
	await pool.query(
		`insert into invite (id, workspace_id, token, role, email, status,
		 expires_at, max_uses, uses, created_by)
		 values ($1, $2, $3, 'member', $4, 'pending', $5, 1, 0, $6)`,
		[id, WORKSPACE, token, newcomerEmail, expiresAt, ownerId],
	);
	return id;
}

async function claim(token: string, cookie = newcomerCookie) {
	return call("POST", "/api/invite/claim", { cookie, body: { token } });
}

async function grant(token: string, requestId: string, key = newcomerKey) {
	return call("POST", "/api/invite/grant", {
		cookie: newcomerCookie,
		body: {
			token,
			requestId,
			recipientPublicKey: key.publicKey,
			...(await sealedFor(key, newcomerId)),
		},
	});
}

async function finalize(token: string, mode: "fast" | "fallback") {
	return call("POST", "/api/invite/finalize", {
		cookie: newcomerCookie,
		body: { token, mode },
	});
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	process.env.DITERO_E2E_ENABLED = "true";
	seq += 1;

	const stamp = `${Date.now()}-${seq}`;
	newcomerEmail = `fast-new-${stamp}@test.invalid`;
	ownerCookie = await signUp(`fast-owner-${stamp}@test.invalid`);
	newcomerCookie = await signUp(newcomerEmail);
	strangerCookie = await signUp(`fast-stranger-${stamp}@test.invalid`);
	const users = await pool.query<{ id: string; email: string }>(
		'select id, email from "user"',
	);
	ownerId = users.rows.find((row) => row.email.includes("owner"))?.id ?? "";
	newcomerId = users.rows.find((row) => row.email.includes("new"))?.id ?? "";
	strangerId =
		users.rows.find((row) => row.email.includes("stranger"))?.id ?? "";
	expect(ownerId && newcomerId && strangerId).toBeTruthy();

	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Fragment workspace', $2, 'shared')`,
		[WORKSPACE, ownerId],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role)
		 values ('m_fast_owner', $1, $2, 'owner')`,
		[ownerId, WORKSPACE],
	);

	const ownerKey = await identity();
	newcomerKey = await identity();
	expect((await enroll(ownerKey, ownerCookie)).status).toBe(200);
	const provision = await call("POST", "/api/e2e/provision", {
		cookie: ownerCookie,
		body: {
			workspaceId: WORKSPACE,
			commitment: await commitWdk(WDK, WORKSPACE, 1),
			...(await sealedFor(ownerKey, ownerId)),
		},
	});
	expect(provision.status).toBe(200);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("fragment invite state machine", () => {
	test("preview consumes and claims nothing", async () => {
		await makeInvite("preview");
		const response = await call("GET", "/api/invite/preview?token=preview");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ valid: true });
		const row = await pool.query(
			"select uses, status, claimed_by from invite where token = $1",
			["preview"],
		);
		expect(row.rows[0]).toEqual({
			uses: 0,
			status: "pending",
			claimed_by: null,
		});
	});

	test("claim reserves once, creates the fallback request, and is idempotent", async () => {
		const inviteId = await makeInvite("claim");
		const first = await claim("claim");
		expect(first.status).toBe(200);
		const body = (await first.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			inviteId,
			workspaceId: WORKSPACE,
			userId: newcomerId,
			intendedEmail: newcomerEmail,
			keyVersion: 1,
			grantState: "pending",
		});
		expect(body.expiresAt).toBe(expiresAt.toISOString());
		expect(typeof body.commitment).toBe("string");
		expect(typeof body.grantRequestId).toBe("string");

		const second = await claim("claim");
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(body);

		const invite = await pool.query(
			"select uses, status, claimed_by from invite where token = $1",
			["claim"],
		);
		expect(invite.rows[0]).toEqual({
			uses: 0,
			status: "pending",
			claimed_by: newcomerId,
		});
		const seats = await pool.query(
			"select 1 from membership where user_id = $1 and workspace_id = $2",
			[newcomerId, WORKSPACE],
		);
		expect(seats.rowCount).toBe(1);
		const requests = await pool.query(
			"select state from key_grant_request where user_id = $1 and workspace_id = $2",
			[newcomerId, WORKSPACE],
		);
		expect(requests.rows).toEqual([{ state: "key_pending" }]);
	});

	test("persists the self-grant before finalize consumes the invite", async () => {
		await makeInvite("complete");
		const claimed = (await (await claim("complete")).json()) as {
			grantRequestId: string;
		};
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		expect((await grant("complete", claimed.grantRequestId)).status).toBe(200);

		const before = await pool.query(
			"select status, uses from invite where token = 'complete'",
		);
		expect(before.rows[0]).toEqual({ status: "pending", uses: 0 });
		const stored = await pool.query(
			`select r.state from membership_key mk
			 join key_grant_request r on r.membership_id = mk.membership_id
			  and r.requested_version = mk.key_version
			 where mk.user_id = $1 and mk.workspace_id = $2`,
			[newcomerId, WORKSPACE],
		);
		expect(stored.rows).toEqual([{ state: "ready" }]);

		const finished = await finalize("complete", "fast");
		expect(finished.status).toBe(200);
		expect(await finished.json()).toEqual({ workspaceId: WORKSPACE });
		const after = await pool.query(
			"select status, uses from invite where token = 'complete'",
		);
		expect(after.rows[0]).toEqual({ status: "accepted", uses: 1 });
		const resumed = await claim("complete");
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toMatchObject({
			workspaceId: WORKSPACE,
			grantState: "ready",
		});
	});

	test("returns only the caller's workspace-key wraps", async () => {
		await makeInvite("own-wrap");
		const claimed = (await (await claim("own-wrap")).json()) as {
			grantRequestId: string;
		};
		expect((await enroll(newcomerKey, newcomerCookie)).status).toBe(200);
		expect((await grant("own-wrap", claimed.grantRequestId)).status).toBe(200);

		const mine = await call("GET", "/api/e2e/keys/mine", {
			cookie: newcomerCookie,
		});
		expect(mine.status).toBe(200);
		const body = (await mine.json()) as { keys: unknown[] };
		expect(body.keys).toEqual([
			expect.objectContaining({
				workspaceId: WORKSPACE,
				keyVersion: 1,
				recipientPublicKey: newcomerKey.publicKey,
				active: true,
				requestId: claimed.grantRequestId,
			}),
		]);
		expect(body.keys[0]).toHaveProperty("commitment");
		expect(body.keys[0]).toHaveProperty("enc");
		expect(body.keys[0]).toHaveProperty("ciphertext");

		const stranger = await call("GET", "/api/e2e/keys/mine", {
			cookie: strangerCookie,
		});
		expect(stranger.status).toBe(200);
		expect(await stranger.json()).toEqual({ keys: [] });
	});

	test("lets a member idempotently request the active workspace key", async () => {
		await pool.query(
			`insert into notification_channel (id, user_id, kind, config, enabled)
			 values ('ch_fast_request', $1, 'ntfy', $2, true)`,
			[ownerId, JSON.stringify({ topicUrl: "https://ntfy.test/request" })],
		);
		await makeInvite("request");
		const claimed = (await (await claim("request")).json()) as {
			grantRequestId: string;
		};
		const requested = await call("POST", "/api/e2e/grants/request", {
			cookie: newcomerCookie,
			body: { workspaceId: WORKSPACE },
		});
		expect(requested.status).toBe(200);
		expect(await requested.json()).toEqual({
			requestId: claimed.grantRequestId,
			keyVersion: 1,
			state: "pending",
		});
		expect(
			(
				await call("POST", "/api/e2e/grants/request", {
					cookie: strangerCookie,
					body: { workspaceId: WORKSPACE },
				})
			).status,
		).toBe(404);
		const outbox = await pool.query(
			`select recipient_user_id, payload->>'kind' as kind
			 from notification_outbox`,
		);
		expect(outbox.rows).toEqual([
			{ recipient_user_id: ownerId, kind: "key_grant" },
		]);
	});

	test("refuses a fast finalize before the grant is durable", async () => {
		await makeInvite("early");
		await claim("early");
		const response = await finalize("early", "fast");
		expect(response.status).toBe(409);
		const invite = await pool.query(
			"select status, uses from invite where token = 'early'",
		);
		expect(invite.rows[0]).toEqual({ status: "pending", uses: 0 });
		const request = await pool.query(
			"select state from key_grant_request where user_id = $1 and workspace_id = $2",
			[newcomerId, WORKSPACE],
		);
		expect(request.rows).toEqual([{ state: "key_pending" }]);
	});

	test("fallback finalizes while preserving the asynchronous request", async () => {
		await pool.query(
			`insert into notification_channel (id, user_id, kind, config, enabled)
			 values ('ch_fast_fallback', $1, 'ntfy', $2, true)`,
			[ownerId, JSON.stringify({ topicUrl: "https://ntfy.test/fast" })],
		);
		await makeInvite("fallback");
		await claim("fallback");
		const response = await finalize("fallback", "fallback");
		expect(response.status).toBe(200);
		const invite = await pool.query(
			"select status, uses from invite where token = 'fallback'",
		);
		expect(invite.rows[0]).toEqual({ status: "accepted", uses: 1 });
		const request = await pool.query(
			"select state from key_grant_request where user_id = $1 and workspace_id = $2",
			[newcomerId, WORKSPACE],
		);
		expect(request.rows).toEqual([{ state: "key_pending" }]);
		const outbox = await pool.query(
			`select recipient_user_id, payload->>'kind' as kind
			 from notification_outbox`,
		);
		expect(outbox.rows).toEqual([
			{ recipient_user_id: ownerId, kind: "key_grant" },
		]);
	});

	test("a claim made before expiry can still fall back after expiry", async () => {
		await makeInvite("expires-after-claim");
		await claim("expires-after-claim");
		await expect(
			claimFastInvite(
				pool,
				"expires-after-claim",
				newcomerId,
				newcomerEmail,
				new Date(expiresAt.getTime() + 1),
			),
		).resolves.toMatchObject({
			workspaceId: WORKSPACE,
			grantState: "pending",
		});
		await expect(
			finalizeFastInvite(
				pool,
				"expires-after-claim",
				newcomerId,
				"fallback",
				new Date(expiresAt.getTime() + 1),
			),
		).resolves.toMatchObject({ workspaceId: WORKSPACE });
		const row = await pool.query(
			"select status, uses from invite where token = 'expires-after-claim'",
		);
		expect(row.rows[0]).toEqual({ status: "accepted", uses: 1 });
	});

	test("a different user cannot use the claim or self-grant seam", async () => {
		await makeInvite("foreign");
		const claimed = (await (await claim("foreign")).json()) as {
			grantRequestId: string;
		};
		expect((await claim("foreign", strangerCookie)).status).toBe(403);
		const response = await call("POST", "/api/invite/grant", {
			cookie: strangerCookie,
			body: {
				token: "foreign",
				requestId: claimed.grantRequestId,
				recipientPublicKey: newcomerKey.publicKey,
				...(await sealedFor(newcomerKey, newcomerId)),
			},
		});
		expect(response.status).toBe(404);
	});

	test("a long-lived invite is not eligible for the fragment claim", async () => {
		await makeInvite("long", 24 * 60);
		const response = await claim("long");
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("not_fast_eligible");
		const accepted = await call("POST", "/api/invite/accept", {
			cookie: newcomerCookie,
			body: { token: "long" },
		});
		expect(accepted.status).toBe(200);
	});
});
