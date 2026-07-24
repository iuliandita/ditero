// Integration tests for the channel CRUD + test-send handlers
// (src/server/notifications/channels.ts). The properties under test are
// database-backed: what the config COLUMN actually holds (S0 -- a round-trip
// assertion alone passes against no encryption at all), the mask/restore
// round-trip against a real stored row, and verified_at bookkeeping. All
// outbound HTTP is an injected double.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as tables from "../../src/db/schema.ts";
import type { ChannelKind } from "../../src/domain/notification-channel.ts";
import { MASKED } from "../../src/domain/notification-channel.ts";
import type { ProviderResult } from "../../src/domain/notification-retry.ts";
import { decryptChannelConfig } from "../../src/security/channel-config.ts";
import { backfillChannelConfigs } from "../../src/security/encrypt-channel-configs.ts";
import { createFieldKeyRing } from "../../src/security/field-encryption.ts";
import type { ChannelAdapter } from "../../src/server/notifications/adapters/types.ts";
import {
	ACK_ACTION,
	ACK_VERIFY_ACTION,
	ackToken,
	hashAckToken,
	redeemAckCapability,
	VERIFY_TTL_MS,
} from "../../src/server/notifications/capability.ts";
import {
	ChannelError,
	deleteChannel,
	listChannels,
	saveChannel,
	testChannel,
} from "../../src/server/notifications/channels.ts";
import { createSendFn } from "../../src/server/notifications/dispatch.ts";
import { startSmtpSink } from "../support/smtp-sink.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const USER = "ch-user";
const OTHER = "ch-other";
// Only the verify-capability suite needs these: a reminder to point a
// (deliberately misdirected) verify capability at.
const WS = "ch-ws";
const LIST = "ch-list";
const TASK = "ch-task";
const RS = "ch-reminder";
const OCCURRENCE = new Date("2026-08-01T20:00:00Z");
const userIds = [USER, OTHER] as const;
const TOKEN = "tk_a_real_ntfy_secret";
const CONFIG = {
	serverUrl: "https://ntfy.example.test",
	topic: "alerts",
	token: TOKEN,
};

function stubAdapter(
	result: ProviderResult,
	kind: ChannelKind = "ntfy",
): {
	adapter: ChannelAdapter;
	sent: unknown[];
	ackUrls: (string | null | undefined)[];
} {
	const sent: unknown[] = [];
	const ackUrls: (string | null | undefined)[] = [];
	return {
		sent,
		ackUrls,
		adapter: {
			kind,
			async send(config, message) {
				sent.push(config);
				ackUrls.push(message.ackUrl);
				return result;
			},
		},
	};
}

// The raw token exists only inside the message the adapter was handed; nothing
// persists it (only its hash).
function tokenFrom(ackUrl: string | null | undefined): string {
	if (!ackUrl) throw new Error("test send carried no ack URL");
	return ackUrl.slice(ackUrl.lastIndexOf("/") + 1);
}

async function rawConfig(userId = USER): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ config: tables.notificationChannel.config })
		.from(tables.notificationChannel)
		.where(eq(tables.notificationChannel.userId, userId))
		.limit(1);
	return row.config as Record<string, unknown>;
}

