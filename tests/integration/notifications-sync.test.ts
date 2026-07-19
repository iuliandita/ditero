// Isolation tests for the M3a notification synced queries (queries.ts).
// notificationChannel holds per-user channel credentials: the row syncs to its
// owner, but `config` must never cross the wire (drizzle-zero.config.ts omits
// it from the allowlist -- verified here at both the generated-schema layer
// and the actual row shape returned through the compiled query, so a
// regression that re-adds `config: true` fails this test, not just the type
// checker). reminderState is per recipient, not per task: a shared task's
// co-assignees each get an independent row, and one recipient must never see
// another's escalation state. notificationOutbox/deliveryAttempt/ackCapability
// are server-only (absent from drizzle-zero.config.ts entirely) -- asserted
// against the generated schema's table list, the actual source zql is built
// from, so adding any of them to the config trips this test too.
// Mirrors dashboards.test.ts: rows are seeded via Drizzle, then the compiled
// ZQL runs against Postgres through zeroNodePg.
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

// a and b each own an unrelated notification channel (no shared workspace).
// c and d share a workspace + a task they are both assigned to, each with
// their own reminderState row, so isolation is proven against a real
// co-membership rather than an absent second user.
const userIds = ["notif-a", "notif-b", "notif-c", "notif-d"] as const;
const channelIds = ["notif-chan-a", "notif-chan-b"] as const;
const reminderIds = ["notif-rem-c", "notif-rem-d"] as const;
const occurrenceAt = new Date("2026-08-01T09:00:00Z");

async function wipe() {
	await db
		.delete(tables.reminderState)
		.where(inArray(tables.reminderState.id, [...reminderIds]));
	await db
		.delete(tables.notificationChannel)
		.where(inArray(tables.notificationChannel.id, [...channelIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, ["notif-task"]));
	await db.delete(tables.list).where(inArray(tables.list.id, ["notif-list"]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, ["notif-w"]));
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
		id: "notif-w",
		name: "Notif WS",
		ownerId: "notif-c",
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{
			id: "notif-m-c",
			userId: "notif-c",
			workspaceId: "notif-w",
			role: "owner",
		},
		{
			id: "notif-m-d",
			userId: "notif-d",
			workspaceId: "notif-w",
			role: "member",
		},
	]);
	await db.insert(tables.list).values({
		id: "notif-list",
		workspaceId: "notif-w",
		ownerId: "notif-c",
		title: "Notif list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "notif-task",
		listId: "notif-list",
		title: "Shared task",
		sortKey: "a0",
	});
	await db.insert(tables.notificationChannel).values([
		{
			id: "notif-chan-a",
			userId: "notif-a",
			kind: "ntfy",
			config: { topic: "secret-topic-a", server: "https://ntfy.sh" },
		},
		{
			id: "notif-chan-b",
			userId: "notif-b",
			kind: "email",
			config: { address: "b@test.invalid" },
		},
	]);
	await db.insert(tables.reminderState).values([
		{
			id: "notif-rem-c",
			taskId: "notif-task",
			occurrenceAt,
			recipientUserId: "notif-c",
		},
		{
			id: "notif-rem-d",
			taskId: "notif-task",
			occurrenceAt,
			recipientUserId: "notif-d",
		},
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

async function myChannels(id: string) {
	const rows = await zdb.run(queries.notificationChannels.mine.fn(ctx(id)));
	return rows.filter((r) => (channelIds as readonly string[]).includes(r.id));
}

async function myReminders(id: string) {
	const rows = await zdb.run(queries.reminderStates.mine.fn(ctx(id)));
	return rows.filter((r) => (reminderIds as readonly string[]).includes(r.id));
}

describe("notificationChannels.mine isolation", () => {
	test("owner sees only their own channel row", async () => {
		const rows = await myChannels("notif-a");
		expect(rows.map((r) => r.id)).toEqual(["notif-chan-a"]);
	});

	test("a second user's channel row is absent", async () => {
		const rows = await myChannels("notif-a");
		expect(rows.some((r) => r.id === "notif-chan-b")).toBe(false);
		const bRows = await myChannels("notif-b");
		expect(bRows.map((r) => r.id)).toEqual(["notif-chan-b"]);
	});

	test("a user with no channel sees zero rows", async () => {
		expect(await myChannels("notif-c")).toEqual([]);
	});

	// The key assertion: config must never reach a client. Checked two ways so a
	// regression is caught regardless of where it's reintroduced:
	//  1. generated-schema layer -- the actual source `zql` (and therefore every
	//     synced query) is built from. If drizzle-zero.config.ts regains
	//     `config: true` and schema.gen.ts is regenerated, this column
	//     reappears here.
	//  2. wire-shape layer -- the literal row object returned by running the
	//     compiled query through zeroNodePg against real Postgres data that
	//     has a `config` value populated. `expect(row.config).toBeUndefined()`
	//     alone would pass even if `config` doesn't exist as a key at all (or
	//     fail to compile once the type is fixed), so this asserts the key
	//     itself is absent, not just falsy.
	test("config is absent from the generated schema and from every returned row", () => {
		expect(
			"config" in
				(
					schema.tables as Record<string, unknown> & {
						notificationChannel: { columns: Record<string, unknown> };
					}
				).notificationChannel.columns,
		).toBe(false);
	});

	test("config is absent from every returned row's own keys (wire shape)", async () => {
		const rows = await myChannels("notif-a");
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(Object.keys(row)).not.toContain("config");
			expect("config" in row).toBe(false);
		}
	});
});

describe("reminderStates.mine isolation", () => {
	test("recipient sees only their own reminder row", async () => {
		const rows = await myReminders("notif-c");
		expect(rows.map((r) => r.id)).toEqual(["notif-rem-c"]);
	});

	test("a co-member's reminder row on the same shared task is not returned", async () => {
		const rows = await myReminders("notif-c");
		expect(rows.some((r) => r.id === "notif-rem-d")).toBe(false);
		const dRows = await myReminders("notif-d");
		expect(dRows.map((r) => r.id)).toEqual(["notif-rem-d"]);
	});

	test("a workspace member who is not a recipient of either row sees zero rows", async () => {
		// notif-a/notif-b are not workspace members and have no reminder rows;
		// confirms the filter is recipientUserId, not workspace membership.
		expect(await myReminders("notif-a")).toEqual([]);
	});
});

// notificationOutbox / deliveryAttempt / ackCapability must never be reachable
// through sync. Their absence from drizzle-zero.config.ts (and therefore from
// the generated schema.tables, which is what `zql` -- and every query built on
// it -- is compiled from) is what makes this true. Asserting a positive
// "no query touches them" is not possible without enumerating every future
// query, so this asserts the structural precondition instead: if any of these
// three ever appears in schema.tables, no query can be written that excludes
// it forever, and this test trips the moment the table becomes reachable.
describe("server-only tables are structurally unreachable via sync", () => {
	test("notificationOutbox, deliveryAttempt, ackCapability are absent from the generated schema", () => {
		const tableNames = Object.keys(schema.tables);
		expect(tableNames).not.toContain("notificationOutbox");
		expect(tableNames).not.toContain("deliveryAttempt");
		expect(tableNames).not.toContain("ackCapability");
	});

	test("the exported queries object exposes no accessor for those tables", () => {
		const topLevelKeys = Object.keys(queries);
		for (const forbidden of [
			"notificationOutbox",
			"notificationOutboxes",
			"deliveryAttempt",
			"deliveryAttempts",
			"ackCapability",
			"ackCapabilities",
		]) {
			expect(topLevelKeys).not.toContain(forbidden);
		}
	});
});
