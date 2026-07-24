// The Telegram poll transport against a real Postgres.
//
// The fixture deliberately keeps four dimensions apart -- two users, two bot
// tokens, two chats, two tasks -- because collapsing any of them makes several
// of the properties here unreachable at once: "polls every configured bot",
// "offset is per bot", "answers with the bot that actually matched", and the
// anti-drift comparison between transports all live on those axes.
//
// The provider double models the one semantic that matters for restart safety:
// an update is confirmed, and only then dropped, when getUpdates is called with
// a higher offset. Nothing here stores a cursor, which is exactly the point.
import { eq, inArray, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	channelKeyRing,
	encryptChannelConfig,
} from "../../src/security/channel-config.ts";
import type { safeFetch } from "../../src/security/safe-http.ts";
import {
	ACK_ACTION,
	ACK_TTL_MS,
	ackToken,
	hashAckToken,
} from "../../src/server/notifications/capability.ts";
import {
	startTelegramPoller,
	TELEGRAM_POLL_LOCK_KEY,
	type TelegramPollOptions,
} from "../../src/server/notifications/telegram-poll.ts";
import {
	TELEGRAM_SECRET_HEADER,
	TELEGRAM_WEBHOOK_PATH,
	telegramWebhookRoutes,
} from "../../src/server/notifications/telegram-webhook.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 8 });
const db = drizzle(pool, { schema: tables });

const USER_A = "tgp-a";
const USER_B = "tgp-b";
const SIB_A = "tgp-sib-a";
const SIB_B = "tgp-sib-b";
const userIds = [USER_A, USER_B, SIB_A, SIB_B] as const;
const WS = "tgp-ws";
const LIST = "tgp-list";
const TASK_A = "tgp-task-a";
const TASK_B = "tgp-task-b";
const CHAT_A = "-1001111";
const CHAT_B = "-1002222";
const BOT_A = "1111111:AA_bot_alpha";
const BOT_B = "2222222:AA_bot_beta";
const SECRET = "poll-webhook-secret-value";
const OCCURRENCE_A = new Date("2026-08-02T20:00:00Z");
const OCCURRENCE_B = new Date("2026-08-03T20:00:00Z");

const pollerEnv = {
	...process.env,
	DITERO_TELEGRAM_WEBHOOK_SECRET: SECRET,
};

type Call = { token: string; method: string; body: Record<string, unknown> };

type Provider = {
	calls: Call[];
	fn: typeof safeFetch;
	queue(botToken: string, update: unknown): void;
	pending(botToken: string): unknown[];
	callsFor(botToken: string, method: string): Call[];
	failGetUpdates: boolean;
};

// Telegram's own confirmation model: `pending` holds what has not been
// confirmed away, and only an offset higher than an update's id removes it.
function fakeProvider(): Provider {
	const calls: Call[] = [];
	const queues = new Map<string, unknown[]>();
	const provider: Provider = {
		calls,
		failGetUpdates: false,
		queue(botToken, update) {
			queues.set(botToken, [...(queues.get(botToken) ?? []), update]);
		},
		pending(botToken) {
			return queues.get(botToken) ?? [];
		},
		callsFor(botToken, method) {
			return calls.filter(
				(call) => call.token === botToken && call.method === method,
			);
		},
		fn: async (input, options = {}) => {
			const url = new URL(String(input));
			const [, rawToken, method] = url.pathname.split("/");
			const token = decodeURIComponent(rawToken.slice("bot".length));
			const body = JSON.parse(String(options.body ?? "{}")) as Record<
				string,
				unknown
			>;
			calls.push({ token, method, body });

			if (method === "getUpdates") {
				if (provider.failGetUpdates) {
					return new Response('{"ok":false,"error_code":409}', { status: 200 });
				}
				const offset = body.offset;
				let queue = queues.get(token) ?? [];
				if (typeof offset === "number") {
					queue = queue.filter(
						(update) => (update as { update_id: number }).update_id >= offset,
					);
					queues.set(token, queue);
				}
				// An empty long poll blocks at the provider rather than returning
				// instantly; without this the loop's pacing would come from nowhere.
				if (queue.length === 0) await new Promise((r) => setTimeout(r, 30));
				return new Response(JSON.stringify({ ok: true, result: queue }), {
					status: 200,
				});
			}
			return new Response('{"ok":true,"result":true}', { status: 200 });
		},
	};
	return provider;
}

function callbackUpdate(
	updateId: number,
	token: string,
	chatId: string,
	messageId: number,
) {
	return {
		update_id: updateId,
		callback_query: {
			id: `cb-${updateId}`,
			from: { id: 4242, is_bot: false, first_name: "Ann" },
			message: {
				message_id: messageId,
				text: "Take meds",
				chat: { id: Number(chatId), type: "group" },
			},
			data: `c:${token}`,
		},
	};
}

