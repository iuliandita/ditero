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
import { rotateWorkspace } from "../../src/server/e2e/rotation.ts";
import { app } from "../../src/server/index.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const ORIGIN = "http://localhost:5173";
const WORKSPACE = "ws_rotation";
const WRAP = "d3JhcHBlZC1ibG9i";
const SALT = "c2FsdA";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (value: string) =>
	new Uint8Array(Buffer.from(value, "base64url"));

type Identity = { publicKey: string; privateKey: Uint8Array };
type Actor = {
	userId: string;
	cookie: string;
	identity: Identity | null;
};
type Grant = {
	membershipId: string;
	userId: string;
	recipientPublicKey: string;
	enc: string;
	ciphertext: string;
};

const membershipIds = {
	owner: "rot_owner",
	admin: "rot_admin",
	member: "rot_member",
	removed: "rot_removed",
	unenrolled: "rot_unenrolled",
} as const;

let owner: Actor;
let admin: Actor;
let member: Actor;
let removed: Actor;
let unenrolled: Actor;
let stranger: Actor;
let v1: Uint8Array;
let seq = 0;

async function newIdentity(): Promise<Identity> {
	const pair = await generateIdentityKeyPair();
	return { publicKey: b64(pair.publicKey), privateKey: pair.privateKey };
}

async function signUp(label: string, stamp: string): Promise<Actor> {
	const email = `rotation-${label}-${stamp}@test.invalid`;
	const response = await withRegistrationBypass(() =>
		handleAuthRequest(
			new Request("http://localhost:3000/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN },
				body: JSON.stringify({ name: label, email, password: "pw-123456" }),
			}),
		),
	);
	expect(response.status).toBe(200);
	// This suite needs six independent sessions but does not exercise auth
	// throttling. Production permits five signups per source per minute, so leave
	// each signup ordinary and clear only the isolated fixture's rate bucket
	// before creating the next actor.
	await pool.query("delete from rate_limit");
	const cookie = response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
	const found = await pool.query<{ id: string }>(
		'select id from "user" where email = $1',
		[email],
	);
	return { userId: found.rows[0]?.id ?? "", cookie, identity: null };
}

