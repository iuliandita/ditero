// The Telegram listener against a real Postgres: it is an unauthenticated
// public endpoint that completes someone's task, so the properties under test
// are the rejection classes as much as the happy path -- a forged secret must
// change nothing, a replay must be inert, and a callback from a chat that is
// not the capability's recipient must be refused even though the secret is
// valid.
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
import { app } from "../../src/server/index.ts";
import {
	ACK_ACTION,
	ACK_TTL_MS,
	ackToken,
	hashAckToken,
} from "../../src/server/notifications/capability.ts";
import { RAW_REJECT_BODY } from "../../src/server/notifications/raw-body.ts";
import {
	TELEGRAM_SECRET_HEADER,
	TELEGRAM_WEBHOOK_PATH,
	telegramWebhookRoutes,
} from "../../src/server/notifications/telegram-webhook.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const USER = "tg-user";
const OTHER = "tg-other";
// A group chat one whole family is bound to is the supported topology, so the
// fixture uses more members than any plausible candidate cap.
const GROUP_USERS = Array.from({ length: 9 }, (_, index) => `tg-g${index + 1}`);
const LAST_GROUP_USER = GROUP_USERS[GROUP_USERS.length - 1];
const NAMED_USER = "tg-named";
const userIds = [USER, OTHER, NAMED_USER, ...GROUP_USERS] as const;
const WS = "tg-ws";
const LIST = "tg-list";
const TASK = "tg-task";
const CHAT_ID = -1001234;
const BOT_TOKEN = "8100000:AA_a_real_looking_bot_token";
const SECRET = "webhook-secret-value";
const NAMED_CHAT = "@Family";
const NAMED_CHAT_ID = -1009999;
const UNCONFIGURED_CHAT_ID = -1007777;
const groupBotToken = (userId: string) => `8100000:AA_bot_for_${userId}`;
const OCCURRENCE = new Date("2026-08-01T20:00:00Z");

type Call = { url: string; body: unknown };

function fakeFetch(): { calls: Call[]; fn: typeof safeFetch } {
	const calls: Call[] = [];
	return {
		calls,
		fn: async (input, options = {}) => {
			calls.push({
				url: String(input),
				body: JSON.parse(String(options.body ?? "null")),
			});
			return new Response('{"ok":true}', { status: 200 });
		},
	};
}

function method(call: Call): string {
	return call.url.slice(call.url.lastIndexOf("/") + 1);
}

function listener(
	calls: ReturnType<typeof fakeFetch>,
	overrides: { capacity?: number; refillPerSec?: number } = {},
	database: typeof db = db,
) {
	return new Elysia().use(
		telegramWebhookRoutes(database, {
			env: { ...process.env, DITERO_TELEGRAM_WEBHOOK_SECRET: SECRET },
			fetch: calls.fn,
			...overrides,
		}),
	);
}

function callbackUpdate(
	data: string,
	over: {
		chatId?: number | string;
		id?: string;
		username?: string;
		// Telegram delivers a callback on a message older than 48h as an
		// InaccessibleMessage: chat and message_id, no text.
		inaccessible?: boolean;
	} = {},
) {
	return {
		update_id: 7,
		callback_query: {
			id: over.id ?? "cb-1",
			from: { id: 4242, is_bot: false, first_name: "Ann" },
			message: {
				message_id: 55,
				...(over.inaccessible ? {} : { text: "Take meds" }),
				chat: {
					id: over.chatId ?? CHAT_ID,
					type: "group",
					...(over.username === undefined ? {} : { username: over.username }),
				},
			},
			data,
		},
	};
}

