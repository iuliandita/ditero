// Consume side of the ack capability: the public unauthenticated route, the
// in-app Zero mutator, and the shared completion logic behind both.
//
// This is the milestone's most exposed surface -- an unauthenticated endpoint
// holding a capability that completes someone's task -- so the spec here is the
// rejection behaviour as much as the success path: every failure class must be
// indistinguishable in status, body AND timing, consumption must precede
// validation, and a denied completion must roll the consume back.
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { and, eq, inArray, like } from "drizzle-orm";
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
import { parseTrustedProxyCIDRs } from "../../src/server/client-ip.ts";
import { app } from "../../src/server/index.ts";
import {
	ACK_ACTION,
	ACK_PATH,
	ACK_REJECT_BODY,
	ACK_REJECT_STATUS,
	ACK_TTL_MS,
	ackToken,
	hashAckToken,
	pruneAckCapabilities,
	REJECT_FLOOR_MS,
	takeRateToken,
} from "../../src/server/notifications/capability.ts";
import type { AckRouteOptions } from "../../src/server/notifications/routes.ts";
import { ackRoutes } from "../../src/server/notifications/routes.ts";
import { mutators } from "../../src/zero/mutators.ts";
import type { Schema } from "../../src/zero/schema.gen.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 8 });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const OWNER = "ak-owner";
const MEMBER = "ak-member";
const VIEWER = "ak-viewer";
const OUTSIDER = "ak-out";
const userIds = [OWNER, MEMBER, VIEWER, OUTSIDER] as const;
const WS = "ak-w";
const LIST = "ak-list";
const HLIST = "ak-hlist";
const TASK = "ak-task";
const HABIT = "ak-habit";
const OTHER_TASK = "ak-task2";
const taskIds = [TASK, HABIT, OTHER_TASK] as const;

// 2026-08-01T20:00Z is 2026-08-02 local in Pacific/Auckland (UTC+12), so the
// habit-log date assertion fails if the occurrence is bucketed in UTC.
const OCCURRENCE = new Date("2026-08-01T20:00:00Z");
const MEMBER_TZ = "Pacific/Auckland";
const LOCAL_DATE = "2026-08-02";

type Ctx = { id: string };
async function call<A>(
	mutator: {
		fn: (a: { tx: Transaction<Schema>; ctx: Ctx; args: A }) => Promise<void>;
	},
	c: Ctx,
	args: A,
) {
	return zdb.transaction((tx) => mutator.fn({ tx, ctx: c, args }));
}

async function wipeVolatile() {
	await db
		.delete(tables.ackCapability)
		.where(inArray(tables.ackCapability.recipientUserId, [...userIds]));
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.recipientUserId, [...userIds]));
	await db
		.delete(tables.habitLog)
		.where(inArray(tables.habitLog.habitId, [...taskIds]));
	await db
		.delete(tables.karmaEvent)
		.where(inArray(tables.karmaEvent.userId, [...userIds]));
	await db
		.delete(tables.karma)
		.where(inArray(tables.karma.userId, [...userIds]));
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, "ack:%"));
	await db
		.update(tables.task)
		.set({ done: false, completedAt: null, dueAt: OCCURRENCE })
		.where(inArray(tables.task.id, [...taskIds]));
	await db
		.delete(tables.membership)
		.where(
			and(
				eq(tables.membership.workspaceId, WS),
				eq(tables.membership.userId, OUTSIDER),
			),
		);
}