beforeEach(async () => {
	await db
		.delete(tables.ackCapability)
		.where(inArray(tables.ackCapability.recipientUserId, [...userIds]));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	// The test-send budget is DB-backed and per user, so it carries across tests
	// in this file; the budget test owns its own capacity via the deps seam.
	await db.execute(
		sql`delete from rate_bucket where key like 'channel-test:%'`,
	);
	for (const id of userIds) {
		await db
			.insert(tables.user)
			.values({
				id,
				name: id,
				email: `${id}@t.dev`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoNothing();
	}
	await db
		.insert(tables.workspace)
		.values({ id: WS, name: "Channels WS", ownerId: USER, kind: "shared" })
		.onConflictDoNothing();
	// Owner membership so that a verify capability leaking into the reminder path
	// would actually SUCCEED there; without it the completion is denied and the
	// test would pass for the wrong reason.
	await db
		.insert(tables.membership)
		.values({ id: "ch-m-user", userId: USER, workspaceId: WS, role: "owner" })
		.onConflictDoNothing();
	await db
		.insert(tables.list)
		.values({
			id: LIST,
			workspaceId: WS,
			ownerId: USER,
			title: "Channels list",
			kind: "tasks",
			sortKey: "a0",
		})
		.onConflictDoNothing();
	await db
		.insert(tables.task)
		.values({ id: TASK, listId: LIST, title: "Walk the dog", sortKey: "a0" })
		.onConflictDoNothing();
	await db.delete(tables.reminderState).where(eq(tables.reminderState.id, RS));
	await db.insert(tables.reminderState).values({
		id: RS,
		taskId: TASK,
		occurrenceAt: OCCURRENCE,
		recipientUserId: USER,
		status: "pending",
		fireCount: 1,
	});
});

afterAll(async () => {
	await db
		.delete(tables.ackCapability)
		.where(inArray(tables.ackCapability.recipientUserId, [...userIds]));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	await db.delete(tables.reminderState).where(eq(tables.reminderState.id, RS));
	await db.delete(tables.task).where(eq(tables.task.id, TASK));
	await db.delete(tables.list).where(eq(tables.list.id, LIST));
	await db
		.delete(tables.membership)
		.where(eq(tables.membership.workspaceId, WS));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
	await pool.end();
});

describe("channel config at rest", () => {
	it("stores the token as ciphertext, never plaintext", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		const stored = await rawConfig();

		// The whole point of S0: the COLUMN must not contain the secret.
		expect(JSON.stringify(stored)).not.toContain(TOKEN);
		expect(stored.token).toMatch(/^ditero:v1:/);
		// Public fields stay readable so operators can inspect a config.
		expect(stored.serverUrl).toBe(CONFIG.serverUrl);
		expect(stored.topic).toBe(CONFIG.topic);
	});

	it("hands the send path cleartext again", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		const { adapter, sent } = stubAdapter({ ok: true, status: 200 });
		const send = createSendFn({
			database: db,
			allowedPrivateCIDRs: [],
			deadlineMs: 1_000,
			ackBaseUrl: null,
			adapters: { ntfy: adapter },
		});
		const result = await send(
			{
				id: "ch-outbox",
				reminderStateId: null,
				recipientUserId: USER,
				channelKind: "ntfy",
				payload: {
					kind: "assign",
					taskTitle: "Walk the dog",
				},
				attempts: 0,
			} as never,
			new AbortController().signal,
		);

		expect(result.ok).toBe(true);
		expect(sent[0]).toEqual(CONFIG);
	});

	// The default adapter table, not an injected one: a channel registered in
	// channels.ts but missing from dispatch.ts would save cleanly and then be
	// permanently undeliverable, which no unit test of either file can see.
	// Driven into a real SMTP server for the same reason the M3a rig exists.
	it("delivers an email notification through the registered adapter", async () => {
		const sink = await startSmtpSink();
		const previous = { ...process.env };
		Object.assign(process.env, {
			DITERO_SMTP_HOST: sink.host,
			DITERO_SMTP_PORT: String(sink.port),
			DITERO_SMTP_ALLOW_INSECURE: "true",
			DITERO_SMTP_FROM: "ditero@example.test",
		});
		try {
			await saveChannel(db, USER, {
				kind: "email",
				config: { address: "recipient@example.test" },
			});
			const send = createSendFn({
				database: db,
				allowedPrivateCIDRs: [],
				deadlineMs: 5_000,
				ackBaseUrl: null,
			});
			const result = await send(
				{
					id: "ch-outbox-email",
					reminderStateId: null,
					recipientUserId: USER,
					channelKind: "email",
					payload: { kind: "assign", taskTitle: "Walk the dog" },
					attempts: 0,
				} as never,
				new AbortController().signal,
			);

			expect(result.ok).toBe(true);
			expect(sink.commands).toContainEqual("RCPT TO:<recipient@example.test>");
			expect(sink.messages[0]).toContain("Subject: Walk the dog");
		} finally {
			for (const key of Object.keys(process.env)) {
				if (!(key in previous)) delete process.env[key];
			}
			Object.assign(process.env, previous);
			await sink.close();
		}
	});
});

