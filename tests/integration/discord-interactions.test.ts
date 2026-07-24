// The Discord listener against a real Postgres. It is an unauthenticated public
// endpoint that completes someone's task, so the rejection classes matter as
// much as the happy path: a forged or stale signature must change nothing and
// answer 401 (Discord disables an endpoint that answers otherwise), a replay
// must be inert, and an interaction signed by one app must not act on another
// app's channel.
//
// The fixture deliberately carries TWO Discord apps, two channels and three
// users: one app and one channel would make cross-app confusion, channel
// binding and recipient binding all unreachable at once.
import { generateKeyPairSync, sign } from "node:crypto";
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
import { app } from "../../src/server/index.ts";
import { CONTENT_MAX } from "../../src/server/notifications/adapters/discord.ts";
import {
	ACK_ACTION,
	ACK_TTL_MS,
	ackToken,
	hashAckToken,
} from "../../src/server/notifications/capability.ts";
import {
	CALLBACK_CHANNEL_MESSAGE,
	CALLBACK_PONG,
	CALLBACK_UPDATE_MESSAGE,
	DISCORD_INTERACTIONS_PATH,
	DISCORD_SIGNATURE_HEADER,
	DISCORD_TIMESTAMP_HEADER,
	discordAppChannels,
	discordInteractionRoutes,
	INTERACTION_MESSAGE_COMPONENT,
	INTERACTION_PING,
} from "../../src/server/notifications/discord-interactions.ts";
import { RAW_REJECT_BODY } from "../../src/server/notifications/raw-body.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const USER = "dc-user";
const SECOND = "dc-second";
const OTHER = "dc-other";
const OUTSIDER = "dc-outsider";
// Sorts FIRST of the fixture's channel rows on purpose: `discordAppChannels`
// orders by user id, so a webhook row that leaked past the SQL mode predicate
// would eat the candidate budget ahead of every app row.
const WEBHOOK_USER = "dc-awebhook";
const userIds = [USER, SECOND, OTHER, OUTSIDER, WEBHOOK_USER] as const;
const WS = "dc-ws";
const LIST = "dc-list";
const TASK = "dc-task";
const CHANNEL_A = "111111111111111111";
const CHANNEL_B = "222222222222222222";
const UNCONFIGURED_CHANNEL = "999999999999999999";
const MESSAGE_TEXT = "Take meds\n\nDue now";
const OCCURRENCE = new Date("2026-08-01T20:00:00Z");
// A fixed instant for the replay-window test: the window is the listener's own
// clock against the header, so skewing the header against the wall clock would
// only test the wall clock.
const FROZEN = OCCURRENCE.getTime();

// A Discord app's Ed25519 keypair. The public key is exchanged as raw hex, which
// is the last 32 bytes of the SPKI DER encoding.
function discordApp(): { publicKey: string; sign: (m: Buffer) => string } {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
	return {
		publicKey: der.subarray(der.length - 32).toString("hex"),
		// Ed25519 signs through the one-shot API, never createSign.
		sign: (message) => sign(null, message, privateKey).toString("hex"),
	};
}

const APP_A = discordApp();
const APP_B = discordApp();

function listener(
	overrides: {
		capacity?: number;
		refillPerSec?: number;
		now?: () => number;
		candidateLimit?: number;
	} = {},
	database: typeof db = db,
) {
	return new Elysia().use(
		discordInteractionRoutes(database, { env: process.env, ...overrides }),
	);
}

function componentInteraction(
	customId: string,
	over: {
		channelId?: string;
		content?: string | null;
		dm?: boolean;
		noUser?: boolean;
	} = {},
) {
	const invoker = { id: "555000111222333444", username: "ann" };
	return {
		id: "interaction-1",
		application_id: "app-1",
		type: INTERACTION_MESSAGE_COMPONENT,
		token: "discord-interaction-token",
		channel_id: over.channelId ?? CHANNEL_A,
		data: { custom_id: customId, component_type: 2 },
		message: {
			id: "msg-1",
			...(over.content === null
				? {}
				: { content: over.content ?? MESSAGE_TEXT }),
		},
		...(over.noUser
			? {}
			: over.dm
				? { user: invoker }
				: { member: { user: invoker, roles: [] } }),
	};
}