async function wipe() {
	await wipeVolatile();
	await db.delete(tables.task).where(inArray(tables.task.id, [...taskIds]));
	await db.delete(tables.list).where(inArray(tables.list.id, [LIST, HLIST]));
	await db
		.delete(tables.userPref)
		.where(inArray(tables.userPref.id, [...userIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, WS));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

async function seedReminder(
	id: string,
	recipientUserId: string,
	fields: Partial<typeof tables.reminderState.$inferInsert> = {},
) {
	await db.insert(tables.reminderState).values({
		id,
		taskId: TASK,
		occurrenceAt: OCCURRENCE,
		recipientUserId,
		status: "pending",
		fireCount: 1,
		nextAttemptAt: new Date(Date.now() + 60_000),
		...fields,
	});
	return id;
}

// Mirrors what dispatch.mintAckUrl writes; the raw token is returned once and
// never persisted.
async function mintCapability(
	reminderStateId: string,
	recipientUserId: string,
	fields: Partial<typeof tables.ackCapability.$inferInsert> = {},
) {
	const token = ackToken();
	await db.insert(tables.ackCapability).values({
		id: `ak-cap-${crypto.randomUUID()}`,
		tokenHash: hashAckToken(token),
		reminderStateId,
		recipientUserId,
		action: ACK_ACTION,
		expiresAt: new Date(Date.now() + ACK_TTL_MS),
		...fields,
	});
	return token;
}

function ackRequest(token: string, headers: Record<string, string> = {}) {
	return new Request(`http://localhost:3000${ACK_PATH}/${token}`, {
		method: "POST",
		headers,
	});
}

async function postAck(token: string, headers: Record<string, string> = {}) {
	return await app.handle(ackRequest(token, headers));
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

async function capabilityFor(token: string) {
	const rows = await db
		.select()
		.from(tables.ackCapability)
		.where(eq(tables.ackCapability.tokenHash, hashAckToken(token)));
	return rows[0];
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
		name: "Ack WS",
		ownerId: OWNER,
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{ id: "ak-m-owner", userId: OWNER, workspaceId: WS, role: "owner" },
		{ id: "ak-m-member", userId: MEMBER, workspaceId: WS, role: "member" },
		{ id: "ak-m-viewer", userId: VIEWER, workspaceId: WS, role: "viewer" },
	]);
	await db.insert(tables.list).values([
		{
			id: LIST,
			workspaceId: WS,
			ownerId: OWNER,
			title: "Ack list",
			kind: "tasks",
			sortKey: "a0",
		},
		{
			id: HLIST,
			workspaceId: WS,
			ownerId: OWNER,
			title: "Ack habits",
			kind: "habits",
			sortKey: "a1",
		},
	]);
	await db.insert(tables.task).values([
		{ id: TASK, listId: LIST, title: "Take meds", sortKey: "a0" },
		{ id: OTHER_TASK, listId: LIST, title: "Other", sortKey: "a1" },
		{ id: HABIT, listId: HLIST, title: "Walk the dog", sortKey: "a0" },
	]);
	await db.insert(tables.userPref).values({ id: MEMBER, timezone: MEMBER_TZ });
});