function call(
	method: "GET" | "POST",
	path: string,
	init: { cookie?: string; body?: unknown } = {},
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

async function enroll(actor: Actor) {
	actor.identity = await newIdentity();
	const response = await call("POST", "/api/e2e/enroll", {
		cookie: actor.cookie,
		body: {
			publicKey: actor.identity.publicKey,
			passphraseWrapped: WRAP,
			recoveryWrapped: WRAP,
			passphraseSalt: SALT,
			recoverySalt: SALT,
			formatVersion: CURRENT_KDF_VERSION,
		},
	});
	expect(response.status).toBe(200);
}

async function sealFor(
	wdk: Uint8Array,
	actor: Actor,
	keyVersion: number,
): Promise<{ enc: string; ciphertext: string }> {
	const identity = actor.identity;
	if (!identity) throw new Error("test actor is not enrolled");
	const sealed = await sealWdk(
		wdk,
		await importRecipientPublicKey(unb64(identity.publicKey)),
		{
			workspaceId: WORKSPACE,
			keyVersion,
			recipientUserId: actor.userId,
			recipientFingerprint: await publicKeyFingerprint(
				unb64(identity.publicKey),
			),
		},
	);
	return { enc: b64(sealed.enc), ciphertext: b64(sealed.ciphertext) };
}

async function rotationBody(wdk: Uint8Array) {
	const grants: Grant[] = [];
	for (const [name, actor] of [
		["owner", owner],
		["admin", admin],
		["member", member],
	] as const) {
		const identity = actor.identity;
		if (!identity) throw new Error("test actor is not enrolled");
		grants.push({
			membershipId: membershipIds[name],
			userId: actor.userId,
			recipientPublicKey: identity.publicKey,
			...(await sealFor(wdk, actor, 2)),
		});
	}
	return {
		previousVersion: 1,
		commitment: await commitWdk(wdk, WORKSPACE, 2),
		grants,
	};
}

async function workspaceState() {
	const found = await pool.query<{ rotation_required: boolean }>(
		"select rotation_required from workspace where id = $1",
		[WORKSPACE],
	);
	return found.rows[0]?.rotation_required;
}

async function workspaceKeys() {
	return (
		await pool.query<{
			version: number;
			commitment: string;
			active: boolean;
		}>(
			`select version, commitment, active from workspace_key
			 where workspace_id = $1 order by version`,
			[WORKSPACE],
		)
	).rows;
}

async function membershipKeys() {
	return (
		await pool.query<{
			membership_id: string;
			user_id: string;
			key_version: number;
			enc: string;
			ciphertext: string;
		}>(
			`select membership_id, user_id, key_version, enc, ciphertext
			 from membership_key where workspace_id = $1
			 order by key_version, membership_id`,
			[WORKSPACE],
		)
	).rows;
}

async function openRow(
	row: {
		user_id: string;
		key_version: number;
		enc: string;
		ciphertext: string;
	},
	actor: Actor,
) {
	const identity = actor.identity;
	if (!identity) throw new Error("test actor is not enrolled");
	return await openWdk(
		{ enc: unb64(row.enc), ciphertext: unb64(row.ciphertext) },
		await importRecipientPrivateKey(identity.privateKey),
		{
			workspaceId: WORKSPACE,
			keyVersion: row.key_version,
			recipientUserId: row.user_id,
			recipientFingerprint: await publicKeyFingerprint(
				unb64(identity.publicKey),
			),
		},
	);
}

beforeEach(async () => {
	await pool.query("delete from membership");
	await pool.query("delete from workspace");
	await pool.query("delete from rate_limit");
	await pool.query("delete from session");
	await pool.query("delete from account");
	await pool.query('delete from "user"');
	process.env.DITERO_E2E_ENABLED = "true";
	seq += 1;
	const stamp = `${Date.now()}-${seq}`;
	owner = await signUp("owner", stamp);
	admin = await signUp("admin", stamp);
	member = await signUp("member", stamp);
	removed = await signUp("removed", stamp);
	unenrolled = await signUp("unenrolled", stamp);
	stranger = await signUp("stranger", stamp);

	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Rotation', $2, 'shared')`,
		[WORKSPACE, owner.userId],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ($1, $6, $11, 'owner'), ($2, $7, $11, 'admin'),
		 ($3, $8, $11, 'member'), ($4, $9, $11, 'member'),
		 ($5, $10, $11, 'viewer')`,
		[
			membershipIds.owner,
			membershipIds.admin,
			membershipIds.member,
			membershipIds.removed,
			membershipIds.unenrolled,
			owner.userId,
			admin.userId,
			member.userId,
			removed.userId,
			unenrolled.userId,
			WORKSPACE,
		],
	);

	await Promise.all([
		enroll(owner),
		enroll(admin),
		enroll(member),
		enroll(removed),
	]);
	v1 = crypto.getRandomValues(new Uint8Array(32));
	const provision = await call("POST", "/api/e2e/provision", {
		cookie: owner.cookie,
		body: {
			workspaceId: WORKSPACE,
			commitment: await commitWdk(v1, WORKSPACE, 1),
			...(await sealFor(v1, owner, 1)),
		},
	});
	expect(provision.status).toBe(200);

	for (const [name, actor] of [
		["admin", admin],
		["member", member],
		["removed", removed],
	] as const) {
		const identity = actor.identity;
		if (!identity) throw new Error("test actor is not enrolled");
		const sealed = await sealFor(v1, actor, 1);
		await pool.query(
			`insert into membership_key (id, membership_id, user_id, workspace_id,
			 key_version, enc, ciphertext, recipient_public_key, granted_by)
			 values ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
			[
				`mk_${name}_v1`,
				membershipIds[name],
				actor.userId,
				WORKSPACE,
				sealed.enc,
				sealed.ciphertext,
				identity.publicKey,
				owner.userId,
			],
		);
	}
	await pool.query(
		`insert into key_grant_request
		 (id, membership_id, user_id, workspace_id, requested_version)
		 values ('rot_unenrolled_v1', $1, $2, $3, 1)`,
		[membershipIds.unenrolled, unenrolled.userId, WORKSPACE],
	);

	await pool.query(
		`with removed as (
		 delete from membership where id = $1 returning workspace_id
		)
		update workspace w set rotation_required = true
		from removed where w.id = removed.workspace_id`,
		[membershipIds.removed],
	);
});

