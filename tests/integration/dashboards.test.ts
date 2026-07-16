// Isolation tests for the M-dash dashboard read query (queries.ts). The synced
// query is the read-permission boundary: zero-cache only syncs rows it returns,
// so a gap leaks other users' dashboards. Assertions are the spec -- keep them
// strict. Mirrors views.test.ts: rows are seeded via Drizzle, then the compiled
// ZQL is run against Postgres through zeroNodePg. Task 4 extends this file with
// the mutator (write-permission) half.
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

// a owns the personal + workspace dashboards and is w's owner; c is a plain
// member (sees the workspace dashboard, not the personal one); b is in no
// workspace.
const userIds = ["dash-a", "dash-b", "dash-c"] as const;
const dashboardIds = ["dash-personal", "dash-ws"] as const;

// Scope cleanup to this file's own rows: sibling files share the DB (tests run
// non-parallel but without per-file reset), so a blanket delete would violate
// their FKs. FK order: dashboard -> membership -> workspace -> user.
async function wipe() {
	await db
		.delete(tables.dashboard)
		.where(inArray(tables.dashboard.ownerId, [...userIds]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, ["dash-w"]));
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
		id: "dash-w",
		name: "Dash WS",
		ownerId: "dash-a",
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{ id: "dash-m-a", userId: "dash-a", workspaceId: "dash-w", role: "owner" },
		{ id: "dash-m-c", userId: "dash-c", workspaceId: "dash-w", role: "member" },
	]);
	await db.insert(tables.dashboard).values([
		{
			id: "dash-personal",
			ownerId: "dash-a",
			name: "A private",
			scope: "personal",
			sortKey: "a0",
		},
		{
			id: "dash-ws",
			ownerId: "dash-a",
			workspaceId: "dash-w",
			name: "Team dashboard",
			scope: "workspace",
			sortKey: "a1",
		},
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

// Only assert over this file's own dashboard ids: sibling files may seed their
// own rows, so filter the synced set down before comparing.
async function myDashboardIds(id: string) {
	const rows = await zdb.run(queries.dashboards.mine.fn(ctx(id)));
	return rows
		.map((r) => r.id)
		.filter((did) => (dashboardIds as readonly string[]).includes(did))
		.sort();
}

describe("dashboard read-permission isolation", () => {
	test("owner A sees own personal dashboard + workspace dashboard", async () => {
		expect(await myDashboardIds("dash-a")).toEqual([
			"dash-personal",
			"dash-ws",
		]);
	});

	test("co-member C sees the workspace dashboard but not A's personal one", async () => {
		expect(await myDashboardIds("dash-c")).toEqual(["dash-ws"]);
	});

	test("non-member B sees zero rows", async () => {
		expect(await myDashboardIds("dash-b")).toEqual([]);
	});
});
