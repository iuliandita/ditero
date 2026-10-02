import {
	createECDH,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import { withUserContext } from "../../src/db/user-context.ts";
import {
	decryptChannelConfig,
	encryptChannelConfig,
} from "../../src/security/channel-config.ts";
import {
	backfillCredentialConfigs,
	backfillNativePushConfigs,
} from "../../src/security/encrypt-channel-configs.ts";
import {
	createFieldKeyRing,
	decryptField,
} from "../../src/security/field-encryption.ts";
import {
	type Sessions,
	s256Challenge,
} from "../../src/server/native-auth/contracts.ts";
import { revokeNativeSession } from "../../src/server/native-auth/revoke.ts";
import { lookupNativeSession } from "../../src/server/native-auth/session.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import {
	type PushConfiguration,
	parseRegistration,
	pushConfiguration,
} from "../../src/server/native-push/contracts.ts";
import { nativePushRoutes } from "../../src/server/native-push/routes.ts";
import {
	NativePushStore,
	nativePushConfigContext,
} from "../../src/server/native-push/store.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const admin = new Pool({ connectionString: url });
const suffix = randomBytes(8).toString("hex");
const role = `native_push_${suffix}`;
const password = randomBytes(24).toString("hex");
const roleUrl = new URL(url);
roleUrl.username = role;
roleUrl.password = password;
const pool = new Pool({ connectionString: roleUrl.toString(), max: 8 });
const ring = createFieldKeyRing({
	current: Buffer.alloc(32, 7).toString("base64"),
});
const users: string[] = [];
let sessions: Sessions;
let grants: NativeGrantStore;
let allow = true;
const pair = createECDH("prime256v1");
pair.generateKeys();
const configuration: PushConfiguration = {
	unifiedpush: {
		publicKey: pair.getPublicKey().toString("base64url"),
		privateKey: pair.getPrivateKey().toString("base64url"),
		subject: "mailto:push@example.test",
	},
	fcm: {
		projectId: "test-project",
		clientEmail: "server@test-project.iam.gserviceaccount.com",
		privateKey: "server-only-test-key",
	},
};
let routes: ReturnType<typeof nativePushRoutes>;
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on "user",session,user_device,native_auth_grant,native_session_link,native_push_registration to "${role}"`,
	);
	const adapter = (await auth.$context).internalAdapter;
	sessions = {
		createSession: (id) => adapter.createSession(id, false),
		deleteSession: (token) => adapter.deleteSession(token),
	};
	grants = new NativeGrantStore(pool, sessions);
	routes = nativePushRoutes({
		pool,
		ring,
		configuration,
		rateLimit: async () => allow,
	});
});
afterAll(async () => {
	await admin.query("delete from session where user_id=any($1::text[])", [
		users,
	]);
	await admin.query("delete from user_device where user_id=any($1::text[])", [
		users,
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [users]);
	await pool.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
async function actor() {
	const id = `native-push-${randomUUID()}`;
	users.push(id);
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[id, "Push test", `${id}@example.test`],
	);
	const browser = await sessions.createSession(id);
	const verifier = "p".repeat(43);
	const grant = await grants.create(s256Challenge(verifier), "Push device");
	expect(await grants.approve(grant.grantId, id, browser.id)).toBe("approved");
	const result = await grants.exchange(grant.grantId, verifier);
	if (result.kind !== "ok") throw new Error("Native exchange failed");
	const owner = await lookupNativeSession(pool, result.token);
	if (!owner) throw new Error("Native authority missing");
	return { ...result, browser, owner };
}
function call(
	path: string,
	token?: string,
	body?: unknown,
	extra: Record<string, string> = {},
	app = routes,
) {
	return app.handle(
		new Request(`http://localhost:3000/api/native/push/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...extra,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
