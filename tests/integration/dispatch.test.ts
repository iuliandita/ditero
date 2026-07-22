// Integration tests for the send side (src/server/notifications/dispatch.ts).
// The properties under test are database-backed: capability minting writes a
// real ack_capability row under a NOT NULL foreign key, channel resolution is a
// real query, and "every adapter result is recorded" is a delivery_attempt
// assertion. All outbound HTTP is an injected double -- these tests must never
// touch the network.
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkerTiming } from "../../src/config/worker.ts";
import * as tables from "../../src/db/schema.ts";
import type { ProviderResult } from "../../src/domain/notification-retry.ts";
import {
	OutboundPolicyError,
	type safeFetch,
} from "../../src/security/safe-http.ts";
import { ntfyAdapter } from "../../src/server/notifications/adapters/ntfy.ts";
import type {
	ChannelAdapter,
	ChannelPayload,
} from "../../src/server/notifications/adapters/types.ts";
import {
	ACK_ACTION,
	ACK_PATH,
	hashAckToken,
} from "../../src/server/notifications/capability.ts";
import { createSendFn } from "../../src/server/notifications/dispatch.ts";
import { workerTick } from "../../src/server/notifications/worker.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const OWNER = "dp-owner";
const OTHER = "dp-other";
const userIds = [OWNER, OTHER] as const;
const WS = "dp-w";
const LIST = "dp-list";
const TASK = "dp-task";
const OCCURRENCE = new Date("2026-08-01T09:00:00Z");
const REPLICA = "dispatch-a";
const ACK_BASE = "https://app.example.test";

const timing: WorkerTiming = {
	tickMs: 50,
	leaseMs: 60_000,
	adapterDeadlineMs: 5_000,
	batchSize: 20,
	sendConcurrency: 10,
	retentionMs: 30 * 24 * 3_600_000,
	pruneCadenceTicks: 60,
	pruneBatchSize: 1_000,
	maxQueuedPerUser: 500,
};

type Sent = { config: unknown; payload: ChannelPayload };

// Records what reached the adapter so the ack-capability and rendering
// assertions can look at the real hand-off rather than at the HTTP double.
function stubAdapter(
	kind: ChannelAdapter["kind"],
	behavior: (payload: ChannelPayload) => Promise<ProviderResult>,
): { adapter: ChannelAdapter; sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		sent,
		adapter: {
			kind,
			async send(config, payload) {
				sent.push({ config, payload });
				return await behavior(payload);
			},
		},
	};
}

