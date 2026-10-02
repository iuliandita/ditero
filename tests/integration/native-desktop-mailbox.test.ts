import { randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { withUserContext } from "../../src/db/user-context.ts";
import {
	createFieldKeyRing,
	decryptField,
} from "../../src/security/field-encryption.ts";
import { lookupNativeSession } from "../../src/server/native-auth/session.ts";
import { nativePushRoutes } from "../../src/server/native-push/routes.ts";
import {
	NativePushStore,
	nativePushConfigContext,
} from "../../src/server/native-push/store.ts";
import type { AdapterContext } from "../../src/server/notifications/adapters/types.ts";
import { createNativeDelivery } from "../../src/server/notifications/native-delivery.ts";
import type { OutboxRow } from "../../src/server/notifications/worker.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");
const admin = new Pool({ connectionString: url });
const role = `desktop_mailbox_${randomBytes(8).toString("hex")}`;
const pool = new Pool({
	connectionString: url,
	options: `-c role=${role}`,
	max: 4,
});
const ring = createFieldKeyRing({
	current: Buffer.alloc(32, 7).toString("base64"),
});
const store = new NativePushStore(pool, ring);
const send = createNativeDelivery(drizzle(pool, { schema: tables }), ring, {});
const ctx: AdapterContext = {
	allowedPrivateCIDRs: [],
	deadlineMs: 2000,
	signal: new AbortController().signal,
	fetch: async () => {
		throw new Error("Desktop delivery must never use network transport");
	},
};
const users: string[] = [],
	workspaces: string[] = [];