describe("backfill / rotation script", () => {
	const KEY = process.env.DITERO_ENCRYPTION_KEY as string;
	const NEXT = Buffer.alloc(32, 9).toString("base64");

	async function seedRaw(config: Record<string, unknown>) {
		await db.insert(tables.notificationChannel).values({
			id: "ch-raw",
			userId: USER,
			kind: "ntfy",
			config,
			enabled: true,
		});
	}

	it("envelopes a legacy plaintext row", async () => {
		await seedRaw(CONFIG);
		const changed = await backfillChannelConfigs(
			pool,
			createFieldKeyRing({ current: KEY }),
		);
		expect(changed).toBe(1);

		const stored = await rawConfig();
		expect(JSON.stringify(stored)).not.toContain(TOKEN);
		expect(stored.token).toMatch(/^ditero:v1:/);
		// Still readable through the normal path.
		const [view] = await listChannels(db, USER);
		expect(view.config.serverUrl).toBe(CONFIG.serverUrl);
	});

	it("is a no-op on a second run", async () => {
		await seedRaw(CONFIG);
		const ring = createFieldKeyRing({ current: KEY });
		expect(await backfillChannelConfigs(pool, ring)).toBe(1);
		expect(await backfillChannelConfigs(pool, ring)).toBe(0);
	});

	// The rotation the runbook promises. encryptChannelConfig alone reports
	// "rewrote 0 rows" here and leaves every secret under the retired key.
	it("moves an already-enveloped secret onto the next key", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		const before = await rawConfig();

		const changed = await backfillChannelConfigs(
			pool,
			createFieldKeyRing({ current: KEY, next: NEXT }),
		);
		expect(changed).toBe(1);
		const after = await rawConfig();
		expect(after.token).not.toBe(before.token);

		// Decryptable with the NEW key alone: the operator can now retire the old.
		expect(
			decryptChannelConfig("ntfy", after, createFieldKeyRing({ current: NEXT }))
				.token,
		).toBe(TOKEN);
	});

	// The lost-update case. The write lands INSIDE the backfill's run, in the
	// window between the id scan and the row's own transaction -- the exact
	// interleaving a version that captured `config` up front would clobber.
	// (SELECT ... FOR UPDATE additionally covers the truly-concurrent window,
	// which a single-process test cannot hit deterministically.)
	it("does not clobber a config written while it runs", async () => {
		await seedRaw(CONFIG);
		let wrote = false;
		await backfillChannelConfigs(pool, createFieldKeyRing({ current: KEY }), {
			onBeforeRow: async () => {
				if (wrote) return;
				wrote = true;
				await saveChannel(db, USER, {
					kind: "ntfy",
					config: { ...CONFIG, token: "tk_written_during_backfill" },
				});
			},
		});
		expect(wrote).toBe(true);

		const stored = await rawConfig();
		expect(
			decryptChannelConfig("ntfy", stored, createFieldKeyRing({ current: KEY }))
				.token,
		).toBe("tk_written_during_backfill");
	});
});

describe("channel reads never leak the secret", () => {
	it("masks the token and keeps the public fields", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		const [view] = await listChannels(db, USER);
		expect(view.config).toEqual({
			serverUrl: CONFIG.serverUrl,
			topic: CONFIG.topic,
			token: MASKED,
		});
		expect(JSON.stringify(view)).not.toContain(TOKEN);
	});

	it("scopes reads to the caller", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		expect(await listChannels(db, OTHER)).toEqual([]);
	});
});

describe("mask/restore round trip", () => {
	it("saving MASKED back preserves the stored secret", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		const before = await rawConfig();

		await saveChannel(db, USER, {
			kind: "ntfy",
			config: { serverUrl: CONFIG.serverUrl, topic: "moved", token: MASKED },
		});

		const { adapter, sent } = stubAdapter({ ok: true, status: 200 });
		await testChannel(
			db,
			USER,
			{
				kind: "ntfy",
				config: { serverUrl: CONFIG.serverUrl, topic: "moved", token: MASKED },
			},
			{ adapters: { ntfy: adapter } },
		);
		expect(sent[0]).toEqual({ ...CONFIG, topic: "moved" });
		// A fresh envelope (new nonce), same plaintext.
		expect(await rawConfig()).not.toEqual(before);
	});

	it("a typed-over secret replaces the stored one", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		await saveChannel(db, USER, {
			kind: "ntfy",
			config: { ...CONFIG, token: "tk_rotated" },
		});
		const { adapter, sent } = stubAdapter({ ok: true, status: 200 });
		await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: { ...CONFIG, token: MASKED } },
			{ adapters: { ntfy: adapter } },
		);
		expect(sent[0]).toEqual({ ...CONFIG, token: "tk_rotated" });
	});

	it("MASKED with no stored row is rejected, never stored literally", async () => {
		await expect(
			saveChannel(db, USER, {
				kind: "ntfy",
				config: { serverUrl: MASKED, topic: "alerts" },
			}),
		).rejects.toBeInstanceOf(ChannelError);
	});
});

