// Schema checks for the M-dash dashboard table (migration 0011).
// Asserts column types/defaults/NOT NULLs via information_schema, JSONB
// round-trip, and FK behaviors (owner cascade, workspace no-cascade).
// Read/write authorization is a later task.
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
// non-parallel but without per-file reset), so a blanket delete would violate
// their FKs.
async function wipe() {
	await db
		.delete(tables.dashboard)
		.where(eq(tables.dashboard.ownerId, "dash-user"));
	await db.delete(tables.workspace).where(eq(tables.workspace.id, "dash-ws"));
	await db.delete(tables.user).where(eq(tables.user.id, "dash-user"));
}

beforeAll(async () => {
	await wipe();
	await db.insert(tables.user).values({
		id: "dash-user",
		name: "Dash User",
		email: "dash-user@test.invalid",
	});
	await db.insert(tables.workspace).values({
		id: "dash-ws",
		name: "Dash WS",
		ownerId: "dash-user",
		kind: "shared",
	});
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("dashboard schema", () => {
	test("dashboard_scope enum exists with expected values", async () => {
		const { rows } = await pool.query(
			`SELECT e.enumlabel FROM pg_type t
			 JOIN pg_enum e ON e.enumtypid = t.oid
			 WHERE t.typname = 'dashboard_scope' ORDER BY e.enumsortorder`,
		);
		expect(rows.map((r) => r.enumlabel)).toEqual(["personal", "workspace"]);
	});

	test("columns: types, NOT NULLs, defaults", async () => {
		const { rows } = await pool.query(
			`SELECT column_name, data_type, is_nullable, column_default
			 FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = 'dashboard'`,
		);
		const cols = new Map(rows.map((r) => [r.column_name, r]));
		expect(cols.size).toBe(10);
		const expectType = (name: string, type: string, nullable: boolean) => {
			const col = cols.get(name);
			expect(col?.data_type, name).toBe(type);
			expect(col?.is_nullable, name).toBe(nullable ? "YES" : "NO");
		};
		expectType("id", "text", false);
		expectType("owner_id", "text", false);
		expectType("workspace_id", "text", true);
		expectType("scope", "USER-DEFINED", false);
		expectType("name", "text", false);
		expectType("icon", "text", true);
		expectType("panels", "jsonb", false);
		expectType("sort_key", "text", false);
		expectType("created_at", "timestamp with time zone", false);
		expectType("updated_at", "timestamp with time zone", false);
		expect(cols.get("scope")?.column_default).toContain("'personal'");
		expect(cols.get("panels")?.column_default).toContain("'[]'");
		expect(cols.get("created_at")?.column_default).toContain("now()");
		expect(cols.get("updated_at")?.column_default).toContain("now()");
	});

	test("personal dashboard: null workspaceId, defaults on omit, JSONB round-trip", async () => {
		await db.insert(tables.dashboard).values({
			id: "dash-personal",
			ownerId: "dash-user",
			name: "Home",
			sortKey: "a0",
		});
		const rows = await db
			.select()
			.from(tables.dashboard)
			.where(eq(tables.dashboard.id, "dash-personal"));
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.workspaceId).toBeNull();
		expect(row?.scope).toBe("personal");
		expect(row?.icon).toBeNull();
		expect(row?.panels).toEqual([]);
		expect(row?.createdAt).toBeInstanceOf(Date);
		expect(row?.updatedAt).toBeInstanceOf(Date);

		const panels = [{ id: "p1", kind: "tasks", w: 2, h: 1 }];
		await db
			.update(tables.dashboard)
			.set({ panels })
			.where(eq(tables.dashboard.id, "dash-personal"));
		const updated = await db
			.select()
			.from(tables.dashboard)
			.where(eq(tables.dashboard.id, "dash-personal"));
		expect(updated[0]?.panels).toEqual(panels);
	});

	test("workspace-scoped dashboard: workspaceId FK accepted", async () => {
		await db.insert(tables.dashboard).values({
			id: "dash-shared",
			ownerId: "dash-user",
			workspaceId: "dash-ws",
			scope: "workspace",
			name: "Team",
			panels: [],
			sortKey: "a1",
		});
		const rows = await db
			.select()
			.from(tables.dashboard)
			.where(eq(tables.dashboard.id, "dash-shared"));
		expect(rows[0]?.workspaceId).toBe("dash-ws");
		expect(rows[0]?.scope).toBe("workspace");
	});

	test("workspace FK has no cascade: delete of referenced workspace is rejected", async () => {
		// Drizzle wraps the pg error; the FK violation (23503) lives in cause.
		const err = await db
			.delete(tables.workspace)
			.where(eq(tables.workspace.id, "dash-ws"))
			.then(() => null)
			.catch((e: unknown) => e as Error);
		expect(err).not.toBeNull();
		const cause = err?.cause as { code?: string; constraint?: string };
		expect(cause?.code).toBe("23503");
		expect(cause?.constraint).toBe("dashboard_workspace_id_workspace_id_fk");
	});

	test("owner FK cascades: deleting the user removes their dashboards", async () => {
		// Detach the workspace-scoped row first: workspace.owner_id (no cascade)
		// blocks the user delete while dash-ws exists.
		await db
			.delete(tables.dashboard)
			.where(eq(tables.dashboard.id, "dash-shared"));
		await db.delete(tables.workspace).where(eq(tables.workspace.id, "dash-ws"));
		await db.delete(tables.user).where(eq(tables.user.id, "dash-user"));
		const rows = await db
			.select()
			.from(tables.dashboard)
			.where(eq(tables.dashboard.ownerId, "dash-user"));
		expect(rows).toHaveLength(0);
	});
});
