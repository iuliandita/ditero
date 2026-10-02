import {
	createDecipheriv,
	createECDH,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	randomUUID,
	verify,
} from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { verifyRuntimeDatabaseRole } from "../../src/db/runtime-role.ts";
import * as tables from "../../src/db/schema.ts";
import {
	createFieldKeyRing,
	encryptField,
} from "../../src/security/field-encryption.ts";
import type { safeFetch } from "../../src/security/safe-http.ts";
import { nativePushConfigContext } from "../../src/server/native-push/store.ts";
import { createNativePushSender } from "../../src/server/notifications/adapters/native-push.ts";
import type { AdapterContext } from "../../src/server/notifications/adapters/types.ts";
import { createSendFn } from "../../src/server/notifications/dispatch.ts";
import { enqueueEvents } from "../../src/server/notifications/events.ts";
import { scanTick } from "../../src/server/notifications/scheduler.ts";
import {
	claimBatch,
	completeDelivery,
	type OutboxRow,
} from "../../src/server/notifications/worker.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema: tables });
const runtimePool = new Pool({
	connectionString: process.env.DATABASE_URL,
	options: "-c role=ditero_native_delivery_runtime_test",
	max: 1,
});
const runtimeDb = drizzle(runtimePool, { schema: tables });
const user = randomUUID(),
	ws = randomUUID(),
	list = randomUUID(),
	task = randomUUID();