describe("test send", () => {
	it("marks the channel verified on success", async () => {
		const { adapter } = stubAdapter({ ok: true, status: 200 });
		const result = await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: CONFIG },
			{ adapters: { ntfy: adapter } },
		);
		expect(result.ok).toBe(true);
		const [view] = await listChannels(db, USER);
		expect(view.verifiedAt).not.toBeNull();
	});

	it("reports a redacted category on failure and leaves it unverified", async () => {
		const { adapter } = stubAdapter({
			ok: false,
			status: 401,
			error: `ntfy 401 from https://ntfy.example.test/alerts?auth=${TOKEN}`,
		});
		const result = await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: CONFIG },
			{ adapters: { ntfy: adapter } },
		);
		expect(result).toEqual({
			ok: false,
			reason: "Server rejected the request",
		});
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		const [view] = await listChannels(db, USER);
		expect(view.verifiedAt).toBeNull();
	});

	it("classifies an unreachable server and a timeout distinctly", async () => {
		const unreachable = stubAdapter({
			ok: false,
			error: "ntfy: https://ntfy.example.test/alerts failed: fetch failed",
		});
		expect(
			await testChannel(
				db,
				USER,
				{ kind: "ntfy", config: CONFIG },
				{ adapters: { ntfy: unreachable.adapter } },
			),
		).toEqual({ ok: false, reason: "Could not reach the server" });

		const timeout = stubAdapter({
			ok: false,
			error:
				"ntfy: https://ntfy.example.test/alerts failed: The operation was aborted",
		});
		expect(
			await testChannel(
				db,
				USER,
				{ kind: "ntfy", config: CONFIG },
				{ adapters: { ntfy: timeout.adapter } },
			),
		).toEqual({ ok: false, reason: "Request timed out" });
	});

	// An authenticated caller could otherwise drive unbounded outbound traffic
	// at arbitrary public hosts through the instance.
	it("spends a per-user budget and refuses beyond it", async () => {
		const { adapter, sent } = stubAdapter({ ok: true, status: 200 });
		// refillPerSec 0 would make the refill branch unreachable; use a real
		// rate that simply cannot refill within the test's wall time.
		const deps = {
			adapters: { ntfy: adapter },
			rateCapacity: 2,
			rateRefillPerSec: 1 / 3_600,
		};
		const body = { kind: "ntfy", config: CONFIG };

		await testChannel(db, USER, body, deps);
		await testChannel(db, USER, body, deps);
		await expect(testChannel(db, USER, body, deps)).rejects.toMatchObject({
			status: 429,
		});
		// The refused call must not have sent, and must not have rewritten the row.
		expect(sent).toHaveLength(2);

		// The budget is per user: a different caller is unaffected.
		expect(await testChannel(db, OTHER, body, deps)).toMatchObject({
			ok: true,
		});
	});

	// The stored config comes back through JSONB, which normalises key order,
	// while the parsed one carries the Zod shape's. A plain stringify comparison
	// made every save look changed and silently reset verified_at.
	it("an unchanged config keeps the verification", async () => {
		const { adapter } = stubAdapter({ ok: true, status: 200 });
		await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: CONFIG },
			{ adapters: { ntfy: adapter } },
		);
		const before = (await listChannels(db, USER))[0].verifiedAt;
		expect(before).not.toBeNull();

		await saveChannel(db, USER, {
			kind: "ntfy",
			config: { ...CONFIG, token: MASKED },
		});
		expect((await listChannels(db, USER))[0].verifiedAt).toBe(before);
	});

	it("a changed config clears a previous verification", async () => {
		const { adapter } = stubAdapter({ ok: true, status: 200 });
		await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: CONFIG },
			{ adapters: { ntfy: adapter } },
		);
		await saveChannel(db, USER, {
			kind: "ntfy",
			config: { ...CONFIG, topic: "elsewhere" },
		});
		const [view] = await listChannels(db, USER);
		expect(view.verifiedAt).toBeNull();
	});
});