function post(
	instance: ReturnType<typeof listener>,
	body: unknown,
	headers: Record<string, string> = { [TELEGRAM_SECRET_HEADER]: SECRET },
) {
	return instance.handle(
		new Request(`http://localhost:3000${TELEGRAM_WEBHOOK_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);
}

async function seedReminder(id: string, recipientUserId: string) {
	await db.insert(tables.reminderState).values({
		id,
		taskId: TASK,
		occurrenceAt: OCCURRENCE,
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
		id: `tg-cap-${crypto.randomUUID()}`,
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

async function taskRow() {
	const rows = await db
		.select()
		.from(tables.task)
		.where(eq(tables.task.id, TASK));
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
		.set({ done: false, completedAt: null, dueAt: OCCURRENCE })
		.where(eq(tables.task.id, TASK));
}

async function wipe() {
	await wipeVolatile();
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.userId, [...userIds]));
	await db.delete(tables.task).where(eq(tables.task.id, TASK));
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
		name: "TG WS",
		ownerId: USER,
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{ id: "tg-m-user", userId: USER, workspaceId: WS, role: "owner" },
		{ id: "tg-m-other", userId: OTHER, workspaceId: WS, role: "member" },
		...[NAMED_USER, ...GROUP_USERS].map((id) => ({
			id: `tg-m-${id}`,
			userId: id,
			workspaceId: WS,
			role: "member" as const,
		})),
	]);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: USER,
		title: "TG list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: TASK,
		listId: LIST,
		title: "Take meds",
		sortKey: "a0",
	});
	// Only USER's chat is configured; OTHER has no telegram channel, which is
	// what makes the sender-binding test meaningful.
	await db.insert(tables.notificationChannel).values([
		{
			id: "tg-ch-user",
			userId: USER,
			kind: "telegram",
			config: encryptChannelConfig(
				"telegram",
				{ botToken: BOT_TOKEN, chatId: String(CHAT_ID) },
				channelKeyRing(process.env),
			),
		},
		// The rest of the family, same chat, each with its own bot token.
		...GROUP_USERS.map((id) => ({
			id: `tg-ch-${id}`,
			userId: id,
			kind: "telegram" as const,
			config: encryptChannelConfig(
				"telegram",
				{ botToken: groupBotToken(id), chatId: String(CHAT_ID) },
				channelKeyRing(process.env),
			),
		})),
		// Stored by @username, in the case the operator typed it in.
		{
			id: "tg-ch-named",
			userId: NAMED_USER,
			kind: "telegram",
			config: encryptChannelConfig(
				"telegram",
				{ botToken: groupBotToken(NAMED_USER), chatId: NAMED_CHAT },
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

describe("telegram webhook: ack", () => {
	test("acks the reminder, terminates siblings and answers the callback", async () => {
		const mine = await seedReminder("tg-r1", USER);
		const sibling = await seedReminder("tg-r1b", OTHER);
		const token = await mintCapability(mine, USER);
		const calls = fakeFetch();

		const response = await post(listener(calls), callbackUpdate(`c:${token}`));
		expect(response.status).toBe(200);

		const acked = await reminderRow(mine);
		expect(acked.status).toBe("acked");
		expect(acked.ackedVia).toBe("telegram");
		expect(acked.nextAttemptAt).toBeNull();
		expect((await taskRow()).done).toBe(true);
		// C7: a co-assignee's phone must stop escalating what someone already acked.
		expect((await reminderRow(sibling)).status).toBe("acked");

		// The button is answered (otherwise Telegram leaves a spinner on it) and
		// the message is edited so a second tap is visibly pointless.
		expect(calls.calls.map(method)).toEqual([
			"answerCallbackQuery",
			"editMessageText",
		]);
		expect(calls.calls[0].body).toMatchObject({
			callback_query_id: "cb-1",
			text: "Done.",
		});
		expect(calls.calls[1].body).toMatchObject({
			chat_id: CHAT_ID,
			message_id: 55,
		});
		// The edit carries no reply_markup, which is what drops the keyboard.
		expect(calls.calls[1].body).not.toHaveProperty("reply_markup");
		// Every outbound call goes to the bot API through the injected safeFetch.
		for (const call of calls.calls) {
			expect(call.url.startsWith("https://api.telegram.org/bot")).toBe(true);
		}
	});

	test("a member past any candidate cap can still ack, with their own bot", async () => {
		// notification_channel is unique on (userId, kind), so a shared group chat
		// is N rows -- an arbitrary cap would evict a real recipient and burn their
		// capability for nothing.
		const reminderId = await seedReminder("tg-r6", LAST_GROUP_USER);
		const token = await mintCapability(reminderId, LAST_GROUP_USER);
		const calls = fakeFetch();

		const response = await post(listener(calls), callbackUpdate(`c:${token}`));
		expect(response.status).toBe(200);

		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect((await taskRow()).done).toBe(true);
		expect(calls.calls[0].body).toMatchObject({ text: "Done." });
		// botToken is per-user config: answering with another member's bot would
		// fail silently and leave the button spinning over a recorded ack.
		for (const call of calls.calls) {
			expect(call.url).toContain(groupBotToken(LAST_GROUP_USER));
		}
	});

	test("a chat bound by @username acks case-insensitively", async () => {
		const reminderId = await seedReminder("tg-r7", NAMED_USER);
		const token = await mintCapability(reminderId, NAMED_USER);
		const calls = fakeFetch();

		// Stored as "@Family"; Telegram delivers the username unprefixed and in
		// whatever case the chat carries.
		const response = await post(
			listener(calls),
			callbackUpdate(`c:${token}`, {
				chatId: NAMED_CHAT_ID,
				username: "family",
			}),
		);
		expect(response.status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls.calls[0].body).toMatchObject({ text: "Done." });
	});

	test("a different @username is not the same chat", async () => {
		const reminderId = await seedReminder("tg-r8", NAMED_USER);
		const token = await mintCapability(reminderId, NAMED_USER);
		const calls = fakeFetch();

		const response = await post(
			listener(calls),
			callbackUpdate(`c:${token}`, {
				chatId: NAMED_CHAT_ID,
				username: "notfamily",
			}),
		);
		expect(response.status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect(calls.calls).toHaveLength(0);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("edits the reply markup when the message is inaccessible", async () => {
		// A callback on a message older than 48h carries chat and message_id but
		// no text, so there is nothing to append the done marker to; the keyboard
		// still has to come off.
		const reminderId = await seedReminder("tg-r9", USER);
		const token = await mintCapability(reminderId, USER);
		const calls = fakeFetch();

		const response = await post(
			listener(calls),
			callbackUpdate(`c:${token}`, { inaccessible: true }),
		);
		expect(response.status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls.calls.map(method)).toEqual([
			"answerCallbackQuery",
			"editMessageReplyMarkup",
		]);
		expect(calls.calls[1].body).toMatchObject({
			chat_id: CHAT_ID,
			message_id: 55,
			reply_markup: { inline_keyboard: [] },
		});
	});

	test("a replayed callback is inert", async () => {
		const reminderId = await seedReminder("tg-r2", USER);
		const token = await mintCapability(reminderId, USER);
		const calls = fakeFetch();
		const instance = listener(calls);

		expect((await post(instance, callbackUpdate(`c:${token}`))).status).toBe(
			200,
		);
		await db
			.update(tables.task)
			.set({ done: false, completedAt: null })
			.where(eq(tables.task.id, TASK));
		const firstCalls = calls.calls.length;

		expect((await post(instance, callbackUpdate(`c:${token}`))).status).toBe(
			200,
		);
		// The second tap redeems nothing: no completion, no message edit, and the
		// answer says so.
		expect((await taskRow()).done).toBe(false);
		expect(calls.calls.slice(firstCalls).map(method)).toEqual([
			"answerCallbackQuery",
		]);
		expect(calls.calls[firstCalls].body).toMatchObject({
			text: "This reminder is no longer active.",
		});
	});
});

describe("telegram webhook: rejection", () => {
	test("a wrong or missing secret token changes nothing", async () => {
		const headerSets: Record<string, string>[] = [
			{ [TELEGRAM_SECRET_HEADER]: "not-the-secret" },
			{},
		];
		const reminderId = await seedReminder("tg-r3", USER);
		const token = await mintCapability(reminderId, USER);
		for (const headers of headerSets) {
			const calls = fakeFetch();

			const response = await post(
				listener(calls),
				callbackUpdate(`c:${token}`),
				headers,
			);
			expect(response.status).toBe(400);
			expect(await response.text()).toBe(RAW_REJECT_BODY);

			expect((await reminderRow(reminderId)).status).toBe("pending");
			expect((await taskRow()).done).toBe(false);
			// Not even consumed: the body was never parsed.
			expect((await capabilityRow(token)).consumedAt).toBeNull();
			expect(calls.calls).toHaveLength(0);
		}
	});

	test("a callback from a chat the capability is not bound to is refused", async () => {
		const reminderId = await seedReminder("tg-r4", OTHER);
		// Bound to OTHER, who has no telegram channel; the callback arrives from
		// USER's chat.
		const token = await mintCapability(reminderId, OTHER);
		const calls = fakeFetch();

		const response = await post(listener(calls), callbackUpdate(`c:${token}`));
		expect(response.status).toBe(200);

		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		// The burn is kept, exactly like every other post-consume binding failure.
		expect((await capabilityRow(token)).consumedAt).not.toBeNull();
		expect(calls.calls.map(method)).toEqual(["answerCallbackQuery"]);
		expect(calls.calls[0].body).toMatchObject({
			text: "This reminder is no longer active.",
		});
	});

	test("a callback from a chat with no configured channel is dropped", async () => {
		const reminderId = await seedReminder("tg-r10", USER);
		const token = await mintCapability(reminderId, USER);
		const calls = fakeFetch();

		const response = await post(
			listener(calls),
			callbackUpdate(`c:${token}`, { chatId: UNCONFIGURED_CHAT_ID }),
		);
		expect(response.status).toBe(200);

		// Nothing to answer with and no recipient to act for: a stranger who DMs
		// the bot must not burn a capability, and there is no bot token to reply
		// through either.
		expect(calls.calls).toHaveLength(0);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a redeem that throws answers 500 and keeps the capability alive", async () => {
		const reminderId = await seedReminder("tg-r11", USER);
		const token = await mintCapability(reminderId, USER);
		const calls = fakeFetch();
		// redeemAckCapability consumes inside the transaction it rethrows out of,
		// so a throw rolls the burn back -- which is exactly why redelivery is safe
		// here and not on a decided rejection.
		const broken = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "transaction") {
					return async () => {
						throw new Error("connection terminated unexpectedly");
					};
				}
				return Reflect.get(target, property, receiver);
			},
		}) as typeof db;

		const response = await post(
			listener(calls, {}, broken),
			callbackUpdate(`c:${token}`),
		);
		// Telegram redelivers on a non-2xx; a 200 would drop the user's tap.
		expect(response.status).toBe(500);

		expect((await capabilityRow(token)).consumedAt).toBeNull();
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		// The reminder IS still active, so the "no longer active" answer would be
		// a lie about a button that still works.
		expect(calls.calls.map(method)).toEqual(["answerCallbackQuery"]);
		expect(calls.calls[0].body).toMatchObject({
			text: "Couldn't reach the server. Try again.",
		});
	});

	test("the rate limit engages", async () => {
		const reminderId = await seedReminder("tg-r5", USER);
		const token = await mintCapability(reminderId, USER);
		const calls = fakeFetch();
		// Fractional refill on purpose: a zero rate hides the bugs this limiter
		// has already shipped twice.
		const instance = listener(calls, { capacity: 1, refillPerSec: 0.5 });

		expect((await post(instance, callbackUpdate(`c:${token}`))).status).toBe(
			200,
		);
		const limited = await post(instance, callbackUpdate(`c:${token}`));
		expect(limited.status).toBe(429);
		expect((await taskRow()).done).toBe(true);
	});

	test("a malformed update is handled without a 500", async () => {
		const calls = fakeFetch();
		const instance = listener(calls);
		const bodies: unknown[] = [
			{},
			{ update_id: 1, message: { text: "hello" } },
			{ update_id: 1, callback_query: { id: "x", from: { id: 1 } } },
			{ update_id: 1, callback_query: { id: "x", data: 42 } },
			{ update_id: 1, callback_query: { id: "x", data: "other:thing" } },
			{ update_id: 1, callback_query: { id: "x", data: "c:" } },
			// `c:`-prefixed but with no chat to bind against.
			{ update_id: 1, callback_query: { id: "x", data: "c:sometoken" } },
			[],
			"not-an-object",
		];

		for (const body of bodies) {
			const response = await post(instance, body);
			expect(response.status, JSON.stringify(body)).toBe(200);
		}
		expect(calls.calls).toHaveLength(0);
		expect((await taskRow()).done).toBe(false);
	});
});

describe("telegram webhook: mounting", () => {
	// The URL an operator hands to setWebhook must be one the app answers, or
	// every ack silently 404s.
	test("the app serves the listener path", async () => {
		const response = await app.handle(
			new Request(`http://localhost:3000${TELEGRAM_WEBHOOK_PATH}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[TELEGRAM_SECRET_HEADER]: "not-the-secret",
				},
				body: JSON.stringify(callbackUpdate("c:nope")),
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
	});
});