afterAll(async () => {
	process.env.DITERO_E2E_ENABLED = undefined;
	await pool.end();
});

describe("workspace removal rotation", () => {
	test("membership creation cannot cross rotation's workspace lock", async () => {
		// The membership.workspace_id FK takes a key-share lock on this row.
		// Rotation's FOR UPDATE conflicts with it, so an invite insert cannot land
		// between recipient enumeration and commit without a custom trigger.
		const locker = await pool.connect();
		const contender = await pool.connect();
		try {
			await locker.query("begin");
			await locker.query("select 1 from workspace where id = $1 for update", [
				WORKSPACE,
			]);
			await contender.query("begin");
			await contender.query("set local lock_timeout = '100ms'");
			await expect(
				contender.query(
					`insert into membership (id, user_id, workspace_id, role)
					 values ('rot_late', $1, $2, 'member')`,
					[stranger.userId, WORKSPACE],
				),
			).rejects.toThrow(/lock timeout/i);
			await contender.query("rollback");
			await locker.query("commit");
			await contender.query(
				`insert into membership (id, user_id, workspace_id, role)
				 values ('rot_late', $1, $2, 'member')`,
				[stranger.userId, WORKSPACE],
			);
			const inserted = await pool.query(
				"select 1 from membership where id = 'rot_late'",
			);
			expect(inserted.rowCount).toBe(1);
		} finally {
			await locker.query("rollback").catch(() => undefined);
			await contender.query("rollback").catch(() => undefined);
			locker.release();
			contender.release();
		}
	});

	test("lists only current members and their current enrollment keys", async () => {
		const response = await call("GET", `/api/e2e/members/${WORKSPACE}/keys`, {
			cookie: owner.cookie,
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			workspaceId: WORKSPACE,
			currentVersion: 1,
			rotationRequired: true,
			canRotate: true,
		});
		expect(body.members).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					membershipId: membershipIds.owner,
					userId: owner.userId,
					recipientPublicKey: owner.identity?.publicKey,
				}),
				expect.objectContaining({
					membershipId: membershipIds.unenrolled,
					userId: unenrolled.userId,
					recipientPublicKey: null,
				}),
			]),
		);
		expect(body.members).toHaveLength(4);
		expect(
			(
				await call("GET", `/api/e2e/members/${WORKSPACE}/keys`, {
					cookie: stranger.cookie,
				})
			).status,
		).toBe(404);
	});

	test("only Owner or Admin may rotate", async () => {
		const body = await rotationBody(crypto.getRandomValues(new Uint8Array(32)));
		const response = await call(
			"POST",
			`/api/e2e/workspaces/${WORKSPACE}/rotate`,
			{ cookie: member.cookie, body },
		);
		expect(response.status).toBe(403);
		expect(await workspaceState()).toBe(true);
		expect(await workspaceKeys()).toHaveLength(1);
	});

	test("rejects an incomplete or stale recipient set without changing state", async () => {
		const missing = await rotationBody(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		missing.grants.pop();
		expect(
			(
				await call("POST", `/api/e2e/workspaces/${WORKSPACE}/rotate`, {
					cookie: owner.cookie,
					body: missing,
				})
			).status,
		).toBe(409);

		const stale = await rotationBody(
			crypto.getRandomValues(new Uint8Array(32)),
		);
		const replacement = await newIdentity();
		if (stale.grants[1]) {
			stale.grants[1].recipientPublicKey = replacement.publicKey;
		}
		const response = await call(
			"POST",
			`/api/e2e/workspaces/${WORKSPACE}/rotate`,
			{ cookie: owner.cookie, body: stale },
		);
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("stale-recipient-key");
		expect(await workspaceState()).toBe(true);
		expect(await workspaceKeys()).toHaveLength(1);
	});

	test("holds recipient identities stable until the rotation transaction ends", async () => {
		const body = await rotationBody(crypto.getRandomValues(new Uint8Array(32)));
		const rotator = await pool.connect();
		const identityRotator = await pool.connect();
		try {
			await rotator.query("begin");
			await rotator.query("select set_config('ditero.user_id', $1, true)", [
				owner.userId,
			]);
			const result = await rotateWorkspace(
				rotator,
				owner.userId,
				WORKSPACE,
				body,
			);
			expect(result).toMatchObject({ ok: true, outcome: "rotated" });

			await identityRotator.query("begin");
			await identityRotator.query("set local lock_timeout = '100ms'");
			await expect(
				identityRotator.query(
					"update user_key set retired_at = now() where user_id = $1 and retired_at is null",
					[member.userId],
				),
			).rejects.toThrow(/lock timeout/i);
		} finally {
			await rotator.query("rollback").catch(() => undefined);
			await identityRotator.query("rollback").catch(() => undefined);
			rotator.release();
			identityRotator.release();
		}
	});

	test("mints v2 for enrolled members, queues the unenrolled member, and retains v1", async () => {
		const v2 = crypto.getRandomValues(new Uint8Array(32));
		const body = await rotationBody(v2);
		const response = await call(
			"POST",
			`/api/e2e/workspaces/${WORKSPACE}/rotate`,
			{ cookie: admin.cookie, body },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			workspaceId: WORKSPACE,
			version: 2,
			commitment: body.commitment,
			outcome: "rotated",
		});
		expect(await workspaceState()).toBe(false);
		expect(await workspaceKeys()).toEqual([
			{
				version: 1,
				commitment: await commitWdk(v1, WORKSPACE, 1),
				active: false,
			},
			{ version: 2, commitment: body.commitment, active: true },
		]);

		const rows = await membershipKeys();
		expect(rows.filter((row) => row.key_version === 1)).toHaveLength(3);
		expect(rows.filter((row) => row.key_version === 2)).toHaveLength(3);
		for (const [actor, id] of [
			[owner, membershipIds.owner],
			[admin, membershipIds.admin],
			[member, membershipIds.member],
		] as const) {
			const oldRow = rows.find(
				(row) => row.membership_id === id && row.key_version === 1,
			);
			const newRow = rows.find(
				(row) => row.membership_id === id && row.key_version === 2,
			);
			if (!oldRow || !newRow) throw new Error("expected both key versions");
			expect(await openRow(oldRow, actor)).toEqual(v1);
			expect(await openRow(newRow, actor)).toEqual(v2);
		}
		expect(rows.some((row) => row.user_id === removed.userId)).toBe(false);

		const requests = (
			await pool.query<{
				requested_version: number;
				state: string;
			}>(
				`select requested_version, state from key_grant_request
				 where membership_id = $1 order by requested_version`,
				[membershipIds.unenrolled],
			)
		).rows;
		expect(requests).toEqual([
			{ requested_version: 1, state: "revoked" },
			{ requested_version: 2, state: "key_pending" },
		]);
	});

	test("two rotation candidates converge on exactly one v2", async () => {
		const candidateA = crypto.getRandomValues(new Uint8Array(32));
		const candidateB = crypto.getRandomValues(new Uint8Array(32));
		const [bodyA, bodyB] = await Promise.all([
			rotationBody(candidateA),
			rotationBody(candidateB),
		]);
		const responses = await Promise.all([
			call("POST", `/api/e2e/workspaces/${WORKSPACE}/rotate`, {
				cookie: owner.cookie,
				body: bodyA,
			}),
			call("POST", `/api/e2e/workspaces/${WORKSPACE}/rotate`, {
				cookie: admin.cookie,
				body: bodyB,
			}),
		]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		const results = await Promise.all(
			responses.map((response) => response.json()),
		);
		expect(results.map((result) => result.outcome).sort()).toEqual([
			"already",
			"rotated",
		]);
		const keys = await workspaceKeys();
		expect(keys.filter((key) => key.version === 2)).toHaveLength(1);
		const winner = keys.find((key) => key.version === 2);
		expect(results.every((result) => result.version === 2)).toBe(true);
		expect(
			results.every((result) => result.commitment === winner?.commitment),
		).toBe(true);
		expect(
			(await membershipKeys()).filter((key) => key.key_version === 2),
		).toHaveLength(3);
	});
});