describe("input validation", () => {
	it("rejects an unimplemented channel kind", async () => {
		await expect(
			saveChannel(db, USER, { kind: "telegram", config: {} }),
		).rejects.toBeInstanceOf(ChannelError);
	});

	// Design 3.1: an app-mode button is acked through an interactions endpoint on
	// this deployment's public origin. Saved without one, the channel would look
	// configured and deliver buttons nothing can answer.
	describe("app mode without a public base URL", () => {
		const APP = {
			kind: "discord",
			config: {
				mode: "app",
				botToken: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.bot-secret",
				publicKey: "a".repeat(64),
				channelId: "1234567890123456789",
			},
		};
		const WEBHOOK = {
			kind: "discord",
			config: {
				mode: "webhook",
				webhookUrl: "https://discord.com/api/webhooks/123456789/wh-secret-xyz",
			},
		};
		const noPublicUrl = {
			...process.env,
			DITERO_PUBLIC_URL: "",
			BETTER_AUTH_URL: "",
		};
		const withPublicUrl = {
			...noPublicUrl,
			DITERO_PUBLIC_URL: "https://app.example.test",
		};

		it("is rejected and stores nothing", async () => {
			await expect(
				saveChannel(db, USER, APP, noPublicUrl),
			).rejects.toBeInstanceOf(ChannelError);
			expect(await listChannels(db, USER)).toEqual([]);
		});

		it("is accepted once one is configured", async () => {
			const view = await saveChannel(db, USER, APP, withPublicUrl);
			expect(view.config).toMatchObject({ mode: "app", botToken: MASKED });
			expect(JSON.stringify(await rawConfig())).not.toContain("bot-secret");
		});

		// The gate is app-mode only: webhook mode needs no endpoint of ours.
		it("does not block webhook mode", async () => {
			const view = await saveChannel(db, USER, WEBHOOK, noPublicUrl);
			expect(view.config).toMatchObject({ mode: "webhook" });
		});
	});

	// Design 3.3: the SMTP host, port and credentials are operator env, never per
	// user, so on a deployment with no SMTP an email channel would save cleanly,
	// render as configured, and silently never deliver. Same shape as the
	// app-mode gate above, for the same reason.
	describe("email without SMTP configured", () => {
		const EMAIL = {
			kind: "email",
			config: { address: "someone@example.test" },
		};
		const noSmtp = { ...process.env, DITERO_SMTP_HOST: "" };
		const withSmtp = {
			...noSmtp,
			DITERO_SMTP_HOST: "smtp.example.test",
			DITERO_SMTP_FROM: "ditero@example.test",
		};

		it("is rejected and stores nothing", async () => {
			await expect(saveChannel(db, USER, EMAIL, noSmtp)).rejects.toBeInstanceOf(
				ChannelError,
			);
			expect(await listChannels(db, USER)).toEqual([]);
		});

		it("is accepted once a transport exists", async () => {
			const view = await saveChannel(db, USER, EMAIL, withSmtp);
			// The address is a destination, not a credential: public by the same
			// rule as chatId and channelId.
			expect(view.config).toEqual({ address: "someone@example.test" });
		});
	});

	it("rejects an unknown kind", async () => {
		await expect(
			saveChannel(db, USER, { kind: "carrier-pigeon", config: {} }),
		).rejects.toBeInstanceOf(ChannelError);
	});

	it("rejects an oversized field and an unknown config key", async () => {
		await expect(
			saveChannel(db, USER, {
				kind: "ntfy",
				config: { ...CONFIG, topic: "x".repeat(5_000) },
			}),
		).rejects.toBeInstanceOf(ChannelError);
		await expect(
			saveChannel(db, USER, {
				kind: "ntfy",
				config: { ...CONFIG, sneaky: "value" },
			}),
		).rejects.toBeInstanceOf(ChannelError);
	});

	// The settings toggle sends `enabled` alone. It must not be able to blank a
	// stored config, nor reset verified_at through the changed-config branch.
	it("an enabled-only write preserves the config and the verification", async () => {
		const { adapter } = stubAdapter({ ok: true, status: 200 });
		await testChannel(
			db,
			USER,
			{ kind: "ntfy", config: CONFIG },
			{ adapters: { ntfy: adapter } },
		);
		const verifiedBefore = (await listChannels(db, USER))[0].verifiedAt;
		expect(verifiedBefore).not.toBeNull();

		await saveChannel(db, USER, { kind: "ntfy", enabled: false });
		const [view] = await listChannels(db, USER);
		expect(view.enabled).toBe(false);
		expect(view.verifiedAt).toBe(verifiedBefore);
		expect(view.config).toEqual({
			serverUrl: CONFIG.serverUrl,
			topic: CONFIG.topic,
			token: MASKED,
		});
		// The secret survived, not just the public half.
		const stored = await rawConfig();
		expect(
			decryptChannelConfig(
				"ntfy",
				stored,
				createFieldKeyRing({
					current: process.env.DITERO_ENCRYPTION_KEY as string,
				}),
			).token,
		).toBe(TOKEN);
	});

	it("an enabled-only write with no stored row is rejected", async () => {
		await expect(
			saveChannel(db, USER, { kind: "ntfy", enabled: true }),
		).rejects.toBeInstanceOf(ChannelError);
	});

	it("delete removes only the caller's row", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG });
		await saveChannel(db, OTHER, { kind: "ntfy", config: CONFIG });
		expect(await deleteChannel(db, USER, { kind: "ntfy" })).toEqual({
			deleted: true,
		});
		expect(await listChannels(db, USER)).toEqual([]);
		expect(await listChannels(db, OTHER)).toHaveLength(1);
	});
});

