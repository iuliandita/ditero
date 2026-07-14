// Schema round-trip for the M1c view / user_pref tables (migration 0007).
// Asserts JSONB columns persist, column defaults apply on omit, and a personal
// view (null workspaceId) is accepted. Read/write authorization is a later task.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

// Scope cleanup to this file's own rows: sibling files share the DB (tests run
// non-parallel but without per-file reset) and leave workspaces/users with lists,
// so a blanket delete would violate their FKs.
async function wipe() {
	await db.delete(tables.view).where(eq(tables.view.ownerId, "view-user"));
	await db.delete(tables.userPref).where(eq(tables.userPref.id, "view-user"));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, "view-ws"));
	await db.delete(tables.user).where(eq(tables.user.id, "view-user"));
}

beforeAll(async () => {
	await wipe();
	await db.insert(tables.user).values({
		id: "view-user",
		name: "View User",
		email: "view-user@test.invalid",
	});
	await db.insert(tables.workspace).values({
		id: "view-ws",
		name: "View WS",
		ownerId: "view-user",
		kind: "shared",
	});
});

afterAll(async () => {
	// Sibling files predate these tables and only clean user/workspace; leftover
	// view rows (workspaceId has no cascade) would break their FK-ordered deletes.
	await wipe();
	await pool.end();
});

describe("view / user_pref schema", () => {
	test("personal view: null workspaceId + JSONB round-trip", async () => {
		const filter = { op: "and", rules: [{ field: "due", value: "today" }] };
		const display = { layout: "list", groupBy: "list", sort: "manual" };
		await db.insert(tables.view).values({
			id: "view-personal",
			ownerId: "view-user",
			name: "Today",
			filter,
			display,
			sortKey: "a0",
		});
		const rows = await db
			.select()
			.from(tables.view)
			.where(eq(tables.view.id, "view-personal"));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.workspaceId).toBeNull();
		expect(row?.scope).toBe("personal");
		expect(row?.filter).toEqual(filter);
		expect(row?.display).toEqual(display);
	});

	test("workspace-scoped view: workspaceId FK accepted", async () => {
		await db.insert(tables.view).values({
			id: "view-shared",
			ownerId: "view-user",
			workspaceId: "view-ws",
			name: "Team",
			scope: "workspace",
			filter: {},
			display: {},
			sortKey: "a1",
		});
		const rows = await db
			.select()
			.from(tables.view)
			.where(eq(tables.view.id, "view-shared"));
		expect(rows[0]?.workspaceId).toBe("view-ws");
		expect(rows[0]?.scope).toBe("workspace");
	});

	test("user_pref: keymap/pinnedViews/keymapProfile defaults on omit", async () => {
		await db.insert(tables.userPref).values({ id: "view-user" });
		const rows = await db
			.select()
			.from(tables.userPref)
			.where(eq(tables.userPref.id, "view-user"));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.keymap).toEqual({});
		expect(row?.pinnedViews).toEqual([]);
		expect(row?.keymapProfile).toBe("default");
		expect(row?.homeViewRef).toBeNull();
	});

	test("user_pref: JSONB keymap/pinnedViews round-trip", async () => {
		const keymap = { "task.create": ["c"], "view.today": ["g", "t"] };
		const pinnedViews = ["today", "view-personal"];
		await db
			.update(tables.userPref)
			.set({ keymap, pinnedViews, keymapProfile: "vim", homeViewRef: "today" })
			.where(eq(tables.userPref.id, "view-user"));
		const rows = await db
			.select()
			.from(tables.userPref)
			.where(eq(tables.userPref.id, "view-user"));
		expect(rows[0]?.keymap).toEqual(keymap);
		expect(rows[0]?.pinnedViews).toEqual(pinnedViews);
		expect(rows[0]?.keymapProfile).toBe("vim");
		expect(rows[0]?.homeViewRef).toBe("today");
	});
});
