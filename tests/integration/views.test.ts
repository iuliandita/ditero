// Isolation tests for the M1c view / user_pref read queries (queries.ts). These
// synced queries are the read-permission boundary: zero-cache only syncs rows
// they return, so a gap leaks other users' saved views or prefs. Assertions are
// the spec -- keep them strict. Mirrors sharing.test.ts: rows are seeded via
// Drizzle, then the compiled ZQL is run against Postgres through zeroNodePg.
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { type Schema, schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

// a owns the personal + workspace views and is w's owner; c is a plain member
// (sees the workspace view, not the personal one); d is admin, e is viewer, b is
// in no workspace. d/e/viewer exist for the workspace-view write-auth matrix.
const userIds = ["viz-a", "viz-b", "viz-c", "viz-d", "viz-e"] as const;
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
		{ id: "viz-m-d", userId: "viz-d", workspaceId: "viz-w", role: "admin" },
		{ id: "viz-m-e", userId: "viz-e", workspaceId: "viz-w", role: "viewer" },
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

// Write-permission boundary: run each mutator via a real Zero tx (server path)
// so the role lookup hits Postgres. Mirrors sharing.test.ts's `call` helper.
type MutCtx = { id: string };
async function call<A>(
	mutator: {
		fn: (a: { tx: Transaction<Schema>; ctx: MutCtx; args: A }) => Promise<void>;
	},
	c: MutCtx,
	args: A,
) {
	return zdb.transaction((tx) => mutator.fn({ tx, ctx: c, args }));
}

describe("view write-permission mutators", () => {
	test("non-member cannot create a workspace-scoped view", async () => {
		await expect(
			call(
				mutators.view.create,
				{ id: "viz-b" },
				{
					id: "viz-view-deny",
					name: "nope",
					scope: "workspace" as const,
					workspaceId: "viz-w",
					filter: {},
					display: {},
					sortKey: "z0",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("create scope=personal with a workspaceId is rejected", async () => {
		await expect(
			call(
				mutators.view.create,
				{ id: "viz-a" },
				{
					id: "viz-view-bad1",
					name: "bad",
					scope: "personal" as const,
					workspaceId: "viz-w",
					filter: {},
					display: {},
					sortKey: "z1",
				},
			),
		).rejects.toThrow(/personal view must not set workspaceId/);
	});

	test("create scope=workspace with null workspaceId is rejected", async () => {
		await expect(
			call(
				mutators.view.create,
				{ id: "viz-a" },
				{
					id: "viz-view-bad2",
					name: "bad",
					scope: "workspace" as const,
					workspaceId: null,
					filter: {},
					display: {},
					sortKey: "z2",
				},
			),
		).rejects.toThrow(/workspace view needs workspaceId/);
	});

	test("owner can create/update/reorder a personal view; others cannot; owner can delete", async () => {
		await call(
			mutators.view.create,
			{ id: "viz-a" },
			{
				id: "viz-view-p2",
				name: "P2",
				scope: "personal" as const,
				workspaceId: null,
				filter: {},
				display: {},
				sortKey: "a5",
			},
		);
		let row = (
			await db
				.select()
				.from(tables.view)
				.where(eq(tables.view.id, "viz-view-p2"))
		)[0];
		expect(row?.ownerId).toBe("viz-a");
		expect(row?.workspaceId).toBeNull();

		await call(
			mutators.view.update,
			{ id: "viz-a" },
			{
				id: "viz-view-p2",
				name: "P2 renamed",
			},
		);
		await call(
			mutators.view.reorder,
			{ id: "viz-a" },
			{
				id: "viz-view-p2",
				sortKey: "a6",
			},
		);
		row = (
			await db
				.select()
				.from(tables.view)
				.where(eq(tables.view.id, "viz-view-p2"))
		)[0];
		expect(row?.name).toBe("P2 renamed");
		expect(row?.sortKey).toBe("a6");

		// A different user cannot touch A's personal view.
		await expect(
			call(
				mutators.view.update,
				{ id: "viz-b" },
				{
					id: "viz-view-p2",
					name: "hijack",
				},
			),
		).rejects.toThrow(/access denied/);
		await expect(
			call(mutators.view.delete, { id: "viz-b" }, { id: "viz-view-p2" }),
		).rejects.toThrow(/access denied/);

		await call(mutators.view.delete, { id: "viz-a" }, { id: "viz-view-p2" });
		expect(
			await db
				.select()
				.from(tables.view)
				.where(eq(tables.view.id, "viz-view-p2")),
		).toEqual([]);
	});
});

// Workspace-scoped views route through requireWrite / the creator-or-admin
// delete gate -- the most complex auth in this mutator group. Roles seeded on
// viz-w: viz-a owner, viz-d admin, viz-c member, viz-e viewer, viz-b non-member.
async function viewRow(id: string) {
	return (await db.select().from(tables.view).where(eq(tables.view.id, id)))[0];
}

describe("workspace-view write-permission mutators", () => {
	test("member can create a workspace view in their workspace", async () => {
		await call(
			mutators.view.create,
			{ id: "viz-c" },
			{
				id: "viz-view-c1",
				name: "C team view",
				scope: "workspace" as const,
				workspaceId: "viz-w",
				filter: {},
				display: {},
				sortKey: "c0",
			},
		);
		const row = await viewRow("viz-view-c1");
		expect(row?.scope).toBe("workspace");
		expect(row?.workspaceId).toBe("viz-w");
		expect(row?.ownerId).toBe("viz-c");
	});

	test("member can update + reorder a workspace view (requireWrite path)", async () => {
		await call(
			mutators.view.update,
			{ id: "viz-c" },
			{ id: "viz-view-c1", name: "C renamed" },
		);
		await call(
			mutators.view.reorder,
			{ id: "viz-c" },
			{ id: "viz-view-c1", sortKey: "c1" },
		);
		const row = await viewRow("viz-view-c1");
		expect(row?.name).toBe("C renamed");
		expect(row?.sortKey).toBe("c1");
	});

	test("viewer cannot update/reorder/delete a workspace view", async () => {
		await expect(
			call(
				mutators.view.update,
				{ id: "viz-e" },
				{ id: "viz-view-c1", name: "hijack" },
			),
		).rejects.toThrow(/access denied/);
		await expect(
			call(
				mutators.view.reorder,
				{ id: "viz-e" },
				{ id: "viz-view-c1", sortKey: "z9" },
			),
		).rejects.toThrow(/access denied/);
		await expect(
			call(mutators.view.delete, { id: "viz-e" }, { id: "viz-view-c1" }),
		).rejects.toThrow(/access denied/);
	});

	test("member can delete their own workspace view", async () => {
		await call(
			mutators.view.create,
			{ id: "viz-c" },
			{
				id: "viz-view-cown",
				name: "C own",
				scope: "workspace" as const,
				workspaceId: "viz-w",
				filter: {},
				display: {},
				sortKey: "c2",
			},
		);
		await call(mutators.view.delete, { id: "viz-c" }, { id: "viz-view-cown" });
		expect(await viewRow("viz-view-cown")).toBeUndefined();
	});

	test("member cannot delete another member's workspace view; admin can", async () => {
		// A workspace view owned by viz-a (workspace owner).
		await call(
			mutators.view.create,
			{ id: "viz-a" },
			{
				id: "viz-view-adel",
				name: "A team view",
				scope: "workspace" as const,
				workspaceId: "viz-w",
				filter: {},
				display: {},
				sortKey: "c3",
			},
		);
		// Plain member (non-owner, non-admin) is denied.
		await expect(
			call(mutators.view.delete, { id: "viz-c" }, { id: "viz-view-adel" }),
		).rejects.toThrow(/access denied/);
		expect(await viewRow("viz-view-adel")).toBeDefined();
		// Admin may delete another member's workspace view.
		await call(mutators.view.delete, { id: "viz-d" }, { id: "viz-view-adel" });
		expect(await viewRow("viz-view-adel")).toBeUndefined();
	});
});

describe("userPref write-permission mutator", () => {
	test("set inserts a caller-keyed row, then updates it (upsert)", async () => {
		// viz-c has no seeded pref row -> insert path.
		await call(
			mutators.userPref.set,
			{ id: "viz-c" },
			{
				keymapProfile: "vim" as const,
				homeViewRef: "viz-view-ws",
			},
		);
		let row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-c"))
		)[0];
		expect(row?.id).toBe("viz-c");
		expect(row?.keymapProfile).toBe("vim");
		expect(row?.homeViewRef).toBe("viz-view-ws");

		// Second set -> update path, same row.
		await call(
			mutators.userPref.set,
			{ id: "viz-c" },
			{
				pinnedViews: ["viz-view-ws"],
			},
		);
		row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-c"))
		)[0];
		expect(row?.pinnedViews).toEqual(["viz-view-ws"]);
		expect(row?.keymapProfile).toBe("vim");
	});

	test("a user's set only writes their own row (isolation)", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-a" },
			{
				homeViewRef: "a-choice",
			},
		);
		await call(
			mutators.userPref.set,
			{ id: "viz-b" },
			{
				homeViewRef: "b-choice",
			},
		);
		const a = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-a"))
		)[0];
		const b = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-b"))
		)[0];
		expect(a?.homeViewRef).toBe("a-choice");
		expect(b?.homeViewRef).toBe("b-choice");
	});
});