// The verify half of the ack mechanism had no test at any level, and it is the
// half that made ack_capability.reminder_state_id nullable. Everything below is
// about what a verify capability may and may not do.
describe("verify capability", () => {
	const ENV = { ...process.env, DITERO_PUBLIC_URL: "https://app.example.test" };

	async function channelRow(kind: ChannelKind = "ntfy", userId = USER) {
		const [row] = await db
			.select()
			.from(tables.notificationChannel)
			.where(
				and(
					eq(tables.notificationChannel.userId, userId),
					eq(tables.notificationChannel.kind, kind),
				),
			);
		return row;
	}

	async function capabilities(userId = USER) {
		return await db
			.select()
			.from(tables.ackCapability)
			.where(eq(tables.ackCapability.recipientUserId, userId));
	}

	async function mint(
		fields: Partial<typeof tables.ackCapability.$inferInsert> = {},
	) {
		const token = ackToken();
		await db.insert(tables.ackCapability).values({
			id: `ch-cap-${randomUUID()}`,
			tokenHash: hashAckToken(token),
			reminderStateId: null,
			recipientUserId: USER,
			action: ACK_VERIFY_ACTION,
			channelKind: "ntfy",
			expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
			...fields,
		});
		return token;
	}

	// Sends and returns the raw token the message carried.
	async function sendTest(kind: ChannelKind, config: Record<string, unknown>) {
		const stub = stubAdapter({ ok: true, status: 200 }, kind);
		await testChannel(
			db,
			USER,
			{ kind, config },
			{ adapters: { [kind]: stub.adapter }, env: ENV },
		);
		return tokenFrom(stub.ackUrls[0]);
	}

	it("mints one bound to the channel with no reminder to ack", async () => {
		await sendTest("ntfy", CONFIG);
		const [cap] = await capabilities();
		expect(cap.action).toBe(ACK_VERIFY_ACTION);
		expect(cap.reminderStateId).toBeNull();
		expect(cap.channelKind).toBe("ntfy");
		expect(cap.consumedAt).toBeNull();
		// The 1h test TTL, not the reminder ladder's 24h: nothing escalates a test.
		const ttl = cap.expiresAt.getTime() - cap.createdAt.getTime();
		expect(Math.abs(ttl - VERIFY_TTL_MS)).toBeLessThan(5_000);
	});

	it("stamps both timestamps and clears the last error when redeemed", async () => {
		const token = await sendTest("ntfy", CONFIG);
		await db
			.update(tables.notificationChannel)
			.set({
				verifiedAt: null,
				ackVerifiedAt: null,
				lastErrorAt: new Date(),
				lastErrorCode: "auth",
			})
			.where(eq(tables.notificationChannel.userId, USER));

		expect(await redeemAckCapability(db, token, "capability")).toBe(USER);
		const row = await channelRow();
		expect(row.verifiedAt).not.toBeNull();
		expect(row.ackVerifiedAt).not.toBeNull();
		expect(row.lastErrorAt).toBeNull();
		expect(row.lastErrorCode).toBeNull();
	});

	// The outbound leg alone never sets it: that is the whole point of the
	// column. A Discord app-mode row whose button was dropped must not read
	// "Verified".
	it("is the only thing that sets ack_verified_at", async () => {
		await sendTest("ntfy", CONFIG);
		const row = await channelRow();
		expect(row.verifiedAt).not.toBeNull();
		expect(row.ackVerifiedAt).toBeNull();
	});

	it("never reaches the reminder path even when it names a reminder", async () => {
		const token = await mint({ reminderStateId: RS });
		expect(await redeemAckCapability(db, token, "capability")).toBe(USER);
		const [reminder] = await db
			.select()
			.from(tables.reminderState)
			.where(eq(tables.reminderState.id, RS));
		expect(reminder.ackedAt).toBeNull();
		expect(reminder.status).toBe("pending");
	});

	it("a complete capability cannot stamp a channel", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG }, ENV);
		const token = await mint({ action: ACK_ACTION, reminderStateId: null });
		expect(await redeemAckCapability(db, token, "capability")).toBeNull();
		const row = await channelRow();
		expect(row.verifiedAt).toBeNull();
		expect(row.ackVerifiedAt).toBeNull();
	});

	it("rejects one that outlived the 1h TTL", async () => {
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG }, ENV);
		const dead = await mint({
			expiresAt: new Date(Date.now() - 1),
		});
		expect(await redeemAckCapability(db, dead, "capability")).toBeNull();
		expect((await channelRow()).ackVerifiedAt).toBeNull();

		// Control at the other side of the boundary, so the assertion above is
		// about expiry and not about the fixture being unredeemable.
		const alive = await mint({
			expiresAt: new Date(Date.now() + VERIFY_TTL_MS - 60_000),
		});
		expect(await redeemAckCapability(db, alive, "capability")).toBe(USER);
		expect((await channelRow()).ackVerifiedAt).not.toBeNull();
	});

	// Stamping "verified" claims THAT channel's inbound leg works. A Discord
	// capability redeemed through the Slack listener would claim it for a path
	// Discord never exercised.
	it("refuses a redemption through another channel's listener", async () => {
		await saveChannel(
			db,
			USER,
			{
				kind: "discord",
				config: {
					mode: "webhook",
					webhookUrl: "https://discord.com/api/webhooks/1/wh-secret",
				},
			},
			ENV,
		);
		await saveChannel(db, USER, { kind: "ntfy", config: CONFIG }, ENV);

		const wrong = await mint({ channelKind: "discord" });
		expect(await redeemAckCapability(db, wrong, "slack")).toBeNull();
		expect((await channelRow("discord")).ackVerifiedAt).toBeNull();
		expect((await channelRow("ntfy")).ackVerifiedAt).toBeNull();

		const right = await mint({ channelKind: "discord" });
		expect(await redeemAckCapability(db, right, "discord")).toBe(USER);
		expect((await channelRow("discord")).ackVerifiedAt).not.toBeNull();
		// Only the bound channel; the sibling row is untouched.
		expect((await channelRow("ntfy")).ackVerifiedAt).toBeNull();
	});

	// Nulling verified_at on a config change is only half of it: the capability
	// is bound to (recipient, kind) and nothing else, so an outstanding one would
	// stamp a config it was never sent to.
	it("is invalidated when the config it was minted for changes", async () => {
		const token = await sendTest("ntfy", CONFIG);
		await saveChannel(
			db,
			USER,
			{ kind: "ntfy", config: { ...CONFIG, topic: "elsewhere" } },
			ENV,
		);
		expect(await capabilities()).toEqual([]);
		expect(await redeemAckCapability(db, token, "capability")).toBeNull();
		const row = await channelRow();
		expect(row.verifiedAt).toBeNull();
		expect(row.ackVerifiedAt).toBeNull();
	});

	// An unchanged re-save must not throw away a capability the user is about to
	// tap on their phone.
	it("survives a save that changes nothing", async () => {
		const token = await sendTest("ntfy", CONFIG);
		await saveChannel(
			db,
			USER,
			{ kind: "ntfy", config: { ...CONFIG, token: MASKED } },
			ENV,
		);
		expect(await redeemAckCapability(db, token, "capability")).toBe(USER);
	});
});
