import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { exportJWK, generateKeyPair } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	receipt,
	verifyOffer,
	verifyProof,
} from "../../apps/push-relay/src/proof.ts";
import * as tables from "../../src/db/schema.ts";
import { backfillCredentialConfigs } from "../../src/security/encrypt-channel-configs.ts";
import {
	createFieldKeyRing,
	decryptField,
} from "../../src/security/field-encryption.ts";
import type { safeFetch } from "../../src/security/safe-http.ts";
import { notifyGrantCapable } from "../../src/server/e2e/grants.ts";
import { revokeNativeSession } from "../../src/server/native-auth/revoke.ts";
import type { NativeSession } from "../../src/server/native-auth/session.ts";
import { lookupNativeSession } from "../../src/server/native-auth/session.ts";
import type { RelayConfiguration } from "../../src/server/native-push/relay-configuration.ts";
import {
	type Body,
	id,
	type PublicKey,
	semanticDigest,
} from "../../src/server/native-push/relay-contracts.ts";
import {
	backfillRelayAuthorities,
	recoverRelayAuthorities,
} from "../../src/server/native-push/relay-recovery.ts";
import {
	type AuthorityRow,
	authorityContext,
	decodeAuthority,
	NativeRelayStore,
} from "../../src/server/native-push/relay-store.ts";
import { nativePushRoutes } from "../../src/server/native-push/routes.ts";
import { NativePushStore } from "../../src/server/native-push/store.ts";
import { createRelayPushSender } from "../../src/server/notifications/adapters/relay-push.ts";
import { enqueueEvents } from "../../src/server/notifications/events.ts";
import { createNativeDelivery } from "../../src/server/notifications/native-delivery.ts";
import { scanTick } from "../../src/server/notifications/scheduler.ts";
import type { OutboxRow } from "../../src/server/notifications/worker.ts";

const admin = new Pool({
	connectionString: process.env.NATIVE_RELAY_TEST_ADMIN_DATABASE_URL,
});
const pool = new Pool({
	connectionString: process.env.NATIVE_RELAY_TEST_DATABASE_URL,
	max: 8,
});
const old = randomBytes(32).toString("base64"),
	next = randomBytes(32).toString("base64"),
	ring = createFieldKeyRing({ current: old }),
	rotating = createFieldKeyRing({ current: old, next }),
	retired = createFieldKeyRing({ current: next });
let trust: RelayConfiguration,
	signer: { kid: string; privateKey: CryptoKey },
	device: PublicKey,
	store: NativeRelayStore;