// Signs the exact octets, like Discord does -- never a re-serialization.
function post(
	instance: ReturnType<typeof listener>,
	body: unknown,
	over: {
		app?: typeof APP_A;
		timestamp?: string;
		signature?: string | null;
		omitTimestamp?: boolean;
	} = {},
) {
	const raw = Buffer.from(JSON.stringify(body), "utf8");
	const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
	const signer = over.app ?? APP_A;
	const signature =
		over.signature === undefined
			? signer.sign(Buffer.concat([Buffer.from(timestamp, "utf8"), raw]))
			: over.signature;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (signature !== null) headers[DISCORD_SIGNATURE_HEADER] = signature;
	if (!over.omitTimestamp) headers[DISCORD_TIMESTAMP_HEADER] = timestamp;
	return instance.handle(
		new Request(`http://localhost:3000${DISCORD_INTERACTIONS_PATH}`, {
			method: "POST",
			headers,
			body: raw,
		}),
	);
}

async function callbackOf(response: Response) {
	return (await response.json()) as {
		type: number;
		data?: { content?: string; components?: unknown[]; flags?: number };
	};
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
		id: `dc-cap-${crypto.randomUUID()}`,
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
		.where(like(tables.rateBucket.key, "discord:%"));
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
		name: "DC WS",
		ownerId: USER,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		userIds.map((id) => ({
			id: `dc-m-${id}`,
			userId: id,
			workspaceId: WS,
			role: id === USER ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: USER,
		title: "DC list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: TASK,
		listId: LIST,
		title: "Take meds",
		sortKey: "a0",
	});
	const ring = channelKeyRing(process.env);
	await db.insert(tables.notificationChannel).values([
		// App A, channel A: two users share the family channel.
		...[USER, SECOND].map((id) => ({
			id: `dc-ch-${id}`,
			userId: id,
			kind: "discord" as const,
			config: encryptChannelConfig(
				"discord",
				{
					mode: "app",
					botToken: `bot-token-${id}`,
					publicKey: APP_A.publicKey,
					channelId: CHANNEL_A,
				},
				ring,
			),
		})),
		// A SECOND Discord app on its own channel: without it, "signed by the
		// wrong app" cannot be distinguished from "wrong channel".
		{
			id: "dc-ch-other",
			userId: OTHER,
			kind: "discord",
			config: encryptChannelConfig(
				"discord",
				{
					mode: "app",
					botToken: "bot-token-other",
					publicKey: APP_B.publicKey,
					channelId: CHANNEL_B,
				},
				ring,
			),
		},
		// Webhook mode carries no public key and dispatches no interaction; it
		// must never become a verification candidate.
		{
			id: "dc-ch-webhook",
			userId: WEBHOOK_USER,
			kind: "discord",
			config: encryptChannelConfig(
				"discord",
				{
					mode: "webhook",
					webhookUrl: "https://discord.com/api/webhooks/1/abcdefabcdefabcdef",
				},
				ring,
			),
		},
	]);
	// OUTSIDER intentionally has no discord channel: that is what makes the
	// recipient-binding test meaningful.
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("discord interactions: registration", () => {
	// Without this the operator cannot save the interactions URL at all: Discord
	// refuses the endpoint and reports a provider-side error with no detail.
	test("a PING answers PONG", async () => {
		const response = await post(listener(), {
			id: "ping-1",
			application_id: "app-1",
			type: INTERACTION_PING,
			token: "ping-token",
		});
		expect(response.status).toBe(200);
		expect(await callbackOf(response)).toEqual({ type: CALLBACK_PONG });
		expect(CALLBACK_PONG).toBe(1);
	});

	test("an unsigned PING is refused with 401", async () => {
		const response = await post(
			listener(),
			{ id: "ping-2", type: INTERACTION_PING },
			{ signature: null },
		);
		expect(response.status).toBe(401);
	});
});

describe("discord interactions: ack", () => {
	test("acks the reminder, terminates siblings and edits the message", async () => {
		const mine = await seedReminder("dc-r1", USER);
		const sibling = await seedReminder("dc-r1b", SECOND);
		const token = await mintCapability(mine, USER);

		const response = await post(listener(), componentInteraction(`c:${token}`));
		expect(response.status).toBe(200);

		const acked = await reminderRow(mine);
		expect(acked.status).toBe("acked");
		expect(acked.ackedVia).toBe("discord");
		expect(acked.nextAttemptAt).toBeNull();
		expect((await taskRow()).done).toBe(true);
		// C7: a co-assignee must stop escalating what someone already acked.
		expect((await reminderRow(sibling)).status).toBe("acked");

		// UPDATE_MESSAGE with no components: the button is removed in place, so a
		// second press is not offered at all.
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect(CALLBACK_UPDATE_MESSAGE).toBe(7);
		expect(callback.data?.components).toEqual([]);
		expect(callback.data?.content).toBe(`${MESSAGE_TEXT}\n\n✓ Done`);
	});

	test("a second user on the same channel acks with their own capability", async () => {
		const reminderId = await seedReminder("dc-r2", SECOND);
		const token = await mintCapability(reminderId, SECOND);

		const response = await post(listener(), componentInteraction(`c:${token}`));
		expect((await callbackOf(response)).type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	test("a DM-shaped interaction carries its invoker under `user`", async () => {
		const reminderId = await seedReminder("dc-r3", USER);
		const token = await mintCapability(reminderId, USER);

		const response = await post(
			listener(),
			componentInteraction(`c:${token}`, { dm: true }),
		);
		expect((await callbackOf(response)).type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	test("a message with no content still loses its button", async () => {
		const reminderId = await seedReminder("dc-r4", USER);
		const token = await mintCapability(reminderId, USER);

		const response = await post(
			listener(),
			componentInteraction(`c:${token}`, { content: null }),
		);
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect(callback.data?.components).toEqual([]);
		expect(callback.data).not.toHaveProperty("content");
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	test("a message at the content cap keeps the whole done marker", async () => {
		const reminderId = await seedReminder("dc-r14", USER);
		const token = await mintCapability(reminderId, USER);

		const response = await post(
			listener(),
			// One short of the cap: the marker no longer fits, so trimming the
			// joined string would edit the message to end mid-marker.
			componentInteraction(`c:${token}`, {
				content: "x".repeat(CONTENT_MAX - 1),
			}),
		);
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect(callback.data?.content?.length).toBe(CONTENT_MAX);
		expect(callback.data?.content?.endsWith("\n\n✓ Done")).toBe(true);
	});

	test("a user sorting past the candidate cap can still ack", async () => {
		const reminderId = await seedReminder("dc-r15", USER);
		const token = await mintCapability(reminderId, USER);
		// The cap bounds the pre-verification key scan, which cannot narrow on
		// anything; USER's row sorts last of the three app rows, so a cap of 2
		// excludes it from that scan entirely. The recipient set must come from
		// the channel-narrowed query instead, or this user could never ack.
		const response = await post(
			listener({ candidateLimit: 2 }),
			componentInteraction(`c:${token}`),
		);
		expect((await callbackOf(response)).type).toBe(CALLBACK_UPDATE_MESSAGE);
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	test("the pre-verification key scan is cached across requests", async () => {
		let scans = 0;
		const counting = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "select") scans += 1;
				return Reflect.get(target, property, receiver);
			},
		}) as typeof db;
		const instance = listener({}, counting);
		const ping = { id: "ping-3", type: INTERACTION_PING };

		expect((await callbackOf(await post(instance, ping))).type).toBe(
			CALLBACK_PONG,
		);
		expect((await callbackOf(await post(instance, ping))).type).toBe(
			CALLBACK_PONG,
		);
		// Unauthenticated: without the cache every request that clears the IP
		// bucket pays a table scan plus one decrypt per app-mode row.
		expect(scans).toBe(1);
	});

	test("a replayed interaction is inert", async () => {
		const reminderId = await seedReminder("dc-r5", USER);
		const token = await mintCapability(reminderId, USER);
		const instance = listener();

		const first = await post(instance, componentInteraction(`c:${token}`));
		expect((await callbackOf(first)).type).toBe(CALLBACK_UPDATE_MESSAGE);
		await db
			.update(tables.task)
			.set({ done: false, completedAt: null })
			.where(eq(tables.task.id, TASK));

		const second = await post(instance, componentInteraction(`c:${token}`));
		expect(second.status).toBe(200);
		const callback = await callbackOf(second);
		// A decided refusal, ephemeral: the shared channel's message is untouched.
		expect(callback.type).toBe(CALLBACK_CHANNEL_MESSAGE);
		expect(callback.data?.flags).toBe(64);
		expect(callback.data?.content).toBe("This reminder is no longer active.");
		expect((await taskRow()).done).toBe(false);
	});
});

describe("discord interactions: rejection", () => {
	test("a forged or absent signature answers 401 and changes nothing", async () => {
		const reminderId = await seedReminder("dc-r6", USER);
		const token = await mintCapability(reminderId, USER);
		const body = componentInteraction(`c:${token}`);
		const forged = "ab".repeat(64);
		const cases: Parameters<typeof post>[2][] = [
			{ signature: forged },
			{ signature: null },
			{ signature: "not-hex" },
			{ omitTimestamp: true },
			// Correctly signed, but by an app this deployment does not know.
			{ app: discordApp() },
		];

		for (const over of cases) {
			const response = await post(listener(), body, over);
			expect(response.status, JSON.stringify(over)).toBe(401);
			expect(await response.text()).toBe(RAW_REJECT_BODY);
			expect((await reminderRow(reminderId)).status).toBe("pending");
			expect((await taskRow()).done).toBe(false);
			// Not even consumed: the body was never parsed.
			expect((await capabilityRow(token)).consumedAt).toBeNull();
		}
	});

	test("an expired and a future timestamp are both refused", async () => {
		const reminderId = await seedReminder("dc-r7", USER);
		const token = await mintCapability(reminderId, USER);
		const body = componentInteraction(`c:${token}`);
		const frozen = () => listener({ now: () => FROZEN });
		const nowSec = Math.floor(FROZEN / 1000);

		for (const skew of [-400, 400]) {
			const response = await post(frozen(), body, {
				timestamp: String(nowSec + skew),
			});
			expect(response.status, `skew ${skew}`).toBe(401);
			expect((await reminderRow(reminderId)).status).toBe("pending");
			expect((await capabilityRow(token)).consumedAt).toBeNull();
		}

		// The same bytes inside the window still pass, so the two rejections above
		// are the window and not a broken signature.
		const ok = await post(frozen(), body, {
			timestamp: String(nowSec - 100),
		});
		expect(ok.status).toBe(200);
		expect((await callbackOf(ok)).type).toBe(CALLBACK_UPDATE_MESSAGE);
	});

	test("an app cannot act on another app's channel", async () => {
		const reminderId = await seedReminder("dc-r8", USER);
		const token = await mintCapability(reminderId, USER);

		// Validly signed by app B, but claiming app A's channel id. The signature
		// verifies against a configured key, so only the per-app channel binding
		// stops it.
		const response = await post(
			listener(),
			componentInteraction(`c:${token}`, { channelId: CHANNEL_A }),
			{ app: APP_B },
		);
		expect(response.status).toBe(200);
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_CHANNEL_MESSAGE);
		expect(callback.data?.content).toBe("This reminder is no longer active.");
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a capability bound to a non-recipient is refused, keeping the burn", async () => {
		const reminderId = await seedReminder("dc-r9", OUTSIDER);
		// Bound to OUTSIDER, who has no discord channel; the press arrives from
		// channel A.
		const token = await mintCapability(reminderId, OUTSIDER);

		const response = await post(listener(), componentInteraction(`c:${token}`));
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_CHANNEL_MESSAGE);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		// The burn is kept, like every other post-consume binding failure.
		expect((await capabilityRow(token)).consumedAt).not.toBeNull();
	});

	test("a press from an unconfigured channel burns nothing", async () => {
		const reminderId = await seedReminder("dc-r10", USER);
		const token = await mintCapability(reminderId, USER);

		const response = await post(
			listener(),
			componentInteraction(`c:${token}`, { channelId: UNCONFIGURED_CHANNEL }),
		);
		expect((await callbackOf(response)).type).toBe(CALLBACK_CHANNEL_MESSAGE);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a redeem that throws keeps the capability alive and says try again", async () => {
		const reminderId = await seedReminder("dc-r11", USER);
		const token = await mintCapability(reminderId, USER);
		// The consume runs inside the transaction redeemAckCapability rethrows out
		// of, so the burn rolls back and the token is still live.
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
			listener({}, broken),
			componentInteraction(`c:${token}`),
		);
		// Discord does not redeliver an interaction, and its initial response is
		// due within 3 seconds (missing that invalidates the interaction token),
		// so a 500 would buy no retry and only show the user the generic
		// "This interaction failed".
		expect(response.status).toBe(200);
		const callback = await callbackOf(response);
		expect(callback.type).toBe(CALLBACK_CHANNEL_MESSAGE);
		expect(callback.data?.content).toBe(
			"Couldn't reach the server. Try again.",
		);
		// The button must stay pressable, so the message is NOT edited.
		expect(callback.type).not.toBe(CALLBACK_UPDATE_MESSAGE);

		expect((await capabilityRow(token)).consumedAt).toBeNull();
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
	});

	test("the rate limit engages", async () => {
		const reminderId = await seedReminder("dc-r12", USER);
		const token = await mintCapability(reminderId, USER);
		// Fractional refill on purpose: a zero rate hides the bugs this limiter
		// has already shipped twice.
		const instance = listener({ capacity: 1, refillPerSec: 0.5 });

		const first = await post(instance, componentInteraction(`c:${token}`));
		expect((await callbackOf(first)).type).toBe(CALLBACK_UPDATE_MESSAGE);
		const limited = await post(instance, componentInteraction(`c:${token}`));
		expect(limited.status).toBe(429);
		expect((await taskRow()).done).toBe(true);
	});

	test("a malformed interaction is answered without a 500", async () => {
		const reminderId = await seedReminder("dc-r13", USER);
		const token = await mintCapability(reminderId, USER);
		const instance = listener();
		const bodies: unknown[] = [
			{},
			{ type: INTERACTION_MESSAGE_COMPONENT },
			// No data at all.
			{ type: INTERACTION_MESSAGE_COMPONENT, channel_id: CHANNEL_A },
			// data without a custom_id.
			{
				type: INTERACTION_MESSAGE_COMPONENT,
				channel_id: CHANNEL_A,
				data: { component_type: 2 },
			},
			// A custom_id another feature could mint.
			componentInteraction("other:thing"),
			componentInteraction("c:"),
			// Over Discord's documented custom_id cap.
			componentInteraction(`c:${"a".repeat(200)}`),
			// A component press with no invoking user at all.
			componentInteraction(`c:${token}`, { noUser: true }),
			// A type we do not serve.
			{ type: 2, channel_id: CHANNEL_A, data: { name: "slash" } },
			[],
			"not-an-object",
			null,
		];

		for (const body of bodies) {
			const response = await post(instance, body);
			expect(response.status, JSON.stringify(body)).toBe(200);
			const callback = await callbackOf(response);
			expect(callback.type, JSON.stringify(body)).toBe(
				CALLBACK_CHANNEL_MESSAGE,
			);
		}
		expect((await taskRow()).done).toBe(false);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});
});

describe("discord interactions: candidates", () => {
	// Asserted at this layer because the route cannot observe it: a webhook row
	// carries no publicKey, so it would fail signature verification regardless.
	// The exclusion is what keeps it from consuming the candidate budget, which
	// the cap test pins. The two guards are redundant by construction -- the SQL
	// predicate and the schema discriminant read the same `mode` -- so only
	// removing BOTH fails here; removing either alone is invisible everywhere.
	test("a webhook-mode row is never a candidate", async () => {
		const channels = await discordAppChannels(db, process.env);
		expect(channels.map((channel) => channel.userId)).toEqual([
			OTHER,
			SECOND,
			USER,
		]);
		expect(channels.every((channel) => channel.userId !== WEBHOOK_USER)).toBe(
			true,
		);
		expect(
			channels.every((channel) => /^[0-9a-f]{64}$/.test(channel.publicKey)),
		).toBe(true);
	});

	test("channelIds narrows to one channel's members", async () => {
		const channels = await discordAppChannels(db, process.env, {
			channelIds: [CHANNEL_A],
		});
		expect(channels.map((channel) => channel.userId)).toEqual([SECOND, USER]);
	});
});

describe("discord interactions: mounting", () => {
	// The URL the operator pastes into the developer portal must be one the app
	// answers, or registration fails and every ack 404s.
	test("the app serves the listener path", async () => {
		const response = await app.handle(
			new Request(`http://localhost:3000${DISCORD_INTERACTIONS_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: INTERACTION_PING }),
			}),
		);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
	});
});