beforeAll(async () => {
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on "user",session,user_device,native_session_link,native_push_registration,native_relay_authority,native_desktop_mailbox to "${role}"`,
	);
	await admin.query(
		`grant select,update on notification_outbox,task,list,workspace,membership to "${role}"`,
	);
});
afterAll(async () => {
	await admin.query(
		"delete from notification_outbox where recipient_user_id=any($1::text[])",
		[users],
	);
	await admin.query(
		"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
		[workspaces],
	);
	await admin.query("delete from list where workspace_id=any($1::text[])", [
		workspaces,
	]);
	await admin.query(
		"delete from membership where workspace_id=any($1::text[])",
		[workspaces],
	);
	await admin.query("delete from workspace where id=any($1::text[])", [
		workspaces,
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [users]);
	await pool.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
async function actor(existingUser?: string) {
	const userId = existingUser ?? randomUUID(),
		sessionId = randomUUID(),
		deviceId = randomUUID(),
		token = randomUUID();
	if (!existingUser) {
		users.push(userId);
		await admin.query(
			`insert into "user"(id,name,email,email_verified) values($1,'Desktop fixture',$2,true)`,
			[userId, `${userId}@example.test`],
		);
	}
	await admin.query(
		"insert into session(id,token,user_id,expires_at,created_at,updated_at) values($1,$2,$3,now()+interval '1 day',now(),now())",
		[sessionId, token, userId],
	);
	await admin.query(
		"insert into user_device(id,user_id,label) values($1,$2,'Desktop fixture')",
		[deviceId, userId],
	);
	await admin.query(
		"insert into native_session_link(session_id,user_id,device_id) values($1,$2,$3)",
		[sessionId, userId, deviceId],
	);
	const owner = await lookupNativeSession(pool, token);
	if (!owner) throw new Error("Native fixture authority missing");
	const registration = await store.register(owner, { provider: "desktop" });
	return { owner, token, registrationId: registration.registrationId };
}
async function fixture() {
	const a = await actor(),
		workspaceId = randomUUID(),
		listId = randomUUID(),
		taskId = randomUUID();
	workspaces.push(workspaceId);
	await admin.query(
		"insert into workspace(id,name,owner_id) values($1,'Desktop mailbox',$2)",
		[workspaceId, a.owner.userId],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), a.owner.userId, workspaceId],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Private list','a0')",
		[listId, workspaceId, a.owner.userId],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Private task','a0')",
		[taskId, listId],
	);
	async function notification(
		payload: unknown = { kind: "assign", taskId },
		createdAt = new Date(),
	) {
		const id = randomUUID();
		await admin.query(
			"insert into notification_outbox(id,recipient_user_id,native_registration_id,channel_kind,payload,idempotency_key,status,created_at) values($1,$2,$3,'nativepush',$4,$1,'sending',$5)",
			[
				id,
				a.owner.userId,
				a.registrationId,
				JSON.stringify(payload),
				createdAt,
			],
		);
		const row: OutboxRow = {
			id,
			recipientUserId: a.owner.userId,
			nativeRegistrationId: a.registrationId,
			channelKind: "nativepush",
			payload,
			reminderStateId: null,
			attempts: 1,
		};
		return {
			row,
			input: { notificationId: id, registrationId: a.registrationId },
		};
	}
	return { a, workspaceId, listId, taskId, notification };
}
function call(path: string, token: string, body: unknown) {
	const routes = nativePushRoutes({
		pool,
		ring,
		configuration: {},
		rateLimit: async () => true,
	});
	return routes.handle(
		new Request(`http://localhost/api/native/push/desktop/${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		}),
	);
}
test("desktop registration is encrypted, session-bound and retryable; receipt is idempotent and never completes a task", async () => {
	const f = await fixture(),
		n = await f.notification();
	expect(await store.register(f.a.owner, { provider: "desktop" })).toEqual({
		registrationId: f.a.registrationId,
		provider: "desktop",
	});
	const encrypted = (
		await admin.query(
			"select config_ciphertext from native_push_registration where id=$1",
			[f.a.registrationId],
		)
	).rows[0].config_ciphertext;
	expect(encrypted).not.toContain("desktop");
	expect(
		JSON.parse(
			decryptField(
				encrypted,
				nativePushConfigContext(f.a.registrationId, f.a.owner),
				ring,
			).plaintext,
		),
	).toEqual({ provider: "desktop" });
	expect(await send(n.row, ctx)).toEqual({ ok: true, status: 202 });
	expect(await send(n.row, ctx)).toEqual({ ok: true, status: 202 });
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toEqual([
		{ version: "1", ...n.input },
	]);
	expect(await store.receiptDesktop(f.a.owner, n.input)).toBe(true);
	const before = (
		await admin.query(
			"select received_at from native_desktop_mailbox where notification_id=$1",
			[n.row.id],
		)
	).rows[0].received_at;
	expect(await store.receiptDesktop(f.a.owner, n.input)).toBe(true);
	expect(
		(
			await admin.query(
				"select received_at from native_desktop_mailbox where notification_id=$1",
				[n.row.id],
			)
		).rows[0].received_at,
	).toEqual(before);
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toEqual([]);
	expect(
		(await admin.query("select done from task where id=$1", [f.taskId])).rows[0]
			.done,
	).toBe(false);
});
test("foreign users, other sessions, wrong providers and replaced registrations cannot poll or receive", async () => {
	const f = await fixture(),
		n = await f.notification(),
		foreign = await actor(),
		sameUser = await actor(f.a.owner.userId);
	expect((await send(n.row, ctx)).ok).toBe(true);
	for (const a of [foreign, sameUser]) {
		expect(await store.pollDesktop(a.owner, f.a.registrationId)).toBeNull();
		expect(await store.receiptDesktop(a.owner, n.input)).toBe(false);
		const response = await call("receipt", a.token, n.input);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ code: "notification-unavailable" });
	}
	expect(
		await store.receiptDesktop(f.a.owner, {
			...n.input,
			notificationId: randomUUID(),
		}),
	).toBe(false);
	const replacement = await store.register(f.a.owner, {
		provider: "fcm",
		token: "replacement",
	});
	expect(
		await store.pollDesktop(f.a.owner, replacement.registrationId),
	).toBeNull();
	expect(await store.receiptDesktop(f.a.owner, n.input)).toBe(false);
	expect(
		(
			await admin.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[n.row.id],
			)
		).rowCount,
	).toBe(0);
});
test("poll and receipt recheck task/key-grant membership and task existence after delivery", async () => {
	const f = await fixture(),
		n = await f.notification(),
		key = await f.notification({
			kind: "key_grant",
			workspaceId: f.workspaceId,
		});
	for (const row of [n.row, key.row])
		expect((await send(row, ctx)).ok).toBe(true);
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toHaveLength(
		2,
	);
	await admin.query("delete from membership where workspace_id=$1", [
		f.workspaceId,
	]);
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toEqual([]);
	for (const input of [n.input, key.input])
		expect(await store.receiptDesktop(f.a.owner, input)).toBe(false);
	const blocked = await f.notification();
	expect(await send(blocked.row, ctx)).toMatchObject({
		ok: false,
		policyRejected: true,
	});
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), f.a.owner.userId, f.workspaceId],
	);
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toHaveLength(
		2,
	);
	await admin.query("delete from task where id=$1", [f.taskId]);
	expect(await store.pollDesktop(f.a.owner, f.a.registrationId)).toEqual([
		{ version: "1", ...key.input },
	]);
	expect(await store.receiptDesktop(f.a.owner, n.input)).toBe(false);
	expect(await store.receiptDesktop(f.a.owner, key.input)).toBe(true);
});
test("expiry prevents enqueue/retrieval/receipt; bounded polling and the unread cap retain duplicate acceptance", async () => {
	const f = await fixture(),
		old = await f.notification(undefined, new Date(Date.now() - 25 * 3600_000)),
		n = await f.notification();
	expect(await send(old.row, ctx)).toMatchObject({
		ok: false,
		policyRejected: true,
	});
	expect(
		(
			await admin.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[old.row.id],
			)
		).rowCount,
	).toBe(0);
	expect((await send(n.row, ctx)).ok).toBe(true);
	await admin.query(
		`insert into notification_outbox(id,recipient_user_id,native_registration_id,channel_kind,payload,idempotency_key)
	 select $1||'-'||i,$2,$3,'nativepush',$4,$1||'-'||i from generate_series(1,499) i`,
		[
			randomUUID(),
			f.a.owner.userId,
			f.a.registrationId,
			JSON.stringify({ taskId: f.taskId }),
		],
	);
	await admin.query(
		`insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at)
	 select id,native_registration_id,recipient_user_id,created_at+interval '24 hours' from notification_outbox where native_registration_id=$1 on conflict do nothing`,
		[f.a.registrationId],
	);
	const messages = await store.pollDesktop(f.a.owner, f.a.registrationId);
	expect(messages).toHaveLength(20);
	expect(messages?.map((m) => m.notificationId)).toEqual(
		messages?.map((m) => m.notificationId).toSorted(),
	);
	expect((await send(n.row, ctx)).ok).toBe(true);
	const full = await f.notification();
	expect(await send(full.row, ctx)).toMatchObject({ ok: false, status: 429 });
	await admin.query(
		"update native_desktop_mailbox set expires_at=now()-interval '1 second' where notification_id=$1",
		[n.row.id],
	);
	expect(
		(await store.pollDesktop(f.a.owner, f.a.registrationId))?.some(
			(m) => m.notificationId === n.row.id,
		),
	).toBe(false);
	expect(await store.receiptDesktop(f.a.owner, n.input)).toBe(false);
	expect((await send(full.row, ctx)).ok).toBe(true);
});
test("mailbox RLS refuses cross-owner reads and writes, composite ownership and both cascades hold", async () => {
	const f = await fixture(),
		foreign = await actor(),
		n = await f.notification();
	expect((await send(n.row, ctx)).ok).toBe(true);
	expect(
		await withUserContext(pool, f.a.owner.userId, (c) =>
			c.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[n.row.id],
			),
		),
	).toMatchObject({ rowCount: 1 });
	expect(
		await withUserContext(pool, foreign.owner.userId, (c) =>
			c.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[n.row.id],
			),
		),
	).toMatchObject({ rowCount: 0 });
	expect(
		await withUserContext(pool, foreign.owner.userId, (c) =>
			c.query(
				"update native_desktop_mailbox set received_at=now() where notification_id=$1",
				[n.row.id],
			),
		),
	).toMatchObject({ rowCount: 0 });
	const blocked = await f.notification();
	await expect(
		withUserContext(pool, foreign.owner.userId, (c) =>
			c.query(
				"insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at) values($1,$2,$3,now()+interval '1 day')",
				[blocked.row.id, f.a.registrationId, f.a.owner.userId],
			),
		),
	).rejects.toThrow(/row-level security/);
	await expect(
		admin.query(
			"insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at) values($1,$2,$3,now()+interval '1 day')",
			[blocked.row.id, f.a.registrationId, foreign.owner.userId],
		),
	).rejects.toThrow(/foreign key/);
	await admin.query("delete from notification_outbox where id=$1", [n.row.id]);
	expect(
		(
			await admin.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[n.row.id],
			)
		).rowCount,
	).toBe(0);
	expect((await send(blocked.row, ctx)).ok).toBe(true);
	await store.unregister(f.a.owner);
	expect(
		(
			await admin.query(
				"select notification_id from native_desktop_mailbox where notification_id=$1",
				[blocked.row.id],
			)
		).rowCount,
	).toBe(0);
});
test("expired session, revoked device and account tombstone stop delivery and retrieval after admission", async () => {
	for (const retire of [
		async (a: Awaited<ReturnType<typeof actor>>) =>
			admin.query(
				"update session set expires_at=now()-interval '1 second' where id=$1",
				[a.owner.sessionId],
			),
		async (a: Awaited<ReturnType<typeof actor>>) =>
			admin.query("update user_device set revoked_at=now() where id=$1", [
				a.owner.deviceId,
			]),
		async (a: Awaited<ReturnType<typeof actor>>) =>
			admin.query('update "user" set deleted_at=now() where id=$1', [
				a.owner.userId,
			]),
	]) {
		const f = await fixture(),
			n = await f.notification();
		expect((await send(n.row, ctx)).ok).toBe(true);
		await retire(f.a);
		await expect(
			store.pollDesktop(f.a.owner, f.a.registrationId),
		).rejects.toThrow();
		await expect(store.receiptDesktop(f.a.owner, n.input)).rejects.toThrow();
		expect(await send(n.row, ctx)).toMatchObject({
			ok: false,
			policyRejected: true,
		});
	}
});