beforeAll(async () => {
	const pair = await generateKeyPair("ES256", { extractable: true });
	signer = { kid: "fixture", privateKey: pair.privateKey };
	trust = {
		origin: "https://relay.example.org",
		receiptKeys: { fixture: (await exportJWK(pair.publicKey)) as PublicKey },
	};
	device = (await exportJWK(
		(
			await generateKeyPair("ES256", { extractable: true })
		).publicKey,
	)) as PublicKey;
	store = new NativeRelayStore(pool, ring, trust);
});
afterAll(async () => {
	await pool.end();
	await admin.end();
});
async function actor(existingUserId?: string) {
	const userId = existingUserId ?? randomUUID(),
		sessionId = randomUUID(),
		deviceId = randomUUID(),
		token = id();
	if (!existingUserId)
		await admin.query('insert into "user"(id,name,email) values($1,$1,$2)', [
			userId,
			`${userId}@example.test`,
		]);
	await admin.query(
		"insert into session(id,user_id,token,expires_at,updated_at) values($1,$2,$3,now()+interval '1 day',now())",
		[sessionId, userId, token],
	);
	await admin.query(
		"insert into user_device(id,user_id,label) values($1,$2,'Relay fixture')",
		[deviceId, userId],
	);
	await admin.query(
		"insert into native_session_link(session_id,user_id,device_id) values($1,$2,$3)",
		[sessionId, userId, deviceId],
	);
	const owner = await lookupNativeSession(pool, token);
	if (!owner) throw new Error("Fixture owner missing");
	return { owner, token };
}
async function authority(offerId: string) {
	return (
		await admin.query<AuthorityRow>(
			"select * from native_relay_authority where id=$1",
			[offerId],
		)
	).rows[0];
}
async function signed(
	row: AuthorityRow,
	generation = 1,
	credentialVersion = 1,
	extra: Record<string, unknown> = {},
) {
	const config = decodeAuthority(row, ring);
	return receipt(
		signer,
		{
			offerId: config.offerId,
			offerExpires: config.offerExpires,
			registrationId: config.registrationId,
			targetId: config.targetId,
			installationId: config.installationId,
			senderKey: config.senderKey,
			senderThumbprint: config.senderThumbprint,
			deviceThumbprint: config.deviceThumbprint,
			relayOrigin: config.relayOrigin,
			fidHash: id(),
			generation,
			credentialVersion,
			sendCapabilityHash: config.sendCapabilityHash,
			...extra,
		},
		trust.origin,
	);
}
async function fixture() {
	const a = await actor(),
		input = { operationId: id(), installationId: id(), deviceKey: device },
		offer = await store.offer(a.owner, input),
		row = await authority(offer.offerId),
		token = await signed(row);
	return { ...a, input, offer, row, receipt: token };
}
function ctx(fetch: typeof safeFetch) {
	return {
		signal: AbortSignal.timeout(10000),
		deadlineMs: 10000,
		allowedPrivateCIDRs: [],
		fetch,
	};
}
function routes() {
	return nativePushRoutes({
		pool,
		ring,
		configuration: { "fcm-relay": trust },
		rateLimit: async () => true,
	});
}
async function call(
	token: string,
	path: string,
	body: unknown,
	app = routes(),
) {
	return app.handle(
		new Request(`http://localhost/api/native/push/${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		}),
	);
}
test("runtime is restricted and migration table cannot be altered", async () => {
	const row = (
		await pool.query(
			"select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user",
		)
	).rows[0];
	expect(Object.values(row)).toEqual([false, false, false, false]);
	await expect(
		pool.query("delete from drizzle.__drizzle_migrations"),
	).rejects.toThrow();
});
test("durable offer identical retry, closed bodies and sender private key stays encrypted", async () => {
	const f = await fixture();
	expect(await store.offer(f.owner, f.input)).toEqual(f.offer);
	expect(JSON.stringify(f.offer)).not.toContain("senderPrivateKey");
	expect(f.row.config_ciphertext).not.toContain("senderPrivateKey");
	expect(() =>
		decryptField(
			f.row.config_ciphertext,
			authorityContext({ ...f.row, user_id: "wrong" }),
			ring,
		),
	).toThrow();
	const config = decodeAuthority(f.row, ring);
	await expect(
		verifyOffer(f.offer.offer, config.senderKey, {
			origin: trust.origin,
			offerId: config.offerId,
			targetId: config.targetId,
			installationId: config.installationId,
			registrationId: config.registrationId,
			deviceThumbprint: config.deviceThumbprint,
			sendCapabilityHash: config.sendCapabilityHash,
		}),
	).resolves.toBe(config.offerExpires);
	await expect(
		store.offer(f.owner, { ...f.input, installationId: id() }),
	).rejects.toThrow("operation-conflict");
	expect(
		(
			await call(f.token, "register", {
				provider: "fcm-relay",
				sendCapability: id(),
			})
		).status,
	).toBe(400);
});
test("copied wrong bindings, expired and revoked receipts cannot activate", async () => {
	const f = await fixture(),
		other = await actor();
	await expect(
		store.activate(other.owner, f.offer.offerId, f.receipt),
	).rejects.toThrow();
	await expect(
		store.activate(
			f.owner,
			f.offer.offerId,
			await signed(f.row, 1, 1, { deviceThumbprint: id() }),
		),
	).rejects.toThrow();
	await admin.query(
		"update native_relay_authority set offer_expires=now()-interval '1 second' where id=$1",
		[f.row.id],
	);
	await expect(store.activate(f.owner, f.row.id, f.receipt)).rejects.toThrow();
	const revoked = await fixture();
	await revokeNativeSession(pool, revoked.owner);
	await expect(
		store.activate(revoked.owner, revoked.row.id, revoked.receipt),
	).rejects.toThrow();
});
test("concurrent receipt consumption produces one registration; lost response replay never resurrects replacement", async () => {
	const f = await fixture();
	const results = await Promise.all(
		Array.from({ length: 4 }, () =>
			store.activate(f.owner, f.row.id, f.receipt),
		),
	);
	expect(new Set(results.map((x) => x.registrationId)).size).toBe(1);
	expect(await store.activate(f.owner, f.row.id, f.receipt)).toEqual(
		results[0],
	);
	await new NativePushStore(pool, ring).register(f.owner, {
		provider: "fcm",
		token: "custom-token",
	});
	await expect(store.activate(f.owner, f.row.id, f.receipt)).rejects.toThrow(
		"offer-consumed",
	);
	expect((await authority(f.row.id)).state).toBe("active");
});
test("revocation between authentication and write cannot install", async () => {
	const f = await fixture();
	const admitted = await lookupNativeSession(pool, f.token);
	expect(admitted).not.toBeNull();
	await revokeNativeSession(pool, f.owner);
	await expect(
		store.activate(admitted as NativeSession, f.row.id, f.receipt),
	).rejects.toThrow();
});
test("receipt CAS rejects stale generations; management-only rotation preserves delivery generation", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const oldReceipt = JSON.parse(
		Buffer.from(f.receipt.split(".")[1], "base64url").toString(),
	);
	const rotated = await signed(f.row, 1, 2, { fidHash: oldReceipt.fidHash });
	expect(
		await store.update(f.owner, f.row.registration_id, 1, rotated),
	).toEqual({ registrationId: f.row.registration_id, generation: 1 });
	const replaced = await signed(f.row, 2, 3);
	expect(
		await store.update(f.owner, f.row.registration_id, 1, replaced),
	).toEqual({ registrationId: f.row.registration_id, generation: 2 });
	expect(
		await store.update(f.owner, f.row.registration_id, 1, replaced),
	).toEqual({ registrationId: f.row.registration_id, generation: 2 });
	await expect(
		store.update(f.owner, f.row.registration_id, 1, rotated),
	).rejects.toThrow("generation-conflict");
});
test("pending cancellation404 retained before expiry, and cascade snapshot survives user deletion", async () => {
	const f = await fixture();
	await store.cancel(f.owner, f.row.id);
	const absent: typeof safeFetch = async () =>
		Response.json({ error: "not_found" }, { status: 404 });
	await recoverRelayAuthorities(pool, ring, trust, { fetch: absent });
	expect(await authority(f.row.id)).toBeTruthy();
	await admin.query('delete from "user" where id=$1', [f.owner.userId]);
	expect(await authority(f.row.id)).toBeTruthy();
	await admin.query(
		"update native_relay_authority set offer_expires=now()-interval '1 second',next_attempt=now() where id=$1",
		[f.row.id],
	);
	await recoverRelayAuthorities(pool, ring, trust, { fetch: absent });
	expect(await authority(f.row.id)).toBeUndefined();
});
test("credential rotation covers active, issued and retired snapshots, idempotently, after old key removal", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const p = await fixture();
	await store.cancel(p.owner, p.row.id);
	await admin.query('delete from "user" where id=$1', [p.owner.userId]);
	expect(await backfillCredentialConfigs(admin, rotating)).toBeGreaterThan(0);
	expect(await backfillCredentialConfigs(admin, rotating)).toBe(0);
	for (const row of (
		await admin.query<AuthorityRow>("select * from native_relay_authority")
	).rows)
		expect(() => decodeAuthority(row, retired)).not.toThrow();
	const acknowledged: typeof safeFetch = async (_url, options = {}) => {
		const body = JSON.parse(String(options.body));
		return Response.json({ kind: "retired", generation: body.generation });
	};
	await admin.query(
		"update native_relay_authority set next_attempt=now() where id=$1",
		[p.row.id],
	);
	await recoverRelayAuthorities(pool, retired, trust, { fetch: acknowledged });
	expect(await authority(p.row.id)).toBeUndefined();
});

test("real native delivery preserves UUID open lookups and all notification kinds with signed accepted replay", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const workspaceId = randomUUID(),
		listId = randomUUID(),
		taskId = randomUUID();
	await admin.query(
		"insert into workspace(id,name,owner_id) values($1,'Relay delivery',$2)",
		[workspaceId, f.owner.userId],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), f.owner.userId, workspaceId],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Relay list','a0')",
		[listId, workspaceId, f.owner.userId],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Relay task','a0')",
		[taskId, listId],
	);
	const seen: Body<"/v1/send">[] = [];
	const fetch: typeof safeFetch = async (url, options = {}) => {
		expect(url).toBe(`${trust.origin}/v1/send`);
		const body = JSON.parse(String(options.body)) as Body<"/v1/send">;
		seen.push(body);
		const config = decodeAuthority(await authority(f.row.id), ring);
		await verifyProof(
			body.senderProof,
			config.senderKey,
			trust.origin,
			"/v1/send",
			body.operationId,
			semanticDigest(body),
		);
		const accepted = await receipt(
			signer,
			{
				kind: "accepted",
				operationId: body.operationId,
				digest: semanticDigest(body),
				targetId: config.targetId,
				installationId: config.installationId,
				registrationId: config.registrationId,
				generation: config.generation,
				senderThumbprint: config.senderThumbprint,
				deviceThumbprint: config.deviceThumbprint,
				sendCapabilityHash: config.sendCapabilityHash,
			},
			trust.origin,
		);
		return Response.json({ kind: "accepted", receipt: accepted });
	};
	const send = createNativeDelivery(drizzle(pool), ring, {
		"fcm-relay": trust,
	});
	for (const kind of ["reminder", "assign", "mention", "key_grant"]) {
		const notificationId = randomUUID(),
			payload = kind === "key_grant" ? { kind, workspaceId } : { kind, taskId };
		await admin.query(
			"insert into notification_outbox(id,recipient_user_id,native_registration_id,channel_kind,payload,idempotency_key) values($1,$2,$3,'nativepush',$4,$1)",
			[
				notificationId,
				f.owner.userId,
				f.row.registration_id,
				JSON.stringify(payload),
			],
		);
		const row: OutboxRow = {
			id: notificationId,
			reminderStateId: null,
			recipientUserId: f.owner.userId,
			nativeRegistrationId: f.row.registration_id,
			channelKind: "nativepush",
			payload,
			attempts: 0,
		};
		expect(await send(row, ctx(fetch))).toEqual({ ok: true, status: 202 });
		expect(await send(row, ctx(fetch))).toEqual({ ok: true, status: 202 });
		expect(seen.at(-1)?.operationId).toBe(seen.at(-2)?.operationId);
		expect(seen.at(-1)?.senderProof).not.toBe(seen.at(-2)?.senderProof);
		expect(seen.at(-1)?.data).toEqual({
			version: "1",
			notificationId,
			registrationId: f.row.registration_id,
		});
		const opened = await new NativePushStore(pool, ring).open(f.owner, {
			notificationId,
			registrationId: f.row.registration_id,
		});
		expect(opened?.kind).toBe(kind === "key_grant" ? "workspace" : "task");
	}
	await admin.query("delete from membership where workspace_id=$1", [
		workspaceId,
	]);
	const row: OutboxRow = {
		id: randomUUID(),
		reminderStateId: null,
		recipientUserId: f.owner.userId,
		nativeRegistrationId: f.row.registration_id,
		channelKind: "nativepush",
		payload: { kind: "assign", taskId },
		attempts: 0,
	};
	const previous = seen.length;
	expect((await send(row, ctx(fetch))).ok).toBe(false);
	expect(seen.length).toBe(previous);
});
test("stale sender response keeps local registration, verified next generation sends with new operation", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const notificationId = randomUUID();
	const config = decodeAuthority(await authority(f.row.id), ring),
		sender = createRelayPushSender(trust),
		seen: string[] = [];
	const stale: typeof safeFetch = async (_url, options = {}) => {
		seen.push(JSON.parse(String(options.body)).operationId);
		return Response.json({ kind: "stale" }, { status: 409 });
	};
	const initial = await sender(
		config,
		{ version: "1", notificationId, registrationId: f.row.registration_id },
		ctx(stale),
	);
	expect(initial.expired).toBe(false);
	expect(initial.result.ok).toBe(false);
	expect(
		(
			await admin.query("select id from native_push_registration where id=$1", [
				f.row.registration_id,
			])
		).rowCount,
	).toBe(1);
	await store.update(
		f.owner,
		f.row.registration_id,
		1,
		await signed(f.row, 2, 2),
	);
	const current = decodeAuthority(await authority(f.row.id), ring);
	await sender(
		current,
		{ version: "1", notificationId, registrationId: f.row.registration_id },
		ctx(stale),
	);
	expect(seen[0]).not.toBe(seen[1]);
});
test("replica recovery retires replaced relay exactly once after local commit", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	await new NativePushStore(pool, ring).register(f.owner, {
		provider: "fcm",
		token: "replacement",
	});
	await admin.query(
		"update native_relay_authority set next_attempt=now() where id=$1",
		[f.row.id],
	);
	let calls = 0;
	const fetch: typeof safeFetch = async (_url, options = {}) => {
		const body = JSON.parse(String(options.body));
		if (body.targetId !== decodeAuthority(f.row, ring).targetId)
			return Response.json({ kind: "retired", generation: body.generation });
		calls++;
		expect(
			(
				await admin.query(
					"select id from native_push_registration where id=$1",
					[f.row.registration_id],
				)
			).rowCount,
		).toBe(0);
		return Response.json({ kind: "retired", generation: body.generation });
	};
	await Promise.all([
		recoverRelayAuthorities(pool, ring, trust, { fetch }),
		recoverRelayAuthorities(pool, ring, trust, { fetch }),
	]);
	expect(calls).toBe(1);
	expect(await authority(f.row.id)).toBeUndefined();
});

test("concurrent identical offer allocation serializes durable sender authority", async () => {
	const a = await actor(),
		input = { operationId: id(), installationId: id(), deviceKey: device };
	const offers = await Promise.all(
		Array.from({ length: 4 }, () => store.offer(a.owner, input)),
	);
	expect(new Set(offers.map((o) => o.offer)).size).toBe(1);
	expect(new Set(offers.map((o) => o.sendCapability)).size).toBe(1);
	expect(
		(
			await admin.query(
				"select id from native_relay_authority where operation_id=$1",
				[input.operationId],
			)
		).rowCount,
	).toBe(1);
});
test("lost FID receipt followed by native revoke verifies status then retires new generation without resurrection", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	await revokeNativeSession(pool, f.owner);
	await admin.query(
		"update native_relay_authority set next_attempt=now()+interval '1 day' where id<>$1",
		[f.row.id],
	);
	await admin.query(
		"update native_relay_authority set next_attempt=now() where id=$1",
		[f.row.id],
	);
	const config = decodeAuthority(f.row, ring),
		paths: string[] = [],
		retirementGenerations: number[] = [];
	const fetch: typeof safeFetch = async (url, options = {}) => {
		const body = JSON.parse(String(options.body)) as Body;
		const path = new URL(String(url)).pathname;
		paths.push(path);
		await verifyProof(
			"senderProof" in body ? body.senderProof : undefined,
			config.senderKey,
			trust.origin,
			path,
			body.operationId,
			semanticDigest(body),
		);
		if (path === "/v1/manage/retire") {
			const gen = (body as Body<"/v1/manage/retire">).generation;
			retirementGenerations.push(gen);
			return gen === 1
				? Response.json({ kind: "stale" }, { status: 409 })
				: Response.json({ kind: "retired", generation: 2 });
		}
		return Response.json({
			kind: "target-status",
			state: "confirmed",
			generation: 2,
			credentialVersion: 2,
			receipt: await receipt(
				signer,
				{
					offerId: config.offerId,
					offerExpires: config.offerExpires,
					registrationId: config.registrationId,
					targetId: config.targetId,
					installationId: config.installationId,
					senderKey: config.senderKey,
					senderThumbprint: config.senderThumbprint,
					deviceThumbprint: config.deviceThumbprint,
					relayOrigin: config.relayOrigin,
					fidHash: id(),
					generation: 2,
					credentialVersion: 2,
					sendCapabilityHash: config.sendCapabilityHash,
					kind: "target-status",
					state: "confirmed",
					operationId: body.operationId,
					digest: semanticDigest(body),
				},
				trust.origin,
			),
		});
	};
	await recoverRelayAuthorities(pool, ring, trust, { fetch });
	const resynced = await authority(f.row.id);
	expect(resynced.state).toBe("retiring");
	expect(resynced.generation).toBe(2);
	expect(
		(
			await admin.query("select id from native_push_registration where id=$1", [
				f.row.registration_id,
			])
		).rowCount,
	).toBe(0);
	await recoverRelayAuthorities(pool, ring, trust, { fetch });
	expect(await authority(f.row.id)).toBeUndefined();
	expect(retirementGenerations).toEqual([1, 2]);
	expect(paths).toEqual([
		"/v1/manage/retire",
		"/v1/targets/status",
		"/v1/manage/retire",
	]);
});
test("existing reminder, assignment, mention and key grant producers fan out to verified relay and independent providers only", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const custom = await actor(f.owner.userId),
		independent = await actor(f.owner.userId);
	const customRegistration = await new NativePushStore(pool, ring).register(
		custom.owner,
		{ provider: "fcm", token: "custom-project-token" },
	);
	const pair = createECDH("prime256v1");
	pair.generateKeys();
	const independentRegistration = await new NativePushStore(
		pool,
		ring,
	).register(independent.owner, {
		provider: "unifiedpush",
		endpoint: "https://push.example.org/fixture",
		keys: {
			p256dh: pair.getPublicKey().toString("base64url"),
			auth: randomBytes(16).toString("base64url"),
		},
	});
	const pending = await fixture(),
		withdrawn = await fixture();
	await store.activate(withdrawn.owner, withdrawn.row.id, withdrawn.receipt);
	await store.cancel(withdrawn.owner, withdrawn.row.id);
	const workspaceId = randomUUID(),
		listId = randomUUID(),
		taskId = randomUUID(),
		membershipId = randomUUID(),
		requester = await actor(),
		requesterMembership = randomUUID();
	await admin.query(
		"insert into workspace(id,name,owner_id) values($1,'Producer fixture',$2)",
		[workspaceId, f.owner.userId],
	);
	for (const owner of [
		f.owner,
		pending.owner,
		withdrawn.owner,
		requester.owner,
	])
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
			[
				owner.userId === f.owner.userId
					? membershipId
					: owner.userId === requester.owner.userId
						? requesterMembership
						: randomUUID(),
				owner.userId,
				workspaceId,
			],
		);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Producer list','a0')",
		[listId, workspaceId, f.owner.userId],
	);
	const now = new Date(),
		due = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12),
		),
		time = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
	await admin.query(
		"insert into task(id,list_id,title,sort_key,due_at,reminder_time) values($1,$2,'Producer task','a0',$3,$4)",
		[taskId, listId, due, time],
	);
	const db = drizzle(pool, { schema: tables });
	for (const recipient of [f.owner, pending.owner, withdrawn.owner])
		await enqueueEvents(
			db,
			[
				{
					stamp: id(),
					recipientUserId: recipient.userId,
					event: {
						kind: "assign",
						taskId,
						taskTitle: "Producer task",
						actorUserId: requester.owner.userId,
					},
				},
				{
					stamp: id(),
					recipientUserId: recipient.userId,
					event: {
						kind: "mention",
						taskId,
						taskTitle: "Producer task",
						actorUserId: requester.owner.userId,
						commentId: randomUUID(),
					},
				},
			],
			{ now, maxQueuedPerUser: 100 },
		);
	const scan = await scanTick(db, {
		now,
		timing: { tickMs: 1000, graceMs: 3600000, lateThresholdMs: 60000 },
		maxQueuedPerUser: 100,
	});
	// Scheduler counts one native channel; enqueueOutbox expands it to three device targets.
	expect(scan.enqueued).toBe(1);
	await admin.query(
		"insert into user_key(id,user_id,public_key,state) values($1,$2,$3,'ready')",
		[randomUUID(), f.owner.userId, id()],
	);
	await admin.query(
		"insert into membership_key(id,membership_id,user_id,workspace_id,key_version,enc,ciphertext,recipient_public_key,granted_by) values($1,$2,$3,$4,1,$5,$6,$7,$3)",
		[randomUUID(), membershipId, f.owner.userId, workspaceId, id(), id(), id()],
	);
	const requestId = randomUUID();
	await admin.query(
		"insert into key_grant_request(id,membership_id,user_id,workspace_id,requested_version) values($1,$2,$3,$4,1)",
		[requestId, requesterMembership, requester.owner.userId, workspaceId],
	);
	expect(
		await notifyGrantCapable(db, requestId, requester.owner.userId, now),
	).toBe(1);
	const rows = (
		await admin.query<{ native_registration_id: string; kind: string }>(
			"select native_registration_id,payload->>'kind' as kind from notification_outbox where recipient_user_id=$1",
			[f.owner.userId],
		)
	).rows;
	for (const registrationId of [
		f.row.registration_id,
		customRegistration.registrationId,
		independentRegistration.registrationId,
	])
		expect(
			rows
				.filter((r) => r.native_registration_id === registrationId)
				.map((r) => r.kind)
				.sort(),
		).toEqual(["assign", "key_grant", "mention", "reminder"]);
	expect(
		(
			await admin.query(
				"select id from notification_outbox where recipient_user_id=any($1::text[])",
				[[pending.owner.userId, withdrawn.owner.userId]],
			)
		).rowCount,
	).toBe(0);
});

test("new provider choice or unregister cancels pending relay offers before late receipt activation", async () => {
	for (const action of ["register", "unregister"] as const) {
		const f = await fixture();
		const native = new NativePushStore(pool, ring);
		if (action === "register")
			await native.register(f.owner, {
				provider: "fcm",
				token: "chosen-custom-provider",
			});
		else await native.unregister(f.owner);
		expect((await authority(f.row.id)).state).toBe("retiring");
		await expect(store.activate(f.owner, f.row.id, f.receipt)).rejects.toThrow(
			"offer-unavailable",
		);
	}
});

test("held-row rotation race preserves a newer receipt update and never resurrects a retired snapshot", async () => {
	const f = await fixture();
	await store.activate(f.owner, f.row.id, f.receipt);
	const replacement = await signed(f.row, 2, 2);
	const holder = await admin.connect();
	let notice = () => {};
	const scanned = new Promise<void>((resolve) => {
		notice = resolve;
	});
	await holder.query("begin");
	await holder.query(
		"select id from native_relay_authority where id=$1 for update",
		[f.row.id],
	);
	const rotation = backfillRelayAuthorities(
		admin,
		rotating,
		async (offerId) => {
			if (offerId === f.row.id) notice();
		},
	);
	await scanned;
	const update = new NativeRelayStore(pool, rotating, trust).update(
		f.owner,
		f.row.registration_id,
		1,
		replacement,
	);
	try {
		const deadline = Date.now() + 3000;
		let locked = false;
		while (Date.now() < deadline) {
			const waiting = (
				await admin.query<{ count: string }>(
					"select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from native_relay_authority%for update%'",
				)
			).rows[0];
			if (Number(waiting.count) >= 2) {
				locked = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(locked).toBe(true);
	} finally {
		await holder.query("commit");
		holder.release();
	}
	await Promise.all([rotation, update]);
	const current = await authority(f.row.id);
	expect(current.generation).toBe(2);
	expect(decodeAuthority(current, retired).generation).toBe(2);
	const registration = (
		await admin.query(
			"select config_ciphertext from native_push_registration where id=$1",
			[f.row.registration_id],
		)
	).rows[0];
	expect(
		JSON.parse(
			decryptField(
				registration.config_ciphertext,
				authorityContext(current),
				retired,
			).plaintext,
		).generation,
	).toBe(2);
	expect(await backfillRelayAuthorities(admin, rotating)).toBe(0);
	const pending = await fixture();
	await store.cancel(pending.owner, pending.row.id);
	let removed = false;
	await backfillRelayAuthorities(admin, rotating, async (offerId) => {
		if (offerId === pending.row.id) {
			removed = true;
			await admin.query("delete from native_relay_authority where id=$1", [
				offerId,
			]);
		}
	});
	expect(removed).toBe(true);
	expect(await authority(pending.row.id)).toBeUndefined();
});