function poller(
	provider: Provider,
	overrides: TelegramPollOptions = {},
	database: typeof db = db,
) {
	return startTelegramPoller(database, pool, {
		env: pollerEnv,
		fetch: provider.fn,
		longPollSec: 1,
		idleMs: 30,
		backoffBaseMs: 300,
		backoffMaxMs: 1_000,
		...overrides,
	});
}

async function postWebhook(provider: Provider, update: unknown) {
	const instance = new Elysia().use(
		telegramWebhookRoutes(db, { env: pollerEnv, fetch: provider.fn }),
	);
	return await instance.handle(
		new Request(`http://localhost:3000${TELEGRAM_WEBHOOK_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[TELEGRAM_SECRET_HEADER]: SECRET,
			},
			body: JSON.stringify(update),
		}),
	);
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("waitFor timed out");
}

async function lockIsFree(): Promise<boolean> {
	const client = await pool.connect();
	try {
		const { rows } = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS acquired",
			[TELEGRAM_POLL_LOCK_KEY],
		);
		if (rows[0].acquired) {
			await client.query("SELECT pg_advisory_unlock($1)", [
				TELEGRAM_POLL_LOCK_KEY,
			]);
			return true;
		}
		return false;
	} finally {
		client.release();
	}
}

async function seedReminder(
	id: string,
	taskId: string,
	occurrenceAt: Date,
	recipientUserId: string,
) {
	await db.insert(tables.reminderState).values({
		id,
		taskId,
		occurrenceAt,
		recipientUserId,
		status: "pending",
		fireCount: 1,
		nextAttemptAt: new Date(Date.now() + 60_000),
	});
	return id;
}

async function mintCapability(
	reminderStateId: string,
	recipientUserId: string,
) {
	const token = ackToken();
	await db.insert(tables.ackCapability).values({
		id: `tgp-cap-${crypto.randomUUID()}`,
		tokenHash: hashAckToken(token),
		reminderStateId,
		recipientUserId,
		action: ACK_ACTION,
		expiresAt: new Date(Date.now() + ACK_TTL_MS),
	});
	return token;
}

async function reminderRow(id: string) {
	const rows = await db
		.select()
		.from(tables.reminderState)
		.where(eq(tables.reminderState.id, id));
	return rows[0];
}

async function taskRow(id: string) {
	const rows = await db
		.select()
		.from(tables.task)
		.where(eq(tables.task.id, id));
	return rows[0];
}

async function capabilityRow(token: string) {
	const rows = await db
		.select()
		.from(tables.ackCapability)
		.where(eq(tables.ackCapability.tokenHash, hashAckToken(token)));
	return rows[0];
}

async function wipeVolatile() {
	await db
		.delete(tables.ackCapability)
		.where(inArray(tables.ackCapability.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await db
		.delete(tables.karmaEvent)
		.where(inArray(tables.karmaEvent.userId, [...userIds]));
	await db
		.delete(tables.karma)
		.where(inArray(tables.karma.userId, [...userIds]));
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, "telegram:%"));
	await db
		.update(tables.task)
		.set({ done: false, completedAt: null })
		.where(inArray(tables.task.id, [TASK_A, TASK_B]));
}

async function wipe() {
	await wipeVolatile();
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, [TASK_A, TASK_B]));
	await db.delete(tables.list).where(eq(tables.list.id, LIST));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

beforeAll(async () => {
	await wipe();
	await db
		.insert(tables.user)
		.values(
			userIds.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
		);
	await db.insert(tables.workspace).values({
		id: WS,
		name: "TGP WS",
		ownerId: USER_A,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		userIds.map((id) => ({
			id: `tgp-m-${id}`,
			userId: id,
			workspaceId: WS,
			role: id === USER_A ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: USER_A,
		title: "TGP list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values([
		{ id: TASK_A, listId: LIST, title: "Take meds", sortKey: "a0" },
		{ id: TASK_B, listId: LIST, title: "Walk dog", sortKey: "a1" },
	]);
	// Two users, two bots, two chats: the axis every per-bot property lives on.
	await db.insert(tables.notificationChannel).values([
		{
			id: "tgp-ch-a",
			userId: USER_A,
			kind: "telegram",
			config: encryptChannelConfig(
				"telegram",
				{ botToken: BOT_A, chatId: CHAT_A },
				channelKeyRing(process.env),
			),
		},
		{
			id: "tgp-ch-b",
			userId: USER_B,
			kind: "telegram",
			config: encryptChannelConfig(
				"telegram",
				{ botToken: BOT_B, chatId: CHAT_B },
				channelKeyRing(process.env),
			),
		},
	]);
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("telegram poll: leadership", () => {
	test("two replicas, exactly one polls", async () => {
		const first = fakeProvider();
		const second = fakeProvider();
		const a = poller(first);
		const b = poller(second);
		try {
			await waitFor(() => first.calls.length + second.calls.length > 0);
			await new Promise((r) => setTimeout(r, 400));

			const polling = [first, second].filter(
				(provider) => provider.calls.length > 0,
			);
			// Telegram hands an update to whoever asks first, so a second poller
			// consumes acks into a process that then confirms them away.
			expect(polling).toHaveLength(1);

			// And the follower takes over when the leader goes away, or a restart
			// would leave the deployment with no poller at all.
			const leader = polling[0] === first ? a : b;
			const follower = polling[0] === first ? second : first;
			await leader.stop();
			await waitFor(() => follower.calls.length > 0);
		} finally {
			await a.stop();
			await b.stop();
		}
	});

	test("a clean shutdown releases the lock", async () => {
		const provider = fakeProvider();
		const instance = poller(provider);
		await waitFor(() => provider.callsFor(BOT_A, "getUpdates").length > 0);
		expect(await lockIsFree()).toBe(false);

		await instance.stop();
		expect(await lockIsFree()).toBe(true);
		// Nor may a long poll still be in flight after stop() resolved.
		const after = provider.calls.length;
		await new Promise((r) => setTimeout(r, 300));
		expect(provider.calls.length).toBe(after);
	});
});

describe("telegram poll: offset", () => {
	test("the offset advances and a restart does not reconsume", async () => {
		const reminderId = await seedReminder(
			"tgp-r1",
			TASK_A,
			OCCURRENCE_A,
			USER_A,
		);
		const token = await mintCapability(reminderId, USER_A);
		const provider = fakeProvider();
		provider.queue(BOT_A, callbackUpdate(900, token, CHAT_A, 55));

		const first = poller(provider);
		try {
			await waitFor(async () => (await taskRow(TASK_A)).done);
			await waitFor(() =>
				provider
					.callsFor(BOT_A, "getUpdates")
					.some((call) => call.body.offset === 901),
			);
		} finally {
			await first.stop();
		}

		// The confirming call removed it at the provider; nothing local remembers.
		expect(provider.pending(BOT_A)).toEqual([]);
		expect(provider.callsFor(BOT_A, "answerCallbackQuery")).toHaveLength(1);
		const polledBefore = provider.callsFor(BOT_A, "getUpdates").length;

		const restarted = poller(provider);
		try {
			await waitFor(
				() => provider.callsFor(BOT_A, "getUpdates").length > polledBefore,
			);
		} finally {
			await restarted.stop();
		}

		// A restarted poller asks with no offset at all -- restart safety is the
		// provider's, not a cursor of ours -- and is handed nothing, because the
		// higher offset already confirmed the update away.
		const afterRestart = provider.callsFor(BOT_A, "getUpdates")[polledBefore];
		expect(afterRestart.body).not.toHaveProperty("offset");
		expect(provider.callsFor(BOT_A, "answerCallbackQuery")).toHaveLength(1);
		expect((await capabilityRow(token)).consumedAt).not.toBeNull();
	});
});

describe("telegram poll: transport parity", () => {
	// The anti-drift gate: both transports receive the identical callback_query
	// and must ack identically, so both are checked by ONE assertion function.
	async function expectAcked(input: {
		reminderId: string;
		siblingId: string;
		taskId: string;
		token: string;
		botToken: string;
		chatId: string;
		messageId: number;
		calls: Call[];
	}) {
		const acked = await reminderRow(input.reminderId);
		expect(acked.status).toBe("acked");
		expect(acked.ackedVia).toBe("telegram");
		expect(acked.nextAttemptAt).toBeNull();
		expect((await taskRow(input.taskId)).done).toBe(true);
		expect((await reminderRow(input.siblingId)).status).toBe("acked");
		expect((await capabilityRow(input.token)).consumedAt).not.toBeNull();

		// Transport calls (deleteWebhook/getUpdates) are not part of the ack; what
		// the user sees is.
		const bot = input.calls.filter(
			(call) =>
				call.token === input.botToken &&
				(call.method.startsWith("answer") || call.method.startsWith("edit")),
		);
		expect(bot.map((call) => call.method)).toEqual([
			"answerCallbackQuery",
			"editMessageText",
		]);
		expect(bot[0].body).toMatchObject({ text: "Done." });
		expect(bot[1].body).toMatchObject({
			chat_id: Number(input.chatId),
			message_id: input.messageId,
		});
		expect(bot[1].body).not.toHaveProperty("reply_markup");
	}

	test("a callback acks identically whether polled or delivered", async () => {
		const polled = await seedReminder("tgp-r2", TASK_A, OCCURRENCE_A, USER_A);
		const polledSibling = await seedReminder(
			"tgp-r2s",
			TASK_A,
			OCCURRENCE_A,
			SIB_A,
		);
		const polledToken = await mintCapability(polled, USER_A);
		const posted = await seedReminder("tgp-r3", TASK_B, OCCURRENCE_B, USER_B);
		const postedSibling = await seedReminder(
			"tgp-r3s",
			TASK_B,
			OCCURRENCE_B,
			SIB_B,
		);
		const postedToken = await mintCapability(posted, USER_B);

		const provider = fakeProvider();
		provider.queue(BOT_A, callbackUpdate(910, polledToken, CHAT_A, 77));
		const instance = poller(provider);
		try {
			await waitFor(async () => (await taskRow(TASK_A)).done);
		} finally {
			await instance.stop();
		}

		const webhookProvider = fakeProvider();
		const response = await postWebhook(
			webhookProvider,
			callbackUpdate(911, postedToken, CHAT_B, 77),
		);
		expect(response.status).toBe(200);

		await expectAcked({
			reminderId: polled,
			siblingId: polledSibling,
			taskId: TASK_A,
			token: polledToken,
			botToken: BOT_A,
			chatId: CHAT_A,
			messageId: 77,
			calls: provider.calls,
		});
		await expectAcked({
			reminderId: posted,
			siblingId: postedSibling,
			taskId: TASK_B,
			token: postedToken,
			botToken: BOT_B,
			chatId: CHAT_B,
			messageId: 77,
			calls: webhookProvider.calls,
		});
	});
});

describe("telegram poll: mode switch", () => {
	test("poll mode clears the webhook on every bot before polling it", async () => {
		const provider = fakeProvider();
		const instance = poller(provider);
		try {
			await waitFor(
				() =>
					provider.callsFor(BOT_A, "getUpdates").length > 0 &&
					provider.callsFor(BOT_B, "getUpdates").length > 0,
			);
		} finally {
			await instance.stop();
		}

		// getUpdates does not work while a webhook is set, and a half-switched
		// deployment receives nothing with no error anywhere.
		for (const bot of [BOT_A, BOT_B]) {
			const methods = provider.calls
				.filter((call) => call.token === bot)
				.map((call) => call.method);
			expect(methods[0]).toBe("deleteWebhook");
			expect(methods).not.toContain("setWebhook");
		}
	});

	test("webhook mode registers the listener and never polls", async () => {
		const provider = fakeProvider();
		const instance = poller(provider, { mode: "webhook" });
		try {
			await waitFor(
				() =>
					provider.callsFor(BOT_A, "setWebhook").length > 0 &&
					provider.callsFor(BOT_B, "setWebhook").length > 0,
			);
			await new Promise((r) => setTimeout(r, 200));
		} finally {
			await instance.stop();
		}

		for (const bot of [BOT_A, BOT_B]) {
			expect(provider.callsFor(bot, "setWebhook")[0].body).toEqual({
				url: `http://localhost:3000${TELEGRAM_WEBHOOK_PATH}`,
				secret_token: SECRET,
				allowed_updates: ["callback_query"],
			});
			expect(provider.callsFor(bot, "getUpdates")).toHaveLength(0);
			expect(provider.callsFor(bot, "deleteWebhook")).toHaveLength(0);
		}
	});
});

describe("telegram poll: failure", () => {
	test("a failing getUpdates backs off instead of hot-looping", async () => {
		const provider = fakeProvider();
		provider.failGetUpdates = true;
		// A bot in backoff is skipped rather than slept on, so the provider sees
		// nothing during the wait and cannot report a spin. What spins instead is
		// the leader's own cycle -- one channel query each -- so that is what has
		// to be counted.
		let cycles = 0;
		const counted = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "select") cycles++;
				return Reflect.get(target, property, receiver);
			},
		}) as typeof db;
		const instance = poller(provider, { backoffBaseMs: 300 }, counted);
		try {
			await waitFor(() => provider.callsFor(BOT_A, "getUpdates").length > 0);
			await new Promise((r) => setTimeout(r, 700));
		} finally {
			await instance.stop();
		}

		// 300ms then 600ms: a handful of attempts and a handful of cycles in the
		// window. Without the backoff both the loop and the provider would run as
		// fast as the refusals come back.
		const attempts = provider.callsFor(BOT_A, "getUpdates").length;
		expect(attempts).toBeGreaterThan(0);
		expect(attempts).toBeLessThanOrEqual(4);
		expect(cycles).toBeLessThanOrEqual(10);
	});
});
