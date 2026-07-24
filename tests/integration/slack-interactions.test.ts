// The Slack listener against a real Postgres. It is an unauthenticated public
// endpoint that completes someone's task, so the rejection classes matter as
// much as the happy path -- and it carries one hazard Discord's does not: the
// moment a Request URL exists, every webhook-mode LINK button in the deployment
// starts delivering an interaction here. Those must be acknowledged, not
// refused, or a button that worked yesterday grows a red "!".
//
// The fixture deliberately carries THREE Slack apps, three channels and six
// users: one app and one channel would make cross-app confusion, channel
// binding and recipient binding all unreachable at once, and the third app
// exists only so one app-mode row sorts past an injected candidate cap.
import { createHmac } from "node:crypto";
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
import { SECTION_TEXT_MAX } from "../../src/server/notifications/adapters/slack.ts";
import {
	ACK_ACTION,
	ACK_TTL_MS,
	ackToken,
	hashAckToken,
} from "../../src/server/notifications/capability.ts";
import {
	ChannelError,
	saveChannel,
} from "../../src/server/notifications/channels.ts";
import { RAW_REJECT_BODY } from "../../src/server/notifications/raw-body.ts";
import {
	SLACK_INTERACTIONS_PATH,
	SLACK_SIGNATURE_HEADER,
	SLACK_TIMESTAMP_HEADER,
	slackInteractionRoutes,
} from "../../src/server/notifications/slack-interactions.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const USER = "sl-user";
const SECOND = "sl-second";
const OTHER = "sl-other";
const OUTSIDER = "sl-outsider";
const WEBHOOK_USER = "sl-webhook";
// Sorts LAST by user id, which is the ordering appModeChannels applies: this
// row is what an un-narrowed cap would silently drop.
const LAST_USER = "sl-zlast";
const userIds = [
	USER,
	SECOND,
	OTHER,
	OUTSIDER,
	WEBHOOK_USER,
	LAST_USER,
] as const;
const WS = "sl-ws";
const LIST = "sl-list";
const TASK = "sl-task";
const CHANNEL_A = "C0A1B2C3D4";
const CHANNEL_B = "C9Z8Y7X6W5";
const CHANNEL_C = "C5L4A3S2T1";
const UNCONFIGURED_CHANNEL = "C0000000000";
const SECRET_A = "8f742231b10e8888abcd99yyyzzz85a5";
const SECRET_B = "1a2b3c4d5e6f70819293a4b5c6d7e8f9";
const SECRET_C = "fedcba98765432100123456789abcdef";
const MESSAGE_TEXT = "Take meds";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0A1B2C3D4/1111/2222";
const OCCURRENCE = new Date("2026-08-01T20:00:00Z");

type Call = { url: string; body: Record<string, unknown> };

function recorder() {
	const calls: Call[] = [];
	const fetchImpl = (async (url, options = {}) => {
		calls.push({
			url: String(url),
			body: JSON.parse(String(options?.body ?? "{}")),
		});
		return new Response("ok", { status: 200 });
	}) as typeof safeFetch;
	return { calls, fetchImpl };
}

function listener(
	overrides: {
		capacity?: number;
		refillPerSec?: number;
		now?: () => number;
		fetch?: typeof safeFetch;
		candidateLimit?: number;
	} = {},
	database: typeof db = db,
) {
	return new Elysia().use(
		slackInteractionRoutes(database, { env: process.env, ...overrides }),
	);
}

// Our own ack button, as adapters/slack.ts mints it.
function ackInteraction(
	token: string,
	over: {
		channelId?: string;
		responseUrl?: string | null;
		messageText?: string | null;
		noUser?: boolean;
		actionId?: string;
		value?: string | null;
	} = {},
) {
	return {
		type: "block_actions",
		...(over.noUser ? {} : { user: { id: "U0A1B2C3D4", name: "ann" } }),
		channel: { id: over.channelId ?? CHANNEL_A, name: "family" },
		message: {
			ts: "1503435956.000247",
			...(over.messageText === null
				? {}
				: { text: over.messageText ?? MESSAGE_TEXT }),
		},
		...(over.responseUrl === null
			? {}
			: { response_url: over.responseUrl ?? RESPONSE_URL }),
		actions: [
			{
				type: "button",
				block_id: "b1",
				action_id: over.actionId ?? "ditero_ack",
				...(over.value === null ? {} : { value: over.value ?? `c:${token}` }),
				action_ts: "1503435956.000247",
			},
		],
	};
}

