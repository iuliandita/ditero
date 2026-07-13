// Isolation tests for the M1c view / user_pref read queries (queries.ts). These
// synced queries are the read-permission boundary: zero-cache only syncs rows
// they return, so a gap leaks other users' saved views or prefs. Assertions are
// the spec -- keep them strict. Mirrors sharing.test.ts: rows are seeded via
// Drizzle, then the compiled ZQL is run against Postgres through zeroNodePg.
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

// a owns the personal + workspace views and is a member of w; c is a co-member
// of w (sees the workspace view, not the personal one); b is in no workspace.
const userIds = ["viz-a", "viz-b", "viz-c"] as const;
const viewIds = ["viz-view-personal", "viz-view-ws"] as const;

// Scope cleanup to this file's own rows: sibling files share the DB (tests run
// non-parallel but without per-file reset) and leave workspaces/users with lists,
// so a blanket delete would violate their FKs. FK order: view -> userPref ->
// membership -> workspace -> user.
async function wipe() {
	await db
		.delete(tables.view)
		.where(inArray(tables.view.ownerId, [...userIds]));
	await db
		.delete(tables.userPref)
		.where(inArray(tables.userPref.id, [...userIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, ["viz-w"]));
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
		id: "viz-w",
		name: "Views WS",
		ownerId: "viz-a",
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{ id: "viz-m-a", userId: "viz-a", workspaceId: "viz-w", role: "owner" },
		{ id: "viz-m-c", userId: "viz-c", workspaceId: "viz-w", role: "member" },
	]);
	await db.insert(tables.view).values([
		{
			id: "viz-view-personal",
			ownerId: "viz-a",
			name: "A private",
			scope: "personal",
			filter: {},
			display: {},
			sortKey: "a0",
		},
		{
			id: "viz-view-ws",
			ownerId: "viz-a",
			workspaceId: "viz-w",
			name: "Team view",
			scope: "workspace",
			filter: {},
			display: {},
			sortKey: "a1",
		},
	]);
	await db.insert(tables.userPref).values([
		{ id: "viz-a", homeViewRef: "viz-view-personal" },
		{ id: "viz-b", homeViewRef: "today" },
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

// Only assert over this file's own view ids: sibling files seed their own view
// rows, so filter the synced set down before comparing.
async function myViewIds(id: string) {
	const rows = await zdb.run(queries.views.mine.fn(ctx(id)));
	return rows
		.map((r) => r.id)
		.filter((vid) => (viewIds as readonly string[]).includes(vid))
		.sort();
}

describe("view read-permission isolation", () => {
	test("owner A sees own personal view + workspace view", async () => {
		expect(await myViewIds("viz-a")).toEqual([
			"viz-view-personal",
			"viz-view-ws",
		]);
	});

	test("non-member B sees neither view", async () => {
		expect(await myViewIds("viz-b")).toEqual([]);
	});

	test("co-member C sees the workspace view but not A's personal view", async () => {
		expect(await myViewIds("viz-c")).toEqual(["viz-view-ws"]);
	});
});

describe("user_pref read-permission isolation", () => {
	test("A reads only A's pref row", async () => {
		const rows = await zdb.run(queries.userPrefs.mine.fn(ctx("viz-a")));
		expect(rows.map((r) => r.id)).toEqual(["viz-a"]);
	});

	test("B reads only B's pref row, never A's", async () => {
		const rows = await zdb.run(queries.userPrefs.mine.fn(ctx("viz-b")));
		expect(rows.map((r) => r.id)).toEqual(["viz-b"]);
	});
});