beforeEach(wipeVolatile);

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("ack route: success", () => {
	// The minted URL and the mounted route must agree, or every ack button 404s.
	test("the mounted path is the path dispatch mints", async () => {
		const token = await mintCapability(
			await seedReminder("ak-r-path", MEMBER),
			MEMBER,
		);
		// Built exactly as dispatch.mintAckUrl builds it.
		const minted = new URL(`http://localhost:3000${ACK_PATH}/${token}`);
		const response = await app.handle(new Request(minted, { method: "POST" }));
		expect(response.status).toBe(200);
	});

	test("acks a task-kind reminder and completes the task", async () => {
		const reminderId = await seedReminder("ak-r1", MEMBER);
		const token = await mintCapability(reminderId, MEMBER);

		const response = await postAck(token);
		expect(response.status).toBe(200);

		const reminder = await reminderRow(reminderId);
		expect(reminder.status).toBe("acked");
		expect(reminder.ackedVia).toBe("capability");
		expect(reminder.ackedAt).not.toBeNull();
		expect(reminder.nextAttemptAt).toBeNull();

		const task = await taskRow(TASK);
		expect(task.done).toBe(true);
		expect(task.completedAt).not.toBeNull();
	});

	// C22: med reminders and dog walks are habit-kind, and task.complete throws
	// for those lists. Routing every ack through it would break the button for
	// exactly the reminders that most need it.
	test("acks a habit-kind reminder and logs the occurrence's local date", async () => {
		const reminderId = await seedReminder("ak-r2", MEMBER, { taskId: HABIT });
		const token = await mintCapability(reminderId, MEMBER);

		expect((await postAck(token)).status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("acked");

		const logs = await db
			.select()
			.from(tables.habitLog)
			.where(eq(tables.habitLog.habitId, HABIT));
		expect(logs).toHaveLength(1);
		expect(logs[0].date).toBe(LOCAL_DATE);
		expect(logs[0].status).toBe("done");
		expect(logs[0].karmaDelta).toBeGreaterThan(0);
		// The habit task itself is never marked done -- habits never finish.
		expect((await taskRow(HABIT)).done).toBe(false);
	});

	// C7: without sibling termination a co-assignee's phone keeps escalating a
	// med reminder someone already acked.
	test("terminates sibling reminders on the same occurrence", async () => {
		const mine = await seedReminder("ak-r3a", MEMBER);
		const sibling = await seedReminder("ak-r3b", OWNER);
		const unrelated = await seedReminder("ak-r3c", MEMBER, {
			taskId: OTHER_TASK,
		});
		const token = await mintCapability(mine, MEMBER);

		expect((await postAck(token)).status).toBe(200);

		const siblingRow = await reminderRow(sibling);
		expect(siblingRow.status).toBe("acked");
		expect(siblingRow.nextAttemptAt).toBeNull();
		expect(siblingRow.ackedAt).not.toBeNull();
		// A reminder for a different task is untouched.
		expect((await reminderRow(unrelated)).status).toBe("pending");
	});

	// C24: the ack button is pressed from ntfy's web UI (a genuine cross-origin
	// request) and from a push client with no session. Guarding this route would
	// return 403 for every real ack.
	test("is reachable cross-origin and unauthenticated", async () => {
		const reminderId = await seedReminder("ak-r4", MEMBER);
		const token = await mintCapability(reminderId, MEMBER);

		const response = await postAck(token, { origin: "https://ntfy.sh" });
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect((await reminderRow(reminderId)).status).toBe("acked");
	});

	// Asserted against the route module rather than the app: in dev/test the
	// global CORS plugin answers OPTIONS itself before any handler runs. In
	// production it is configured `preflight: false`, so this handler is the one
	// that replies -- which is the case that matters for a preflighted ack.
	test("answers preflight for a cross-origin ack", async () => {
		const standalone = new Elysia().use(ackRoutes(db));
		const response = await standalone.handle(
			new Request(`http://localhost:3000${ACK_PATH}/whatever`, {
				method: "OPTIONS",
				headers: {
					origin: "https://ntfy.sh",
					"access-control-request-method": "POST",
				},
			}),
		);
		expect(response.status).toBeLessThan(300);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("ack route: rejection", () => {
	async function expectRejected(response: Response) {
		expect(response.status).toBe(ACK_REJECT_STATUS);
		expect(await response.text()).toBe(ACK_REJECT_BODY);
	}

	test("rejects a second presentation of the same token", async () => {
		const reminderId = await seedReminder("ak-r5", MEMBER);
		const token = await mintCapability(reminderId, MEMBER);

		expect((await postAck(token)).status).toBe(200);
		await expectRejected(await postAck(token));
	});

	test("rejects an expired token", async () => {
		const reminderId = await seedReminder("ak-r6", MEMBER);
		const token = await mintCapability(reminderId, MEMBER, {
			expiresAt: new Date(Date.now() - 1_000),
		});

		await expectRejected(await postAck(token));
		expect((await reminderRow(reminderId)).status).toBe("pending");
	});

	// Consume-before-validate burns the token even though the binding check is
	// what rejected it: an attacker who guessed a token cannot retry it with a
	// corrected binding.
	test("rejects a token bound to a different recipient, and burns it", async () => {
		const reminderId = await seedReminder("ak-r7", MEMBER);
		const token = await mintCapability(reminderId, OWNER);

		await expectRejected(await postAck(token));
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await capabilityFor(token)).consumedAt).not.toBeNull();
	});

	// A token only ever acks the reminder it was minted for; there is no way to
	// point it at another one.
	test("does not touch a reminder it was not minted for", async () => {
		const mine = await seedReminder("ak-r8a", MEMBER);
		const other = await seedReminder("ak-r8b", MEMBER, { taskId: OTHER_TASK });
		const token = await mintCapability(mine, MEMBER);

		expect((await postAck(token)).status).toBe(200);
		expect((await reminderRow(other)).status).toBe("pending");
	});

	// C27: bindings are checked on consume, so a capability minted for one
	// action must not redeem another.
	test("rejects a token minted for a different action", async () => {
		const reminderId = await seedReminder("ak-r9", MEMBER);
		const token = await mintCapability(reminderId, MEMBER, {
			action: "snooze",
		});

		await expectRejected(await postAck(token));
		expect((await reminderRow(reminderId)).status).toBe("pending");
	});

	test("rejects a garbage token", async () => {
		await expectRejected(await postAck("not-a-real-token"));
	});

	// An unexpected failure inside the redeem must not surface as a 500: that
	// would tell a prober the token reached the completion path, which is the
	// single most valuable oracle the uniform rejection exists to deny.
	test("turns an unexpected redeem failure into a floored rejection", async () => {
		const broken = new Proxy(db, {
			get(target, property) {
				if (property === "transaction") {
					return async () => {
						throw new Error("simulated database failure");
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as typeof db;
		const route = new Elysia().use(
			ackRoutes(broken, { keyPrefix: "ack:broken:" }),
		);

		const started = performance.now();
		const response = await route.handle(ackRequest("anything"));
		const elapsed = performance.now() - started;

		await expectRejected(response);
		expect(elapsed).toBeGreaterThanOrEqual(REJECT_FLOOR_MS - 5);
	});

	test("every rejection class returns an identical status and body", async () => {
		const consumed = await mintCapability(
			await seedReminder("ak-r10a", MEMBER),
			MEMBER,
		);
		await postAck(consumed);
		const expired = await mintCapability(
			await seedReminder("ak-r10b", MEMBER, { taskId: OTHER_TASK }),
			MEMBER,
			{ expiresAt: new Date(Date.now() - 1_000) },
		);
		const misbound = await mintCapability(
			await seedReminder("ak-r10c", OWNER),
			VIEWER,
		);
		const wrongAction = await mintCapability(
			await seedReminder("ak-r10d", MEMBER, { occurrenceAt: new Date(1) }),
			MEMBER,
			{ action: "snooze" },
		);

		const responses = await Promise.all(
			["garbage", consumed, expired, misbound, wrongAction].map((token) =>
				postAck(token),
			),
		);
		const shapes = await Promise.all(
			responses.map(async (r) => `${r.status}:${await r.text()}`),
		);
		expect(new Set(shapes).size).toBe(1);
		expect(shapes[0]).toBe(`${ACK_REJECT_STATUS}:${ACK_REJECT_BODY}`);
	});

	// C26: a garbage token returns after one indexed lookup; a mis-bound one
	// after a consume, two reads and a rollback. Without a fixed time floor that
	// gap is a working oracle for "this token was real".
	test("rejection timing does not separate rejection classes", async () => {
		const SAMPLES = 5;
		const timeOne = async (token: string) => {
			const started = performance.now();
			await postAck(token);
			return performance.now() - started;
		};

		const garbage: number[] = [];
		const misbound: number[] = [];
		for (let i = 0; i < SAMPLES; i += 1) {
			garbage.push(await timeOne(`garbage-${i}`));
			const token = await mintCapability(
				await seedReminder(`ak-r11-${i}`, OWNER, {
					occurrenceAt: new Date(2_000 + i),
				}),
				VIEWER,
			);
			misbound.push(await timeOne(token));
		}

		// The invariant is a floor, not a similarity: every rejection costs at
		// least REJECT_FLOOR_MS regardless of which check failed.
		expect(Math.min(...garbage)).toBeGreaterThanOrEqual(REJECT_FLOOR_MS - 5);
		expect(Math.min(...misbound)).toBeGreaterThanOrEqual(REJECT_FLOOR_MS - 5);
		// ...and the two ranges overlap, so neither class is separable by timing.
		expect(Math.max(...garbage)).toBeGreaterThanOrEqual(Math.min(...misbound));
		expect(Math.max(...misbound)).toBeGreaterThanOrEqual(Math.min(...garbage));
	});

	// A denied completion is not a spent capability: rolling back leaves the
	// token usable once the denial is fixed (re-added to the workspace).
	test("rolls the consume back when the completion path denies the write", async () => {
		const reminderId = await seedReminder("ak-r12", OUTSIDER);
		const token = await mintCapability(reminderId, OUTSIDER);

		await expectRejected(await postAck(token));

		expect((await capabilityFor(token)).consumedAt).toBeNull();
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow(TASK)).done).toBe(false);
	});

	// C22: a viewer fails requireWrite. Left emergent they would consume their
	// capability and receive an indistinguishable rejection forever. The chosen
	// policy is ack-without-completion: the escalation stops, the task is not
	// written.
	test("lets a viewer ack without completing the task", async () => {
		const reminderId = await seedReminder("ak-r13", VIEWER);
		const token = await mintCapability(reminderId, VIEWER);

		expect((await postAck(token)).status).toBe(200);
		expect((await reminderRow(reminderId)).status).toBe("acked");
		expect((await taskRow(TASK)).done).toBe(false);
	});

	test("redeems a token exactly once under concurrency", async () => {
		const reminderId = await seedReminder("ak-r14", MEMBER);
		const token = await mintCapability(reminderId, MEMBER);

		const responses = await Promise.all(
			Array.from({ length: 6 }, () => postAck(token)),
		);
		const ok = responses.filter((r) => r.status === 200);
		expect(ok).toHaveLength(1);
		for (const other of responses.filter((r) => r.status !== 200)) {
			expect(other.status).toBe(ACK_REJECT_STATUS);
		}
		// One completion, not six: karma is awarded once.
		const events = await db
			.select()
			.from(tables.karmaEvent)
			.where(eq(tables.karmaEvent.userId, MEMBER));
		expect(events).toHaveLength(1);
	});
});

// Per IP, not per token: consume-before-validate burns the token on the first
// attempt, so a per-token limit is near-inert.
describe("ack route: rate limiting", () => {
	// Loopback is trusted so x-forwarded-for is honored, which is the only way
	// to present distinct client addresses through `.handle()` (there is no
	// socket, so every request would otherwise resolve to 127.0.0.1).
	const proxied = (options: Partial<AckRouteOptions> = {}) =>
		new Elysia().use(
			ackRoutes(db, {
				capacity: 3,
				refillPerSec: 0,
				keyPrefix: "ack:rl:",
				trustedProxies: parseTrustedProxyCIDRs(["127.0.0.1/32"]),
				...options,
			}),
		);

	const fromIP = (route: ReturnType<typeof proxied>, ip: string, n: number) =>
		route.handle(ackRequest(`garbage-rl-${n}`, { "x-forwarded-for": ip }));

	test("bounds attempts from one client address", async () => {
		const route = proxied();
		const statuses: number[] = [];
		for (let i = 0; i < 5; i += 1) {
			statuses.push((await fromIP(route, "203.0.113.7", i)).status);
		}
		expect(statuses.slice(0, 3)).toEqual([
			ACK_REJECT_STATUS,
			ACK_REJECT_STATUS,
			ACK_REJECT_STATUS,
		]);
		expect(statuses.slice(3)).toEqual([429, 429]);
	});

	// Without this, a bucket keyed on a constant would satisfy the test above.
	test("buckets each client address separately", async () => {
		const route = proxied();
		for (let i = 0; i < 4; i += 1) await fromIP(route, "203.0.113.20", i);
		// The first address is exhausted; a different one still has its own bucket.
		expect((await fromIP(route, "203.0.113.20", 9)).status).toBe(429);
		expect((await fromIP(route, "203.0.113.21", 9)).status).toBe(
			ACK_REJECT_STATUS,
		);

		const keys = (
			await db
				.select()
				.from(tables.rateBucket)
				.where(like(tables.rateBucket.key, "ack:rl:%"))
		).map((row) => row.key);
		expect(keys).toContain("ack:rl:203.0.113.20");
		expect(keys).toContain("ack:rl:203.0.113.21");
	});

	// A routed IPv6 allocation is a /64 per customer; per-/128 keys give one
	// attacker 2^64 buckets and the limit bounds nothing.
	test("collapses an IPv6 client to its /64", async () => {
		const route = proxied();
		for (let i = 0; i < 4; i += 1) {
			await fromIP(route, "2001:db8:1:2::a1", i);
		}
		// A different address inside the same /64 shares the exhausted bucket.
		expect((await fromIP(route, "2001:db8:1:2::ffff", 9)).status).toBe(429);
		// A different /64 does not.
		expect((await fromIP(route, "2001:db8:1:3::a1", 9)).status).toBe(
			ACK_REJECT_STATUS,
		);
	});

	// The bug this replaced: refill was gated behind `tokens > 0`, so a bucket
	// that reached zero could only recover after a full idle window -- a one-hour
	// lockout on the milestone's headline feature after 30 acks.
	test("refills an emptied bucket at the configured rate", async () => {
		const route = proxied({ capacity: 1, refillPerSec: 2 });
		expect((await fromIP(route, "203.0.113.30", 0)).status).toBe(
			ACK_REJECT_STATUS,
		);
		expect((await fromIP(route, "203.0.113.30", 1)).status).toBe(429);

		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect((await fromIP(route, "203.0.113.30", 2)).status).toBe(
			ACK_REJECT_STATUS,
		);
	});

	// The compounding half: writing refilled_at = now() on every accepted request
	// discards the fractional credit, so at a sub-1/s rate the steady-state refill
	// is exactly zero. refilled_at may only advance by the whole tokens credited.
	//
	// Driven through takeRateToken rather than the route: the reject floor pads
	// every HTTP call by 250ms, which is enough slack that a clock reset still
	// looks like a working refill. Asserting on the observable consequence -- the
	// third take succeeds only if the leftover accrual was banked -- is what makes
	// this discriminating.
	test("preserves fractional accrual across requests", async () => {
		const key = "ack:rl:accrual";
		const sleep = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));

		expect(await takeRateToken(db, key, 1, 1)).toBe(true);
		await sleep(1_500);
		// Credits exactly one token, so refilled_at advances by exactly 1s and the
		// remaining ~0.5s stays banked.
		expect(await takeRateToken(db, key, 1, 1)).toBe(true);
		await sleep(700);
		// Only 0.7s of fresh time, but 1.2s since the (correctly advanced)
		// refilled_at. A clock reset here would credit nothing and deny.
		expect(await takeRateToken(db, key, 1, 1)).toBe(true);
	});

	test("treats a long-untouched bucket as full", async () => {
		const key = "ack:rl:203.0.113.50";
		const route = proxied({ capacity: 3, refillPerSec: 0 });
		for (let i = 0; i < 4; i += 1) await fromIP(route, "203.0.113.50", i);
		expect((await fromIP(route, "203.0.113.50", 9)).status).toBe(429);

		// Age the bucket past the idle window (default one hour).
		await db
			.update(tables.rateBucket)
			.set({ refilledAt: new Date(Date.now() - 2 * 3_600_000) })
			.where(eq(tables.rateBucket.key, key));

		expect((await fromIP(route, "203.0.113.50", 9)).status).toBe(
			ACK_REJECT_STATUS,
		);
	});
});

describe("ack capability prune", () => {
	test("deletes expired and consumed rows, keeps live ones", async () => {
		const live = await mintCapability(
			await seedReminder("ak-p1", MEMBER),
			MEMBER,
		);
		const expired = await mintCapability(
			await seedReminder("ak-p2", MEMBER, { taskId: OTHER_TASK }),
			MEMBER,
			{ expiresAt: new Date(Date.now() - 1_000) },
		);
		const consumed = await mintCapability(
			await seedReminder("ak-p3", MEMBER, { occurrenceAt: new Date(5_000) }),
			MEMBER,
			{ consumedAt: new Date() },
		);

		expect(await pruneAckCapabilities(db, 100)).toBe(2);
		expect(await capabilityFor(live)).toBeDefined();
		expect(await capabilityFor(expired)).toBeUndefined();
		expect(await capabilityFor(consumed)).toBeUndefined();
	});

	test("bounds one sweep to the batch size", async () => {
		for (let i = 0; i < 4; i += 1) {
			await mintCapability(
				await seedReminder(`ak-p4-${i}`, MEMBER, {
					occurrenceAt: new Date(10_000 + i),
				}),
				MEMBER,
				{ expiresAt: new Date(Date.now() - 1_000) },
			);
		}
		expect(await pruneAckCapabilities(db, 2)).toBe(2);
		expect(await pruneAckCapabilities(db, 100)).toBe(2);
		expect(await pruneAckCapabilities(db, 100)).toBe(0);
	});
});

// No capability involved: the caller is already authenticated, so the gate is
// simply "this is my reminder row".
describe("in-app reminder.ack mutator", () => {
	test("acks the caller's own reminder and completes the task", async () => {
		const reminderId = await seedReminder("ak-r15", MEMBER);

		await call(mutators.reminder.ack, { id: MEMBER }, { id: reminderId });

		const reminder = await reminderRow(reminderId);
		expect(reminder.status).toBe("acked");
		expect(reminder.ackedVia).toBe("in_app");
		expect((await taskRow(TASK)).done).toBe(true);
	});

	test("refuses another user's reminder row", async () => {
		const reminderId = await seedReminder("ak-r16", OWNER);

		await expect(
			call(mutators.reminder.ack, { id: MEMBER }, { id: reminderId }),
		).rejects.toThrow();
		expect((await reminderRow(reminderId)).status).toBe("pending");
		expect((await taskRow(TASK)).done).toBe(false);
	});

	test("logs a habit occurrence for a habit-kind reminder", async () => {
		const reminderId = await seedReminder("ak-r17", MEMBER, { taskId: HABIT });

		await call(mutators.reminder.ack, { id: MEMBER }, { id: reminderId });

		const logs = await db
			.select()
			.from(tables.habitLog)
			.where(eq(tables.habitLog.habitId, HABIT));
		expect(logs).toHaveLength(1);
		expect(logs[0].date).toBe(LOCAL_DATE);
		expect(logs[0].status).toBe("done");
	});
});

// The AckStore port exists so the two entry points cannot drift. Nothing pins
// that unless the rows they leave are compared directly -- which is how
// nextAttemptAt came to be cleared on one path and not the other.
describe("both ack paths leave the same rows", () => {
	// Fields a reminder_state row carries after an ack, in both directions.
	const ackShape = (row: typeof tables.reminderState.$inferSelect) => ({
		status: row.status,
		ackOutcome: row.ackOutcome,
		nextAttemptAt: row.nextAttemptAt,
		deferredUntil: row.deferredUntil,
		ackedAtSet: row.ackedAt !== null,
	});

	test("identical reminder_state for a task-kind ack", async () => {
		const viaRoute = await seedReminder("ak-par1", MEMBER);
		await postAck(await mintCapability(viaRoute, MEMBER));
		const routeRow = await reminderRow(viaRoute);

		await wipeVolatile();
		const viaMutator = await seedReminder("ak-par2", MEMBER);
		await call(mutators.reminder.ack, { id: MEMBER }, { id: viaMutator });
		const mutatorRow = await reminderRow(viaMutator);

		expect(ackShape(mutatorRow)).toEqual(ackShape(routeRow));
		expect(routeRow.nextAttemptAt).toBeNull();
		expect(routeRow.ackOutcome).toBe("completed");
		// The channel is the one field that legitimately differs.
		expect(routeRow.ackedVia).toBe("capability");
		expect(mutatorRow.ackedVia).toBe("in_app");
	});

	// Ids and wall-clock stamps differ by construction; everything the karma
	// arithmetic and habit-log write decide must not.
	async function karmaAndLogShape() {
		const logs = await db
			.select()
			.from(tables.habitLog)
			.where(eq(tables.habitLog.habitId, HABIT));
		const aggregate = await db
			.select()
			.from(tables.karma)
			.where(eq(tables.karma.userId, MEMBER));
		const events = await db
			.select()
			.from(tables.karmaEvent)
			.where(eq(tables.karmaEvent.userId, MEMBER));
		return {
			logs: logs.map((r) => ({
				habitId: r.habitId,
				date: r.date,
				status: r.status,
				karmaDelta: r.karmaDelta,
				completedAtSet: r.completedAt !== null,
			})),
			karma: aggregate.map((r) => ({ points: r.points, level: r.level })),
			events: events.map((r) => ({
				date: r.date,
				delta: r.delta,
				reason: r.reason,
			})),
		};
	}

	test("identical karma and habit_log for a habit-kind ack", async () => {
		const viaRoute = await seedReminder("ak-par3", MEMBER, { taskId: HABIT });
		await postAck(await mintCapability(viaRoute, MEMBER));
		const routeShape = await karmaAndLogShape();

		await wipeVolatile();
		const viaMutator = await seedReminder("ak-par4", MEMBER, { taskId: HABIT });
		await call(mutators.reminder.ack, { id: MEMBER }, { id: viaMutator });

		expect(await karmaAndLogShape()).toEqual(routeShape);
		expect(routeShape.logs).toHaveLength(1);
		expect(routeShape.events).toHaveLength(1);
		expect(routeShape.karma[0].points).toBeGreaterThan(0);
	});

	// The viewer decision is only defensible if it is observable afterwards:
	// "reminder silenced, task untouched" must be distinguishable from
	// "reminder acked, task done" during a missed-medication review.
	test("records ack_only when a viewer acks without completing", async () => {
		const viaRoute = await seedReminder("ak-par5", VIEWER);
		await postAck(await mintCapability(viaRoute, VIEWER));
		expect((await reminderRow(viaRoute)).ackOutcome).toBe("ack_only");

		const viaMutator = await seedReminder("ak-par6", VIEWER, {
			taskId: OTHER_TASK,
		});
		await call(mutators.reminder.ack, { id: VIEWER }, { id: viaMutator });
		expect((await reminderRow(viaMutator)).ackOutcome).toBe("ack_only");
	});

	test("records logged for a habit ack on both paths", async () => {
		const viaRoute = await seedReminder("ak-par7", MEMBER, { taskId: HABIT });
		await postAck(await mintCapability(viaRoute, MEMBER));
		expect((await reminderRow(viaRoute)).ackOutcome).toBe("logged");

		await wipeVolatile();
		const viaMutator = await seedReminder("ak-par8", MEMBER, { taskId: HABIT });
		await call(mutators.reminder.ack, { id: MEMBER }, { id: viaMutator });
		expect((await reminderRow(viaMutator)).ackOutcome).toBe("logged");
	});
});
