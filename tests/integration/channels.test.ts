// Integration tests for the channel CRUD + test-send handlers
// (src/server/notifications/channels.ts). The properties under test are
// database-backed: what the config COLUMN actually holds (S0 -- a round-trip
// assertion alone passes against no encryption at all), the mask/restore
// round-trip against a real stored row, and verified_at bookkeeping. All
// outbound HTTP is an injected double.
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { MASKED } from "../../src/domain/notification-channel.ts";
import type { ProviderResult } from "../../src/domain/notification-retry.ts";
import { decryptChannelConfig } from "../../src/security/channel-config.ts";
import { backfillChannelConfigs } from "../../src/security/encrypt-channel-configs.ts";
import { createFieldKeyRing } from "../../src/security/field-encryption.ts";
import type { ChannelAdapter } from "../../src/server/notifications/adapters/types.ts";
import {
	ChannelError,
	deleteChannel,
	listChannels,
	saveChannel,
	testChannel,
} from "../../src/server/notifications/channels.ts";
import { createSendFn } from "../../src/server/notifications/dispatch.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const USER = "ch-user";
const OTHER = "ch-other";
const userIds = [USER, OTHER] as const;
const TOKEN = "tk_a_real_ntfy_secret";
const CONFIG = {
	serverUrl: "https://ntfy.example.test",
	topic: "alerts",
	token: TOKEN,
};

function stubAdapter(result: ProviderResult): {
	adapter: ChannelAdapter;
	sent: unknown[];
} {
	const sent: unknown[] = [];
	return {
		sent,
		adapter: {
			kind: "ntfy",
			async send(config) {
				sent.push(config);
				return result;
			},
		},
	};
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
});

afterAll(async () => {
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
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