// THE HAZARD: a webhook-mode LINK button. It carries a `url`, no `value`, and
// an action_id Slack generated for us -- and Slack delivers it here anyway.
function linkButtonInteraction(over: { channelId?: string } = {}) {
	return {
		type: "block_actions",
		user: { id: "U0A1B2C3D4", name: "ann" },
		channel: { id: over.channelId ?? CHANNEL_A, name: "family" },
		message: { ts: "1503435956.000247", text: MESSAGE_TEXT },
		response_url: RESPONSE_URL,
		actions: [
			{
				type: "button",
				block_id: "b1",
				// Slack mints this when the app did not supply one.
				action_id: "z1kM+",
				url: "https://app.example.test/api/notifications/ack/abc",
				action_ts: "1503435956.000247",
			},
		],
	};
}

// Signs the exact FORM octets, like Slack does -- never the JSON inside.
function post(
	instance: ReturnType<typeof listener>,
	payload: unknown,
	over: {
		secret?: string;
		timestamp?: string;
		signature?: string | null;
		contentType?: string;
		rawBody?: string;
		// Signs these octets while sending `raw`: the re-serialization trap the
		// raw-body seam exists to make unreachable.
		signOver?: string;
	} = {},
) {
	const raw =
		over.rawBody ?? `payload=${encodeURIComponent(JSON.stringify(payload))}`;
	const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
	const secret = over.secret ?? SECRET_A;
	const signed = over.signOver ?? raw;
	const signature =
		over.signature === undefined
			? `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${signed}`).digest("hex")}`
			: over.signature;
	const headers: Record<string, string> = {
		"content-type": over.contentType ?? "application/x-www-form-urlencoded",
		[SLACK_TIMESTAMP_HEADER]: timestamp,
	};
	if (signature !== null) headers[SLACK_SIGNATURE_HEADER] = signature;
	return instance.handle(
		new Request(`http://localhost:3000${SLACK_INTERACTIONS_PATH}`, {
			method: "POST",
			headers,
			body: raw,
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
		id: `sl-cap-${crypto.randomUUID()}`,
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
		.where(like(tables.rateBucket.key, "slack:%"));
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
		name: "SL WS",
		ownerId: USER,
		kind: "shared",
	});
	await db.insert(tables.membership).values(
		userIds.map((id) => ({
			id: `sl-m-${id}`,
			userId: id,
			workspaceId: WS,
			role: id === USER ? ("owner" as const) : ("member" as const),
		})),
	);
	await db.insert(tables.list).values({
		id: LIST,
		workspaceId: WS,
		ownerId: USER,
		title: "SL list",
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
			id: `sl-ch-${id}`,
			userId: id,
			kind: "slack" as const,
			config: encryptChannelConfig(
				"slack",
				{
					mode: "app",
					botToken: `xoxb-token-${id}`,
					signingSecret: SECRET_A,
					channelId: CHANNEL_A,
				},
				ring,
			),
		})),
		// A SECOND Slack app on its own channel: without it, "signed by the wrong
		// app" cannot be distinguished from "wrong channel".
		{
			id: "sl-ch-other",
			userId: OTHER,
			kind: "slack",
			config: encryptChannelConfig(
				"slack",
				{
					mode: "app",
					botToken: "xoxb-token-other",
					signingSecret: SECRET_B,
					channelId: CHANNEL_B,
				},
				ring,
			),
		},
		// A THIRD app whose user id sorts last of every app-mode row. Only reason
		// it exists: an un-narrowed candidate cap would drop this secret from the
		// pre-verification scan, and nothing else in the fixture would notice.
		{
			id: "sl-ch-zlast",
			userId: LAST_USER,
			kind: "slack",
			config: encryptChannelConfig(
				"slack",
				{
					mode: "app",
					botToken: "xoxb-token-zlast",
					signingSecret: SECRET_C,
					channelId: CHANNEL_C,
				},
				ring,
			),
		},
		// Webhook mode carries no signing secret and mints only a link button; it
		// must never become a verification candidate.
		{
			id: "sl-ch-webhook",
			userId: WEBHOOK_USER,
			kind: "slack",
			config: encryptChannelConfig(
				"slack",
				{
					mode: "webhook",
					webhookUrl: "https://hooks.slack.com/services/T1/B1/abcdefabcdefabcd",
				},
				ring,
			),
		},
	]);
	// OUTSIDER intentionally has no slack channel: that is what makes the
	// recipient-binding test meaningful.
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("slack interactions: ack", () => {
	test("acks the reminder, terminates siblings and replaces the message", async () => {
		const mine = await seedReminder("sl-r1", USER);
		const sibling = await seedReminder("sl-r1b", SECOND);
		const token = await mintCapability(mine, USER);
		const { calls, fetchImpl } = recorder();

		const response = await post(
			listener({ fetch: fetchImpl }),
			ackInteraction(token),
		);
		expect(response.status).toBe(200);

		const acked = await reminderRow(mine);
		expect(acked.status).toBe("acked");
		expect(acked.ackedVia).toBe("slack");
		expect(acked.nextAttemptAt).toBeNull();
		expect((await taskRow()).done).toBe(true);
		// C7: a co-assignee must stop escalating what someone already acked.
		expect((await reminderRow(sibling)).status).toBe("acked");

		// response_url, not chat.update: the button visibly resolves without the
		// listener ever decrypting a bot token.
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(RESPONSE_URL);
		expect(calls[0].body.replace_original).toBe(true);
		expect(calls[0].body.text).toBe(`${MESSAGE_TEXT}\n\n✓ Done`);
		// No blocks in the replacement is what removes the button, so a second
		// press is not offered at all.
		expect(calls[0].body).not.toHaveProperty("blocks");
	});

	test("a second user on the same channel acks with their own capability", async () => {
		const reminderId = await seedReminder("sl-r2", SECOND);
		const token = await mintCapability(reminderId, SECOND);
		const { calls, fetchImpl } = recorder();

		await post(listener({ fetch: fetchImpl }), ackInteraction(token));
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls[0].body.replace_original).toBe(true);
	});

	test("a replayed interaction is inert", async () => {
		const reminderId = await seedReminder("sl-r3", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();
		const instance = listener({ fetch: fetchImpl });

		await post(instance, ackInteraction(token));
		await db
			.update(tables.task)
			.set({ done: false, completedAt: null })
			.where(eq(tables.task.id, TASK));

		const second = await post(instance, ackInteraction(token));
		expect(second.status).toBe(200);
		expect((await taskRow()).done).toBe(false);
		// A decided refusal, ephemeral: the shared channel's message is untouched,
		// or anyone in it could visibly burn someone else's reminder.
		expect(calls).toHaveLength(2);
		expect(calls[1].body.response_type).toBe("ephemeral");
		expect(calls[1].body.replace_original).toBe(false);
		expect(calls[1].body.text).toBe("This reminder is no longer active.");
	});

	test("a message with no text still resolves the button", async () => {
		const reminderId = await seedReminder("sl-r4", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();

		await post(
			listener({ fetch: fetchImpl }),
			ackInteraction(token, { messageText: null }),
		);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls[0].body.replace_original).toBe(true);
		// A replacement with an empty text would blank the message; the button has
		// to go without the message going with it.
		expect(calls[0].body.text).toBe("Reminder\n\n✓ Done");
	});

	// response_url is the one field of a verified payload that becomes an
	// outbound target, and the signer set is user-supplied, so "verified" does
	// not mean "from Slack". The ack itself must still land: refusing to complete
	// someone's task because the cosmetic message update cannot be sent would be
	// the wrong trade.
	test("a response_url off Slack's actions path is not called, and the ack still lands", async () => {
		const hostile = [
			// Suffix of the host, not the host. Fails under `===` and `endsWith`.
			"https://hooks.slack.com.evil.test/actions/1/2/3",
			// PREFIX on the real registrable domain: `endsWith` accepts this, and it
			// is a live SSRF to an attacker-controlled origin.
			"https://evilhooks.slack.com/actions/1/2/3",
			// The real host, but an INCOMING WEBHOOK path. block_actions mints
			// `/actions/...`; posting our `{ text }` at `/services/...` publishes
			// attacker-chosen text into someone else's workspace from our egress IP.
			"https://hooks.slack.com/services/T1/B1/x",
			// Right host, right path, plaintext.
			"http://hooks.slack.com/actions/1/2/3",
		];

		for (const responseUrl of hostile) {
			// reminder_state is unique on (task, occurrence, recipient), so each pass
			// gets a clean slate rather than a second row for the same reminder.
			await wipeVolatile();
			const reminderId = await seedReminder("sl-r4b", USER);
			const token = await mintCapability(reminderId, USER);
			const { calls, fetchImpl } = recorder();

			await post(
				listener({ fetch: fetchImpl }),
				ackInteraction(token, { responseUrl }),
			);
			expect(calls, responseUrl).toHaveLength(0);
			expect((await reminderRow(reminderId)).status, responseUrl).toBe("acked");
		}
	});

	// The adapter clamps every message text it sends to SECTION_TEXT_MAX, so a
	// title at the cap is reachable. Trimming the JOINED string would replace the
	// message with one ending mid-marker -- or, at exactly the cap, with the
	// unchanged message, so a successful ack would look like nothing happened.
	test("a message at the text cap keeps the whole done marker", async () => {
		const reminderId = await seedReminder("sl-r15", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();

		await post(
			listener({ fetch: fetchImpl }),
			// One short of the cap: the marker no longer fits behind it.
			ackInteraction(token, { messageText: "x".repeat(SECTION_TEXT_MAX - 1) }),
		);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		const text = String(calls[0].body.text);
		expect(text.length).toBe(SECTION_TEXT_MAX);
		expect(text.endsWith("\n\n✓ Done")).toBe(true);
	});

	test("an app whose row sorts past the candidate cap can still ack", async () => {
		const reminderId = await seedReminder("sl-r16", LAST_USER);
		const token = await mintCapability(reminderId, LAST_USER);
		const { calls, fetchImpl } = recorder();

		// candidateLimit bounds ONLY the channel-narrowed query. LAST_USER's row
		// sorts last of the four app-mode rows, so the moment the same cap reaches
		// the un-narrowed pre-verification scan its secret disappears from it and
		// this press stops verifying at all -- permanently, for everyone on that
		// app. That is the Discord bug this file's query split exists to avoid.
		const response = await post(
			listener({ fetch: fetchImpl, candidateLimit: 1 }),
			ackInteraction(token, { channelId: CHANNEL_C }),
			{ secret: SECRET_C },
		);
		expect(response.status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls[0].body.replace_original).toBe(true);
	});

	test("a press verified at the edge of the replay window still acks", async () => {
		const reminderId = await seedReminder("sl-r17", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();
		const t0 = Date.now();
		let reads = 0;
		// The clock crosses the 300s window between `verify` and `handle`. The
		// re-derivation in `handle` must be anchored at the instant that verified,
		// or a press arriving at T+299.9s tells a legitimate presser their reminder
		// is over -- a failure mode the re-derivation design introduced.
		const now = () => (reads++ === 0 ? t0 : t0 + 301_000);

		await post(listener({ fetch: fetchImpl, now }), ackInteraction(token), {
			timestamp: String(Math.floor(t0 / 1000)),
		});
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect(calls[0].body.replace_original).toBe(true);
	});

	test("the pre-verification secret scan is cached across requests", async () => {
		let scans = 0;
		const counting = new Proxy(db, {
			get(target, property, receiver) {
				if (property === "select") scans += 1;
				return Reflect.get(target, property, receiver);
			},
		}) as typeof db;
		const { calls, fetchImpl } = recorder();
		// A link button: verified, then dropped before any channel-narrowed query,
		// so the only select left is the pre-verification scan itself.
		const instance = listener({ fetch: fetchImpl }, counting);

		expect((await post(instance, linkButtonInteraction())).status).toBe(200);
		expect((await post(instance, linkButtonInteraction())).status).toBe(200);
		// Unauthenticated: without the cache every request that clears the IP
		// bucket pays a table scan plus one decrypt and one Zod parse per app-mode
		// row -- and this route sees every webhook-mode link button too.
		expect(scans).toBe(1);
		expect(calls).toHaveLength(0);
	});
});

// The whole reason this file cannot mirror discord-interactions.ts.
describe("slack interactions: the webhook-mode link button", () => {
	test("an unrecognised action_id gets a clean 200 and changes nothing", async () => {
		const reminderId = await seedReminder("sl-r5", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();

		const response = await post(
			listener({ fetch: fetchImpl }),
			linkButtonInteraction(),
		);
		// Anything but 200 paints a red "!" on a button that worked yesterday.
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("");
		// Not even an ephemeral: the press opened a working link, and telling the
		// user something is wrong would be the same false alarm in words.
		expect(calls).toHaveLength(0);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a link button from an unconfigured channel is acknowledged too", async () => {
		const { calls, fetchImpl } = recorder();
		const response = await post(
			listener({ fetch: fetchImpl }),
			linkButtonInteraction({ channelId: UNCONFIGURED_CHANNEL }),
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(0);
	});
});

describe("slack interactions: rejection", () => {
	test("a forged or absent signature is refused and changes nothing", async () => {
		const reminderId = await seedReminder("sl-r6", USER);
		const token = await mintCapability(reminderId, USER);
		const body = ackInteraction(token);
		const cases: Parameters<typeof post>[2][] = [
			{ signature: `v0=${"ab".repeat(32)}` },
			{ signature: null },
			{ signature: "not-a-signature" },
			// Correctly computed, but with a secret this deployment does not know.
			{ secret: "0000000000000000000000000000000000" },
			// Signed over DIFFERENT octets than the ones sent: the whole point of
			// the raw-body seam. A route that re-serialized the parsed payload
			// would accept this.
			{ signOver: `payload=${encodeURIComponent(JSON.stringify(body))}&x=1` },
		];

		for (const over of cases) {
			const { calls, fetchImpl } = recorder();
			const response = await post(listener({ fetch: fetchImpl }), body, over);
			expect(response.status, JSON.stringify(over)).toBe(400);
			expect(await response.text()).toBe(RAW_REJECT_BODY);
			expect(calls).toHaveLength(0);
			expect((await reminderRow(reminderId)).status).toBe("pending");
			expect((await taskRow()).done).toBe(false);
			// Not even consumed: the body was never parsed.
			expect((await capabilityRow(token)).consumedAt).toBeNull();
		}
	});

	test("an expired and a future timestamp are both refused", async () => {
		const reminderId = await seedReminder("sl-r7", USER);
		const token = await mintCapability(reminderId, USER);
		const body = ackInteraction(token);
		const nowSec = Math.floor(Date.now() / 1000);

		for (const skew of [-400, 400]) {
			const response = await post(listener(), body, {
				timestamp: String(nowSec + skew),
			});
			expect(response.status, `skew ${skew}`).toBe(400);
			expect((await reminderRow(reminderId)).status).toBe("pending");
			expect((await capabilityRow(token)).consumedAt).toBeNull();
		}

		// The same bytes inside the window still pass, so the two rejections above
		// are the 300s window and not a broken signature.
		const { fetchImpl } = recorder();
		await post(listener({ fetch: fetchImpl }), body, {
			timestamp: String(nowSec - 100),
		});
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	test("an app cannot act on another app's channel", async () => {
		const reminderId = await seedReminder("sl-r8", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();

		// Validly signed by app B, but claiming app A's channel id. The signature
		// verifies against a configured secret, so only the per-app channel binding
		// stops it.
		const response = await post(
			listener({ fetch: fetchImpl }),
			ackInteraction(token, { channelId: CHANNEL_A }),
			{ secret: SECRET_B },
		);
		expect(response.status).toBe(200);
		expect(calls[0].body.text).toBe("This reminder is no longer active.");
		expect(calls[0].body.replace_original).toBe(false);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a press from an unconfigured channel burns nothing", async () => {
		const reminderId = await seedReminder("sl-r9", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();

		await post(
			listener({ fetch: fetchImpl }),
			ackInteraction(token, { channelId: UNCONFIGURED_CHANNEL }),
		);
		expect(calls[0].body.text).toBe("This reminder is no longer active.");
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});

	test("a capability bound to a non-recipient is refused, keeping the burn", async () => {
		const reminderId = await seedReminder("sl-r10", OUTSIDER);
		// Bound to OUTSIDER, who has no slack channel; the press arrives from
		// channel A.
		const token = await mintCapability(reminderId, OUTSIDER);
		const { calls, fetchImpl } = recorder();

		await post(listener({ fetch: fetchImpl }), ackInteraction(token));
		expect(calls[0].body.text).toBe("This reminder is no longer active.");
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
		// The burn is kept, like every other post-consume binding failure.
		expect((await capabilityRow(token)).consumedAt).not.toBeNull();
	});

	test("a redeem that throws keeps the capability alive and says try again", async () => {
		const reminderId = await seedReminder("sl-r11", USER);
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
		const { calls, fetchImpl } = recorder();

		const response = await post(
			listener({ fetch: fetchImpl }, broken),
			ackInteraction(token),
		);
		// Slack does NOT redeliver an interaction payload, so a 500 buys no retry
		// and only shows the user a generic connectivity error.
		expect(response.status).toBe(200);
		expect(calls[0].body.text).toBe("Couldn't reach the server. Try again.");
		// The button must stay pressable, so the message is NOT replaced.
		expect(calls[0].body.replace_original).toBe(false);
		expect((await capabilityRow(token)).consumedAt).toBeNull();
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow()).done).toBe(false);
	});

	test("the rate limit engages", async () => {
		const reminderId = await seedReminder("sl-r12", USER);
		const token = await mintCapability(reminderId, USER);
		const { fetchImpl } = recorder();
		// Fractional refill on purpose: a zero rate hides the bugs this limiter
		// has already shipped twice.
		const instance = listener({
			capacity: 1,
			refillPerSec: 0.5,
			fetch: fetchImpl,
		});

		const first = await post(instance, ackInteraction(token));
		expect(first.status).toBe(200);
		const limited = await post(instance, ackInteraction(token));
		expect(limited.status).toBe(429);
		expect((await taskRow()).done).toBe(true);
	});

	test("a malformed payload is answered without a 500", async () => {
		const reminderId = await seedReminder("sl-r13", USER);
		const token = await mintCapability(reminderId, USER);
		const { calls, fetchImpl } = recorder();
		const instance = listener({ fetch: fetchImpl });
		const payloads: unknown[] = [
			{},
			{ type: "view_submission" },
			// block_actions with no actions array.
			{ type: "block_actions", channel: { id: CHANNEL_A } },
			// Our action_id with no value at all.
			ackInteraction(token, { value: null }),
			// Our action_id with a value another feature could mint.
			ackInteraction(token, { value: "other:thing" }),
			ackInteraction(token, { value: "c:" }),
			// Past Slack's documented value cap.
			ackInteraction(token, { value: `c:${"a".repeat(2_001)}` }),
			// A press with no invoking user at all.
			ackInteraction(token, { noUser: true }),
			[],
			"not-an-object",
			null,
		];

		for (const payload of payloads) {
			const response = await post(instance, payload);
			expect(response.status, JSON.stringify(payload)).toBe(200);
		}
		// A form with no `payload` field at all.
		expect((await post(instance, null, { rawBody: "other=1" })).status).toBe(
			200,
		);
		// A JSON body at a route that only serves forms. VALID JSON and validly
		// signed, and the payload is a real ack -- so `expectedMediaType` is the
		// only thing rejecting it. Sending form octets under a JSON content type
		// would prove nothing: the seam would refuse them as unparseable JSON
		// whether the media type were pinned or not.
		expect(
			(
				await post(instance, null, {
					rawBody: JSON.stringify(ackInteraction(token)),
					contentType: "application/json",
				})
			).status,
		).toBe(400);

		expect(calls).toHaveLength(0);
		expect((await taskRow()).done).toBe(false);
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await capabilityRow(token)).consumedAt).toBeNull();
	});
});

describe("slack app mode: config save", () => {
	// Design 3.1: with no public base URL there is no interactions endpoint to
	// register, so app mode is refused at save rather than stored and left
	// silently non-interactive.
	test("app mode is refused when no public base URL is configured", async () => {
		const env = {
			...process.env,
			DITERO_PUBLIC_URL: "",
			BETTER_AUTH_URL: "",
		};
		const body = {
			kind: "slack",
			config: {
				mode: "app",
				botToken: "xoxb-1-2-abcdefghijklmnop",
				signingSecret: SECRET_A,
				channelId: CHANNEL_A,
			},
		};
		await expect(saveChannel(db, OUTSIDER, body, env)).rejects.toBeInstanceOf(
			ChannelError,
		);
		const rows = await db
			.select()
			.from(tables.notificationChannel)
			.where(eq(tables.notificationChannel.userId, OUTSIDER));
		expect(rows).toHaveLength(0);

		// Webhook mode is unaffected by the same env, so the refusal is the
		// interactive gate and not "slack cannot be saved".
		await saveChannel(
			db,
			OUTSIDER,
			{
				kind: "slack",
				config: {
					mode: "webhook",
					webhookUrl: "https://hooks.slack.com/services/T2/B2/zyxwvutsrqponmlk",
				},
			},
			env,
		);
		expect(
			await db
				.select()
				.from(tables.notificationChannel)
				.where(eq(tables.notificationChannel.userId, OUTSIDER)),
		).toHaveLength(1);
		await db
			.delete(tables.notificationChannel)
			.where(eq(tables.notificationChannel.userId, OUTSIDER));
	});
});

describe("slack interactions: mounting", () => {
	// The URL the operator pastes into the app's interactivity settings must be
	// one the app answers, or every ack 404s.
	test("the app serves the listener path", async () => {
		const response = await app.handle(
			new Request(`http://localhost:3000${SLACK_INTERACTIONS_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "payload=%7B%7D",
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe(RAW_REJECT_BODY);
	});
});