const pair = createECDH("prime256v1");
pair.generateKeys();
const ring = createFieldKeyRing({
	current: Buffer.alloc(32, 7).toString("base64"),
});
const configuration = {
	unifiedpush: {
		publicKey: pair.getPublicKey().toString("base64url"),
		privateKey: pair.getPrivateKey().toString("base64url"),
		subject: "mailto:push@example.test",
	},
};
const registrations: string[] = [];
const ctx: AdapterContext = {
	allowedPrivateCIDRs: [],
	deadlineMs: 2000,
	signal: new AbortController().signal,
};
let stamp = 0;
async function enqueue(now = new Date(Date.now() - 1000), sameStamp?: string) {
	await enqueueEvents(
		db,
		[
			{
				stamp: sameStamp ?? `native-${++stamp}`,
				recipientUserId: user,
				event: {
					kind: "assign",
					taskId: task,
					taskTitle: "Private medication title",
					actorUserId: user,
				},
			},
		],
		{ now, maxQueuedPerUser: 100 },
	);
}
async function device(provider = "unifiedpush") {
	const session = randomUUID(),
		deviceId = randomUUID(),
		id = randomUUID();
	await pool.query(
		"insert into session(id,token,user_id,expires_at,created_at,updated_at) values($1,$2,$3,now()+interval '1 day',now(),now())",
		[session, randomUUID(), user],
	);
	await pool.query(
		"insert into user_device(id,user_id,label) values($1,$2,$3)",
		[deviceId, user, "Native fixture"],
	);
	await pool.query(
		"insert into native_session_link(session_id,user_id,device_id) values($1,$2,$3)",
		[session, user, deviceId],
	);
	const input =
		provider === "unifiedpush"
			? {
					provider,
					endpoint: `https://push.example.test/${id}`,
					keys: {
						p256dh: pair.getPublicKey().toString("base64url"),
						auth: randomBytes(16).toString("base64url"),
					},
				}
			: { provider, token: `token-${id}` };
	await pool.query(
		"insert into native_push_registration(id,session_id,user_id,device_id,provider,config_ciphertext) values($1,$2,$3,$4,$5,$6)",
		[
			id,
			session,
			user,
			deviceId,
			provider,
			encryptField(
				JSON.stringify(input),
				nativePushConfigContext(id, {
					userId: user,
					sessionId: session,
					deviceId,
				}),
				ring,
			),
		],
	);
	registrations.push(id);
	return { id, session, deviceId, input };
}
beforeAll(async () => {
	await pool.query(`do $$ begin
		if not exists(select from pg_roles where rolname='ditero_native_delivery_runtime_test') then
			create role ditero_native_delivery_runtime_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await pool.query(
		"grant usage on schema public to ditero_native_delivery_runtime_test",
	);
	await pool.query(`grant select on "user", session, user_device, native_session_link, native_push_registration,
		user_pref, notification_channel, task, list, workspace, membership, task_assignee,
		task_notification_activation, task_notification_recipient
		to ditero_native_delivery_runtime_test`);
	await pool.query(
		"grant select,insert,update on notification_outbox,reminder_state to ditero_native_delivery_runtime_test",
	);
	await pool.query(`grant update on "user", task, list, workspace, membership, task_assignee, user_pref,
		notification_channel, task_notification_activation, task_notification_recipient
		to ditero_native_delivery_runtime_test`);
	await verifyRuntimeDatabaseRole(runtimePool);
	await pool.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[user, "Native delivery", `${user}@example.test`],
	);
	await pool.query("insert into workspace(id,name,owner_id) values($1,$2,$3)", [
		ws,
		"Native delivery",
		user,
	]);
	await pool.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), user, ws],
	);
	await pool.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$4,'tasks','a0')",
		[list, ws, user, "Native delivery"],
	);
	await pool.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,$3,'a0')",
		[task, list, "Private medication title"],
	);
});
afterAll(async () => {
	await pool.query(
		"delete from notification_outbox where recipient_user_id=$1",
		[user],
	);
	await pool.query("delete from task where id=$1", [task]);
	await pool.query("delete from list where id=$1", [list]);
	await pool.query("delete from membership where workspace_id=$1", [ws]);
	await pool.query("delete from workspace where id=$1", [ws]);
	await pool.query('delete from "user" where id=$1', [user]);
	await runtimePool.end();
	await pool.end();
});
test("each device has independent idempotency, retry, opaque encrypted requests, and exact expired retirement", async () => {
	const a = await device(),
		b = await device();
	await enqueue(undefined, "same-event");
	await enqueue(undefined, "same-event");
	const rows = await claimBatch(db, 100, "native-fixture");
	expect(rows).toHaveLength(2);
	expect(new Set(rows.map((r) => r.nativeRegistrationId)).size).toBe(2);
	const first = rows.find((r) => r.nativeRegistrationId === a.id) as OutboxRow;
	const second = rows.find((r) => r.nativeRegistrationId === b.id) as OutboxRow;
	const fetch: typeof safeFetch = async (url, options = {}) => {
		expect(options.allowedPrivateCIDRs).toEqual([]);
		expect(options.signal).toBeDefined();
		expect(options.maxResponseBytes).toBe(16384);
		expect(new Headers(options.headers).get("content-encoding")).toBe(
			"aes128gcm",
		);
		expect(new Headers(options.headers).get("authorization")).toMatch(
			/^vapid /,
		);
		expect(Buffer.from(options.body as Uint8Array).toString()).not.toContain(
			"Private medication",
		);
		const encoded = Buffer.from(options.body as Uint8Array);
		const salt = encoded.subarray(0, 16),
			publicKey = encoded.subarray(21, 21 + encoded[20]);
		const auth = Buffer.from(
			(a.input as { keys: { auth: string } }).keys.auth,
			"base64url",
		);
		const info = Buffer.concat([
			Buffer.from("WebPush: info\0"),
			pair.getPublicKey(),
			publicKey,
		]);
		const inputKey = hkdfSync(
			"sha256",
			pair.computeSecret(publicKey),
			auth,
			info,
			32,
		);
		const key = hkdfSync(
			"sha256",
			inputKey,
			salt,
			Buffer.from("Content-Encoding: aes128gcm\0"),
			16,
		);
		const nonce = hkdfSync(
			"sha256",
			inputKey,
			salt,
			Buffer.from("Content-Encoding: nonce\0"),
			12,
		);
		const cipher = encoded.subarray(21 + encoded[20]);
		const decrypt = createDecipheriv(
			"aes-128-gcm",
			Buffer.from(key),
			Buffer.from(nonce),
		);
		decrypt.setAuthTag(cipher.subarray(-16));
		const plain = Buffer.concat([
			decrypt.update(cipher.subarray(0, -16)),
			decrypt.final(),
		]);
		expect(plain[plain.length - 1]).toBe(2);
		expect(JSON.parse(plain.subarray(0, -1).toString())).toEqual({
			version: "1",
			notificationId: first.id,
			registrationId: a.id,
		});
		expect(String(url)).toContain(a.id);
		return new Response("", { status: 503 });
	};
	const send = createSendFn({
		database: db,
		allowedPrivateCIDRs: [],
		deadlineMs: 2000,
		ackBaseUrl: null,
		nativeConfiguration: configuration,
		fetch,
	});
	await completeDelivery(
		db,
		first,
		await send(first, ctx.signal),
		"native-fixture",
	);
	await completeDelivery(
		db,
		second,
		{ ok: true, status: 201 },
		"native-fixture",
	);
	const states = await pool.query(
		"select id,status,attempts from notification_outbox where recipient_user_id=$1",
		[user],
	);
	expect(states.rows.find((r) => r.id === first.id)).toMatchObject({
		status: "queued",
		attempts: 1,
	});
	expect(states.rows.find((r) => r.id === second.id)).toMatchObject({
		status: "sent",
		attempts: 1,
	});
	const expired = createSendFn({
		database: db,
		allowedPrivateCIDRs: [],
		deadlineMs: 2000,
		ackBaseUrl: null,
		nativeConfiguration: configuration,
		fetch: async () => new Response("", { status: 410 }),
	});
	expect((await expired(first, ctx.signal)).ok).toBe(false);
	expect(
		(
			await pool.query(
				"select id from native_push_registration where id=any($1)",
				[[a.id, b.id]],
			)
		).rows,
	).toEqual([{ id: b.id }]);
	await pool.query(
		"delete from notification_outbox where recipient_user_id=$1",
		[user],
	);
});
test("quiet hours defer native rows; revoke, replacement, expiration and membership loss prevent dispatch", async () => {
	await pool.query("delete from native_push_registration where user_id=$1", [
		user,
	]);
	const a = await device();
	await pool.query(
		"insert into user_pref(id,timezone,quiet_hours) values($1,'UTC',$2)",
		[user, { start: "00:00", end: "23:59" }],
	);
	await enqueue(new Date("2026-10-02T12:00:00Z"));
	expect(
		(
			await pool.query(
				"select next_attempt_at from notification_outbox where recipient_user_id=$1",
				[user],
			)
		).rows[0].next_attempt_at.toISOString(),
	).toBe("2026-10-02T23:59:00.000Z");
	await pool.query("delete from user_pref where id=$1", [user]);
	await pool.query(
		"delete from notification_outbox where recipient_user_id=$1",
		[user],
	);
	await enqueue();
	const [row] = await claimBatch(db, 100, "native-fixture");
	let calls = 0;
	const send = createSendFn({
		database: db,
		allowedPrivateCIDRs: [],
		deadlineMs: 2000,
		ackBaseUrl: null,
		nativeConfiguration: configuration,
		fetch: async () => {
			calls++;
			return new Response("", { status: 201 });
		},
	});
	await pool.query(
		"update session set expires_at=now()-interval '1 second' where id=$1",
		[a.session],
	);
	expect((await send(row, ctx.signal)).ok).toBe(false);
	await pool.query(
		"update session set expires_at=now()+interval '1 day' where id=$1",
		[a.session],
	);
	await pool.query("update user_device set revoked_at=now() where id=$1", [
		a.deviceId,
	]);
	expect((await send(row, ctx.signal)).ok).toBe(false);
	await pool.query("update user_device set revoked_at=null where id=$1", [
		a.deviceId,
	]);
	await pool.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[user, ws],
	);
	expect((await send(row, ctx.signal)).ok).toBe(false);
	await pool.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), user, ws],
	);
	await pool.query("delete from native_push_registration where id=$1", [a.id]);
	const replacement = await device();
	expect((await send(row, ctx.signal)).ok).toBe(false);
	expect(calls).toBe(0);
	expect(
		(
			await pool.query("select id from native_push_registration where id=$1", [
				replacement.id,
			])
		).rowCount,
	).toBe(1);
});
test("FCM uses operator authority and bounded opaque payload; only confirmed UNREGISTERED expires target", async () => {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const send = createNativePushSender({
		fcm: {
			projectId: "test-project",
			clientEmail: "server@test-project.iam.gserviceaccount.com",
			privateKey: keys.privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		},
	});
	let calls = 0;
	const fetch: typeof safeFetch = async (url, options = {}) => {
		calls++;
		if (String(url).endsWith("/token")) {
			const jwt = new URLSearchParams(options.body as string).get(
				"assertion",
			) as string;
			const [header, body, sig] = jwt.split(".");
			expect(
				verify(
					"RSA-SHA256",
					Buffer.from(`${header}.${body}`),
					keys.publicKey,
					Buffer.from(sig, "base64url"),
				),
			).toBe(true);
			expect(
				JSON.parse(Buffer.from(body, "base64url").toString()),
			).toMatchObject({
				iss: "server@test-project.iam.gserviceaccount.com",
				aud: "https://oauth2.googleapis.com/token",
				scope: "https://www.googleapis.com/auth/firebase.messaging",
			});
			return Response.json({
				access_token: "oauth-test-token",
				token_type: "Bearer",
				expires_in: 3600,
			});
		}
		expect(String(url)).toBe(
			"https://fcm.googleapis.com/v1/projects/test-project/messages:send",
		);
		expect(JSON.parse(options.body as string).message.android.priority).toBe(
			"high",
		);
		expect(JSON.parse(options.body as string).message.data).toEqual({
			version: "1",
			notificationId: "opaque",
			registrationId: "registration",
		});
		expect(new Headers(options.headers).get("authorization")).toBe(
			"Bearer oauth-test-token",
		);
		return Response.json(
			{
				error: {
					message: "secret-token",
					details: [
						{
							"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
							errorCode: "UNREGISTERED",
						},
					],
				},
			},
			{ status: 404 },
		);
	};
	const result = await send(
		{ provider: "fcm", token: "private-token" },
		{ version: "1", notificationId: "opaque", registrationId: "registration" },
		{ ...ctx, fetch },
		true,
	);
	expect(result.expired).toBe(true);
	expect(JSON.stringify(result)).not.toContain("secret-token");
	expect(calls).toBe(2);
});

test("FCM refresh is bounded, malformed OAuth and provider errors stay sanitized, and dispatch rechecks network policy", async () => {
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const config = {
		fcm: {
			projectId: "test-project",
			clientEmail: "server@test-project.iam.gserviceaccount.com",
			privateKey: keys.privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		},
	};
	const payload = {
		version: "1" as const,
		notificationId: "opaque",
		registrationId: "registration",
	};
	let oauth = 0,
		sends = 0;
	const fetch: typeof safeFetch = async (url) => {
		if (String(url).endsWith("/token")) {
			oauth++;
			return Response.json({
				access_token: `oauth-${oauth}`,
				token_type: "Bearer",
				expires_in: 3600,
			});
		}
		sends++;
		return new Response("", { status: sends === 1 ? 401 : 200 });
	};
	const sender = createNativePushSender(config);
	expect(
		(
			await sender({ provider: "fcm", token: "secret" }, payload, {
				...ctx,
				fetch,
			})
		).result.ok,
	).toBe(true);
	expect(oauth).toBe(2);
	expect(sends).toBe(2);
	expect(
		(
			await sender({ provider: "fcm", token: "secret" }, payload, {
				...ctx,
				fetch,
			})
		).result.ok,
	).toBe(true);
	expect(oauth).toBe(2);
	const malformed = await createNativePushSender(config)(
		{ provider: "fcm", token: "secret" },
		payload,
		{
			...ctx,
			fetch: async () =>
				Response.json({ access_token: "do-not-log", expires_in: 1e20 }),
		},
	);
	expect(malformed.result.ok).toBe(false);
	expect(JSON.stringify(malformed)).not.toContain("do-not-log");
	const unsafe = await createNativePushSender(configuration)(
		{
			provider: "unifiedpush",
			endpoint: "https://127.0.0.1/secret-endpoint",
			keys: {
				p256dh: pair.getPublicKey().toString("base64url"),
				auth: randomBytes(16).toString("base64url"),
			},
		},
		payload,
		ctx,
	);
	expect(unsafe.result).toMatchObject({ ok: false, policyRejected: true });
	expect(JSON.stringify(unsafe)).not.toContain("secret-endpoint");
});

test("runtime events and scheduler discover native targets under owner RLS and reject former members", async () => {
	await pool.query(
		"delete from notification_outbox where recipient_user_id=$1",
		[user],
	);
	await pool.query("delete from native_push_registration where user_id=$1", [
		user,
	]);
	const target = await device();
	const events = [
		{
			stamp: "runtime-event",
			recipientUserId: user,
			event: {
				kind: "assign" as const,
				taskId: task,
				taskTitle: "Private medication title",
				actorUserId: user,
			},
		},
	];
	expect(
		await enqueueEvents(runtimeDb, events, { maxQueuedPerUser: 100 }),
	).toBe(1);
	expect(
		await enqueueEvents(runtimeDb, events, { maxQueuedPerUser: 100 }),
	).toBe(0);
	const now = new Date();
	const reminder = `${now.getUTCHours().toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`;
	await pool.query("update task set due_at=$2,reminder_time=$3 where id=$1", [
		task,
		now,
		reminder,
	]);
	const result = await scanTick(runtimeDb, {
		now,
		timing: { tickMs: 1000, graceMs: 3600000, lateThresholdMs: 60000 },
	});
	expect(result.enqueued).toBe(1);
	const outbox = await pool.query(
		"select channel_kind,native_registration_id from notification_outbox where recipient_user_id=$1",
		[user],
	);
	expect(outbox.rows).toEqual([
		{ channel_kind: "nativepush", native_registration_id: target.id },
		{ channel_kind: "nativepush", native_registration_id: target.id },
	]);
	expect(
		(await runtimePool.query("select id from native_push_registration")).rows,
	).toEqual([]);
	expect((await runtimePool.query("select id from user_device")).rows).toEqual(
		[],
	);
	await pool.query(
		"delete from notification_outbox where recipient_user_id=$1",
		[user],
	);
	await pool.query("delete from reminder_state where recipient_user_id=$1", [
		user,
	]);
	await pool.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[user, ws],
	);
	expect(
		(
			await scanTick(runtimeDb, {
				now,
				timing: { tickMs: 1000, graceMs: 3600000, lateThresholdMs: 60000 },
			})
		).enqueued,
	).toBe(0);
	expect(
		(
			await pool.query(
				"select id from notification_outbox where recipient_user_id=$1",
				[user],
			)
		).rows,
	).toEqual([]);
});