async function wipeVolatile() {
	await db
		.delete(tables.notificationOutbox)
		.where(inArray(tables.notificationOutbox.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
}

async function wipe() {
	await wipeVolatile();
	await db.delete(tables.task).where(eq(tables.task.id, TASK));
	await db.delete(tables.list).where(eq(tables.list.id, LIST));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

async function seedChannel(
	userId: string,
	kind: "ntfy" | "telegram",
	config: unknown = { serverUrl: "https://ntfy.example.test", topic: "t" },
	enabled = true,
) {
	await db.insert(tables.notificationChannel).values({
		id: `dp-ch-${userId}-${kind}`,
		userId,
		kind,
		config,
		enabled,
	});
}

async function seedReminder(id: string, recipientUserId: string) {
	await db.insert(tables.reminderState).values({
		id,
		taskId: TASK,
		occurrenceAt: OCCURRENCE,
		recipientUserId,
		status: "pending",
		fireCount: 1,
	});
	return id;
}

async function seedOutbox(
	id: string,
	fields: Partial<typeof tables.notificationOutbox.$inferInsert> = {},
) {
	await db.insert(tables.notificationOutbox).values({
		id,
		recipientUserId: OWNER,
		channelKind: "ntfy",
		payload: {
			kind: "reminder",
			taskId: TASK,
			taskTitle: "Walk the dog",
			listId: LIST,
			occurrenceAt: OCCURRENCE.toISOString(),
			fireCount: 1,
			urgent: false,
		},
		idempotencyKey: id,
		status: "queued",
		nextAttemptAt: new Date(Date.now() - 1_000),
		...fields,
	});
	return id;
}

async function attemptsFor(id: string) {
	return await db
		.select()
		.from(tables.deliveryAttempt)
		.where(eq(tables.deliveryAttempt.outboxId, id));
}

async function outbox(id: string) {
	const rows = await db
		.select()
		.from(tables.notificationOutbox)
		.where(eq(tables.notificationOutbox.id, id));
	return rows[0];
}

const deps = {
	database: db,
	allowedPrivateCIDRs: [],
	deadlineMs: 1_000,
	ackBaseUrl: ACK_BASE,
};

beforeAll(async () => {
	await wipe();
	await db
		.insert(tables.user)
		.values(
			userIds.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
		);
	await db.insert(tables.workspace).values({
		id: WS,
		name: "Dispatch WS",
		ownerId: OWNER,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		userIds.map((userId, index) => ({
			id: `dp-m-${userId}`,
			userId,
			workspaceId: WS,
			role: index === 0 ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: OWNER,
		title: "Dispatch list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: TASK,
		listId: LIST,
		title: "Walk the dog",
		sortKey: "a0",
	});
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("dispatch", () => {
	it("mints an ack capability and passes its URL to the adapter", async () => {
		await seedChannel(OWNER, "ntfy");
		const reminderId = await seedReminder("dp-r1", OWNER);
		const id = await seedOutbox("dp-o1", { reminderStateId: reminderId });
		const { adapter, sent } = stubAdapter("ntfy", async () => ({
			ok: true,
			status: 200,
		}));

		await workerTick(db, {
			send: createSendFn({ ...deps, adapters: { ntfy: adapter } }),
			timing,
			replicaId: REPLICA,
		});

		expect(sent).toHaveLength(1);
		const ackUrl = sent[0].payload.ackUrl;
		expect(ackUrl).toMatch(
			new RegExp(`^${ACK_BASE}${ACK_PATH}/[A-Za-z0-9_-]{43,}$`),
		);
		const token = (ackUrl as string).split("/").pop() as string;

		const capabilities = await db
			.select()
			.from(tables.ackCapability)
			.where(eq(tables.ackCapability.reminderStateId, reminderId));
		expect(capabilities).toHaveLength(1);
		// C21: only the hash is stored, never the raw token, and the outbox
		// payload it was minted for must not have acquired it either.
		expect(capabilities[0].tokenHash).toBe(hashAckToken(token));
		expect(capabilities[0].tokenHash).not.toBe(token);
		expect(capabilities[0].recipientUserId).toBe(OWNER);
		expect(capabilities[0].action).toBe(ACK_ACTION);
		expect(capabilities[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(JSON.stringify((await outbox(id)).payload)).not.toContain(token);
	});

	// E1: ack_capability.reminder_state_id is notNull, so minting for an event
	// row would be a constraint violation on every assignment notification.
	it("skips capability minting for a row with no reminder", async () => {
		await seedChannel(OWNER, "ntfy");
		await seedOutbox("dp-o2", { reminderStateId: null });
		const { adapter, sent } = stubAdapter("ntfy", async () => ({
			ok: true,
			status: 200,
		}));

		const summary = await workerTick(db, {
			send: createSendFn({ ...deps, adapters: { ntfy: adapter } }),
			timing,
			replicaId: REPLICA,
		});

		expect(summary.sent).toBe(1);
		expect(sent[0].payload.ackUrl).toBeNull();
		expect(await db.select().from(tables.ackCapability)).toHaveLength(0);
	});

	it("mints a fresh capability per attempt", async () => {
		await seedChannel(OWNER, "ntfy");
		const reminderId = await seedReminder("dp-r3", OWNER);
		await seedOutbox("dp-o3", { reminderStateId: reminderId });
		const { adapter, sent } = stubAdapter("ntfy", async () => ({
			ok: false,
			status: 503,
			error: "unavailable",
		}));
		const send = createSendFn({ ...deps, adapters: { ntfy: adapter } });

		await workerTick(db, { send, timing, replicaId: REPLICA });
		await db
			.update(tables.notificationOutbox)
			.set({ nextAttemptAt: new Date(Date.now() - 1_000) })
			.where(eq(tables.notificationOutbox.id, "dp-o3"));
		await workerTick(db, { send, timing, replicaId: REPLICA });

		expect(sent).toHaveLength(2);
		expect(sent[0].payload.ackUrl).not.toBe(sent[1].payload.ackUrl);
		expect(
			await db
				.select()
				.from(tables.ackCapability)
				.where(eq(tables.ackCapability.reminderStateId, reminderId)),
		).toHaveLength(2);
	});

	// One dead channel must not take its batch with it: the throwing adapter
	// stands in for an adapter that breaks the never-throw contract.
	it("attempts every channel in a batch even when one fails", async () => {
		await seedChannel(OWNER, "ntfy");
		await seedChannel(OWNER, "telegram", {});
		await seedChannel(OTHER, "ntfy");
		const good = await seedOutbox("dp-o4a");
		const broken = await seedOutbox("dp-o4b", { channelKind: "telegram" });
		const other = await seedOutbox("dp-o4c", { recipientUserId: OTHER });

		const ntfy = stubAdapter("ntfy", async () => ({ ok: true, status: 200 }));
		const telegram = stubAdapter("telegram", async () => {
			throw new Error("adapter exploded");
		});

		const summary = await workerTick(db, {
			send: createSendFn({
				...deps,
				adapters: { ntfy: ntfy.adapter, telegram: telegram.adapter },
			}),
			timing,
			replicaId: REPLICA,
		});

		expect(summary.claimed).toBe(3);
		expect(ntfy.sent).toHaveLength(2);
		expect(telegram.sent).toHaveLength(1);
		expect((await outbox(good)).status).toBe("sent");
		expect((await outbox(other)).status).toBe("sent");
		expect((await outbox(broken)).status).toBe("queued");

		// Every adapter result is recorded, including the failing one.
		for (const id of [good, broken, other]) {
			expect(await attemptsFor(id), id).toHaveLength(1);
		}
		expect((await attemptsFor(broken))[0].retryClass).toBe("transport");
	});

	// C17 end to end, through the real adapter: a policy rejection must land the
	// row in `failed`, not on the retry ladder, or an SSRF probe is re-issued
	// once per attempt for the whole ~33-minute ladder, per notification.
	it("records a policy rejection as a permanent failure", async () => {
		await seedChannel(OWNER, "ntfy");
		const id = await seedOutbox("dp-o5");

		await workerTick(db, {
			send: createSendFn({
				...deps,
				adapters: { ntfy: ntfyAdapter },
				fetch: (async () => {
					throw new OutboundPolicyError(
						"Outbound target must resolve to a public address",
					);
				}) as typeof safeFetch,
			}),
			timing,
			replicaId: REPLICA,
		});

		expect((await outbox(id)).status).toBe("failed");
		expect((await attemptsFor(id))[0].retryClass).toBe("policy");
	});

	it("retries a transport failure raised by the real adapter", async () => {
		await seedChannel(OWNER, "ntfy");
		const id = await seedOutbox("dp-o5b");

		await workerTick(db, {
			send: createSendFn({
				...deps,
				adapters: { ntfy: ntfyAdapter },
				fetch: (async () => {
					throw new Error("ECONNRESET");
				}) as typeof safeFetch,
			}),
			timing,
			replicaId: REPLICA,
		});

		expect((await outbox(id)).status).toBe("queued");
		expect((await attemptsFor(id))[0].retryClass).toBe("transport");
	});

	it("fails permanently when the channel is missing or disabled", async () => {
		await seedChannel(OWNER, "ntfy", undefined, false);
		const disabled = await seedOutbox("dp-o6a");
		const missing = await seedOutbox("dp-o6b", { recipientUserId: OTHER });
		const { adapter, sent } = stubAdapter("ntfy", async () => ({
			ok: true,
			status: 200,
		}));

		await workerTick(db, {
			send: createSendFn({ ...deps, adapters: { ntfy: adapter } }),
			timing,
			replicaId: REPLICA,
		});

		expect(sent).toHaveLength(0);
		expect((await outbox(disabled)).status).toBe("failed");
		expect((await outbox(missing)).status).toBe("failed");
		expect((await attemptsFor(disabled))[0].retryClass).toBe("policy");
	});

	// A malformed origin would otherwise mint unfollowable ack links for every
	// reminder, silently, for as long as it stayed misconfigured.
	it.each([
		"not-a-url",
		"",
		"/relative/path",
	])("refuses to construct with ackBaseUrl %o", (ackBaseUrl) => {
		expect(() => createSendFn({ ...deps, ackBaseUrl })).toThrow(
			/ackBaseUrl must be an absolute URL/,
		);
	});

	it("constructs with a null ackBaseUrl", () => {
		expect(() => createSendFn({ ...deps, ackBaseUrl: null })).not.toThrow();
	});

	it("hands the stored channel config to the adapter", async () => {
		const stored = {
			serverUrl: "https://ntfy.example.test",
			topic: "family",
			token: "tk_secret",
		};
		await seedChannel(OWNER, "ntfy", stored);
		await seedOutbox("dp-o7");
		const { adapter, sent } = stubAdapter("ntfy", async () => ({
			ok: true,
			status: 200,
		}));

		await workerTick(db, {
			send: createSendFn({ ...deps, adapters: { ntfy: adapter } }),
			timing,
			replicaId: REPLICA,
		});

		expect(sent[0].config).toEqual(stored);
		expect(sent[0].payload.title).toBe("Walk the dog");
	});
});