async function checked(response: Response, status: number) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("set-cookie")).toBeNull();
	return response.json();
}
const fcm = { provider: "fcm", token: `native-token-${"a".repeat(64)}` };
function unified(endpoint = "https://93.184.216.34/opaque-push") {
	return {
		provider: "unifiedpush",
		endpoint,
		keys: {
			p256dh: pair.getPublicKey().toString("base64url"),
			auth: randomBytes(16).toString("base64url"),
		},
	};
}
test("real native admission exposes public config only and refuses mixed/browser/disabled credentials", async () => {
	const a = await actor();
	const config = await checked(await call("config", a.token), 200);
	expect(config).toEqual({
		deliveryReady: true,
		providers: { unifiedpush: true, fcm: true },
		vapidPublicKey: configuration.unifiedpush?.publicKey,
		fcmProjectId: "test-project",
	});
	expect(JSON.stringify(config)).not.toContain("server-only-test-key");
	for (const extra of [{ cookie: "" }, { origin: "" }] as Record<
		string,
		string
	>[])
		await checked(await call("register", a.token, fcm, extra), 400);
	await checked(await call("register", a.browser.token, fcm), 401);
	await checked(await call("config"), 401);
	const disabled = nativePushRoutes({
		pool,
		ring,
		configuration: {},
		rateLimit: async () => true,
	});
	await checked(await call("register", a.token, fcm, {}, disabled), 409);
	allow = false;
	try {
		await checked(await call("register", a.token, fcm), 429);
	} finally {
		allow = true;
	}
});
test("registration retries retain identity, replacements retire atomically, secrets are scoped ciphertext", async () => {
	const a = await actor();
	const first = await checked(await call("register", a.token, fcm), 200);
	expect(await checked(await call("register", a.token, fcm), 200)).toEqual(
		first,
	);
	const input = unified();
	const replaced = await checked(await call("register", a.token, input), 200);
	expect(replaced.registrationId).not.toBe(first.registrationId);
	const rows = await admin.query(
		"select * from native_push_registration where session_id=$1",
		[a.sessionId],
	);
	expect(rows.rowCount).toBe(1);
	const row = rows.rows[0];
	expect(row.config_ciphertext).not.toContain(input.endpoint);
	expect(
		JSON.parse(
			decryptField(
				row.config_ciphertext,
				`native-push:${row.id}:${a.owner.userId}:${a.sessionId}:${a.deviceId}`,
				ring,
			).plaintext,
		),
	).toEqual(input);
	expect(() =>
		decryptField(
			row.config_ciphertext,
			`native-push:${row.id}:other:${a.sessionId}:${a.deviceId}`,
			ring,
		),
	).toThrow();
	await checked(await call("unregister", a.token, {}), 200);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=$1",
				[a.sessionId],
			)
		).rowCount,
	).toBe(0);
});
test("closed body and endpoint policy reject caller authority, unsafe targets, malformed keys and oversized bodies", async () => {
	const a = await actor();
	for (const body of [
		{ ...fcm, userId: a.owner.userId },
		{ ...fcm, projectId: "attacker-project" },
		unified("http://93.184.216.34/push"),
		unified("https://user:secret@example.test/push"),
		{ ...unified(), keys: { p256dh: "a".repeat(87), auth: "a".repeat(22) } },
	])
		await checked(await call("register", a.token, body), 400);
	for (const target of [
		"https://127.0.0.1/push",
		"https://169.254.169.254/push",
		"https://[::1]/push",
	])
		await checked(await call("register", a.token, unified(target)), 400);
	await checked(
		await call("register", a.token, { ...fcm, token: "x".repeat(9000) }),
		413,
	);
	expect(parseRegistration({ ...fcm, provider: "unknown" })).toBeNull();
});
test("other native sessions cannot unregister or read a registration; native revoke cascades it", async () => {
	const a = await actor();
	const b = await actor();
	await checked(await call("register", a.token, fcm), 200);
	await checked(await call("unregister", b.token, {}), 200);
	const hidden = await withUserContext(pool, b.owner.userId, (client) =>
		client.query("select * from native_push_registration"),
	);
	expect(hidden.rowCount).toBe(0);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=$1",
				[a.sessionId],
			)
		).rowCount,
	).toBe(1);
	expect(await revokeNativeSession(pool, a.owner)).toBe(true);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=$1",
				[a.sessionId],
			)
		).rowCount,
	).toBe(0);
	await checked(await call("register", a.token, fcm), 401);
});
test("expiry and revocation after admission cannot install stale registrations", async () => {
	const a = await actor();
	const store = new NativePushStore(pool, ring);
	await admin.query(
		"update session set expires_at=now()-interval '1 second' where id=$1",
		[a.sessionId],
	);
	await expect(
		store.register(a.owner, { provider: "fcm", token: "stale-token" }),
	).rejects.toThrow();
	const b = await actor();
	await revokeNativeSession(pool, b.owner);
	await expect(
		store.register(b.owner, { provider: "fcm", token: "stale-token" }),
	).rejects.toThrow();
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=any($1::text[])",
				[[a.sessionId, b.sessionId]],
			)
		).rowCount,
	).toBe(0);
});