test("exact desktop retirement preserves replacements and foreign/session/provider registrations and works without a ring", async () => {
	const a = await actor(),
		foreign = await actor(),
		otherSession = await actor(a.owner.userId);
	const android = await store.register(a.owner, {
		provider: "fcm",
		token: "replacement-token",
	});
	await store.unregisterDesktop(a.owner, android.registrationId);
	expect(
		(
			await admin.query("select id from native_push_registration where id=$1", [
				android.registrationId,
			])
		).rowCount,
	).toBe(1);
	const replacement = await store.register(a.owner, { provider: "desktop" });
	expect(replacement.registrationId).not.toBe(a.registrationId);
	await store.unregisterDesktop(a.owner, a.registrationId);
	await store.unregisterDesktop(a.owner, a.registrationId);
	await store.unregisterDesktop(a.owner, foreign.registrationId);
	await store.unregisterDesktop(a.owner, otherSession.registrationId);
	await store.unregisterDesktop(otherSession.owner, replacement.registrationId);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where id=any($1::text[]) order by id",
				[
					[
						replacement.registrationId,
						foreign.registrationId,
						otherSession.registrationId,
					],
				],
			)
		).rows.map((row) => row.id),
	).toEqual(
		[
			replacement.registrationId,
			foreign.registrationId,
			otherSession.registrationId,
		].toSorted(),
	);
	const noRing = nativePushRoutes({
		pool,
		ring: null,
		configuration: {},
		rateLimit: async () => true,
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await noRing.handle(
			new Request("http://localhost/api/native/push/desktop/unregister", {
				method: "POST",
				headers: {
					authorization: `Bearer ${a.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ registrationId: replacement.registrationId }),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({ unregistered: true });
	}
	expect(
		(
			await admin.query("select id from native_push_registration where id=$1", [
				replacement.registrationId,
			])
		).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select id from native_push_registration where id=any($1::text[])",
				[[foreign.registrationId, otherSession.registrationId]],
			)
		).rowCount,
	).toBe(2);
});