test("concurrent identical retries serialize on session authority and retain one identity", async () => {
	const a = await actor();
	const store = new NativePushStore(pool, ring);
	const input = { provider: "fcm" as const, token: "concurrent-token" };
	const results = await Promise.all(
		Array.from({ length: 4 }, () => store.register(a.owner, input)),
	);
	expect(new Set(results.map((result) => result.registrationId)).size).toBe(1);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=$1",
				[a.sessionId],
			)
		).rowCount,
	).toBe(1);
});
test("revocation during endpoint validation refuses installation with exact native unauthorized", async () => {
	const a = await actor();
	const app = nativePushRoutes({
		pool,
		ring,
		configuration,
		rateLimit: async () => true,
		validateEndpoint: async () => {
			await revokeNativeSession(pool, a.owner);
		},
	});
	expect(
		await checked(await call("register", a.token, unified(), {}, app), 401),
	).toEqual({ code: "unauthorized" });
	expect(
		(
			await admin.query(
				"select id from native_push_registration where session_id=$1",
				[a.sessionId],
			)
		).rowCount,
	).toBe(0);
});

test("operator configuration requires matched VAPID identity and a protected matching-project service account", () => {
	const vapid = configuration.unifiedpush;
	if (!vapid) throw new Error("Missing fixture VAPID");
	const env = {
		DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey,
		DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey,
		DITERO_NATIVE_PUSH_VAPID_SUBJECT: vapid.subject,
	};
	expect(pushConfiguration(env).unifiedpush).toEqual(vapid);
	expect(pushConfiguration({})).toEqual({});
	expect(() =>
		pushConfiguration({ DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey }),
	).toThrow();
	const other = createECDH("prime256v1");
	other.generateKeys();
	expect(() =>
		pushConfiguration({
			...env,
			DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY: other
				.getPrivateKey()
				.toString("base64url"),
		}),
	).toThrow();
	const directory = mkdtempSync(join(tmpdir(), "ditero-native-push-"));
	const file = join(directory, "service-account.json");
	const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
		.privateKey.export({ type: "pkcs8", format: "pem" })
		.toString();
	const account = {
		type: "service_account",
		project_id: "test-project",
		client_email: "server@test-project.iam.gserviceaccount.com",
		private_key: privateKey,
	};
	try {
		writeFileSync(file, JSON.stringify(account), { mode: 0o600 });
		const parsed = pushConfiguration({
			DITERO_NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE: file,
		});
		expect(parsed.fcm).toEqual({
			projectId: account.project_id,
			clientEmail: account.client_email,
			privateKey,
		});
		writeFileSync(
			file,
			JSON.stringify({
				...account,
				client_email: "server@other-project.iam.gserviceaccount.com",
			}),
		);
		expect(() =>
			pushConfiguration({ DITERO_NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE: file }),
		).toThrow();
		writeFileSync(file, JSON.stringify(account));
		if (process.platform !== "win32") {
			chmodSync(file, 0o644);
			expect(() =>
				pushConfiguration({
					DITERO_NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE: file,
				}),
			).toThrow();
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("the CLI credential pass rotates both channels and native push before old key retirement and is idempotent", async () => {
	const a = await actor();
	const store = new NativePushStore(pool, ring);
	const input = { provider: "fcm" as const, token: "rotation-token" };
	const registration = await store.register(a.owner, input);
	const channel = randomUUID();
	const nextKey = Buffer.alloc(32, 9).toString("base64");
	const rotating = createFieldKeyRing({
		current: Buffer.alloc(32, 7).toString("base64"),
		next: nextKey,
	});
	const retired = createFieldKeyRing({ current: nextKey });
	await admin.query(
		"insert into notification_channel(id,user_id,kind,config,enabled) values($1,$2,'ntfy',$3,true)",
		[
			channel,
			a.owner.userId,
			encryptChannelConfig(
				"ntfy",
				{
					serverUrl: "https://example.test",
					topic: "push",
					token: "channel-secret",
				},
				ring,
			),
		],
	);
	try {
		const before = (
			await admin.query(
				"select config_ciphertext from native_push_registration where id=$1",
				[registration.registrationId],
			)
		).rows[0].config_ciphertext;
		const aad = nativePushConfigContext(registration.registrationId, a.owner);
		expect(JSON.parse(decryptField(before, aad, rotating).plaintext)).toEqual(
			input,
		);
		expect(
			await backfillCredentialConfigs(admin, rotating),
		).toBeGreaterThanOrEqual(2);
		const after = (
			await admin.query(
				"select config_ciphertext from native_push_registration where id=$1",
				[registration.registrationId],
			)
		).rows[0].config_ciphertext;
		expect(after).not.toBe(before);
		expect(JSON.parse(decryptField(after, aad, retired).plaintext)).toEqual(
			input,
		);
		const config = (
			await admin.query("select config from notification_channel where id=$1", [
				channel,
			])
		).rows[0].config;
		expect(decryptChannelConfig("ntfy", config, retired).token).toBe(
			"channel-secret",
		);
		expect(await backfillCredentialConfigs(admin, rotating)).toBe(0);
		expect(await backfillCredentialConfigs(admin, retired)).toBe(0);
	} finally {
		await admin.query("delete from notification_channel where id=$1", [
			channel,
		]);
	}
});
test("backfill skips a retired ID and never overwrites concurrent registration replacement", async () => {
	const a = await actor();
	const old = await new NativePushStore(
		pool,
		createFieldKeyRing({ current: Buffer.alloc(32, 9).toString("base64") }),
	).register(a.owner, {
		provider: "fcm",
		token: "old-token",
	});
	const nextKey = Buffer.alloc(32, 11).toString("base64");
	const rotating = createFieldKeyRing({
		current: Buffer.alloc(32, 9).toString("base64"),
		next: nextKey,
	});
	let replacementId = "";
	await backfillNativePushConfigs(admin, rotating, {
		onBeforeRow: async (id) => {
			if (id !== old.registrationId) return;
			replacementId = (
				await new NativePushStore(pool, rotating).register(a.owner, {
					provider: "fcm",
					token: "new-token",
				})
			).registrationId;
		},
	});
	expect(replacementId).not.toBe("");
	expect(replacementId).not.toBe(old.registrationId);
	const rows = (
		await admin.query(
			"select id,config_ciphertext from native_push_registration where session_id=$1",
			[a.sessionId],
		)
	).rows;
	expect(rows).toHaveLength(1);
	expect(rows[0].id).toBe(replacementId);
	expect(
		JSON.parse(
			decryptField(
				rows[0].config_ciphertext,
				nativePushConfigContext(replacementId, a.owner),
				createFieldKeyRing({ current: nextKey }),
			).plaintext,
		),
	).toEqual({ provider: "fcm", token: "new-token" });
	expect(await backfillNativePushConfigs(admin, rotating)).toBe(0);
});
