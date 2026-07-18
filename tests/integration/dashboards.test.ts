// Isolation tests for the M-dash dashboard read query (queries.ts) plus the
// dashboard.* mutator (write-permission) half. The synced query is the
// read-permission boundary: zero-cache only syncs rows it returns, so a gap
// leaks other users' dashboards. Assertions are the spec -- keep them strict.
// Mirrors views.test.ts: rows are seeded via Drizzle, then the compiled ZQL /
// mutators run against Postgres through zeroNodePg.
import type { ReadonlyJSONValue, Transaction } from "@rocicorp/zero";
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

// a owns the personal + workspace dashboards and is w's owner; c is a plain
// member (sees the workspace dashboard, not the personal one); b is in no
// workspace. d (admin) and e (viewer) exist for the write-auth matrix.
const userIds = ["dash-a", "dash-b", "dash-c", "dash-d", "dash-e"] as const;
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
		{ id: "dash-m-d", userId: "dash-d", workspaceId: "dash-w", role: "admin" },
		{ id: "dash-m-e", userId: "dash-e", workspaceId: "dash-w", role: "viewer" },
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

// Write-permission boundary: run each mutator via a real Zero tx (server path)
// so the role lookup hits Postgres. Mirrors views.test.ts's `call` helper.
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

async function dashRow(id: string) {
	return (
		await db.select().from(tables.dashboard).where(eq(tables.dashboard.id, id))
	)[0];
}

// dashboard.create validates panels against the domain panelsSchema, so mutator
// calls must pass a well-formed (if trivial) panel list. Typed as
// ReadonlyJSONValue to match the mutator's JSON arg surface.
const OK_PANELS: ReadonlyJSONValue = [
	{ id: "p1", type: "focus", range: "today", size: "m" },
];

const wsCreateArgs = (id: string, sortKey: string) =>
	({
		id,
		name: "WS dash",
		scope: "workspace" as const,
		workspaceId: "dash-w",
		panels: OK_PANELS,
		sortKey,
	}) as const;

describe("dashboard write-permission mutators (workspace scope)", () => {
	test("non-member cannot create a workspace-scoped dashboard", async () => {
		await expect(
			call(
				mutators.dashboard.create,
				{ id: "dash-b" },
				wsCreateArgs("dash-deny-b", "z0"),
			),
		).rejects.toThrow(/access denied/);
		expect(await dashRow("dash-deny-b")).toBeUndefined();
	});

	test("viewer cannot create a workspace-scoped dashboard", async () => {
		await expect(
			call(
				mutators.dashboard.create,
				{ id: "dash-e" },
				wsCreateArgs("dash-deny-e", "z1"),
			),
		).rejects.toThrow(/access denied/);
		expect(await dashRow("dash-deny-e")).toBeUndefined();
	});

	test("owner, admin, and member can create workspace dashboards", async () => {
		await call(
			mutators.dashboard.create,
			{ id: "dash-a" },
			wsCreateArgs("dash-ws-a", "b0"),
		);
		await call(
			mutators.dashboard.create,
			{ id: "dash-d" },
			wsCreateArgs("dash-ws-d", "b1"),
		);
		await call(
			mutators.dashboard.create,
			{ id: "dash-c" },
			wsCreateArgs("dash-ws-c", "b2"),
		);
		const row = await dashRow("dash-ws-c");
		expect(row?.scope).toBe("workspace");
		expect(row?.workspaceId).toBe("dash-w");
		expect(row?.ownerId).toBe("dash-c");
	});

	test("member can update + reorder a workspace dashboard (requireWrite path)", async () => {
		await call(
			mutators.dashboard.update,
			{ id: "dash-c" },
			{ id: "dash-ws-a", name: "renamed by member" },
		);
		await call(
			mutators.dashboard.reorder,
			{ id: "dash-c" },
			{ id: "dash-ws-a", sortKey: "b9" },
		);
		const row = await dashRow("dash-ws-a");
		expect(row?.name).toBe("renamed by member");
		expect(row?.sortKey).toBe("b9");
	});

	test("admin can update + reorder a workspace dashboard", async () => {
		await call(
			mutators.dashboard.update,
			{ id: "dash-d" },
			{ id: "dash-ws-a", name: "renamed by admin" },
		);
		await call(
			mutators.dashboard.reorder,
			{ id: "dash-d" },
			{ id: "dash-ws-a", sortKey: "b8" },
		);
		const row = await dashRow("dash-ws-a");
		expect(row?.name).toBe("renamed by admin");
		expect(row?.sortKey).toBe("b8");
	});

	test("viewer and non-member cannot update/reorder/delete a workspace dashboard", async () => {
		for (const uid of ["dash-e", "dash-b"]) {
			await expect(
				call(
					mutators.dashboard.update,
					{ id: uid },
					{ id: "dash-ws-a", name: "hijack" },
				),
			).rejects.toThrow(/access denied/);
			await expect(
				call(
					mutators.dashboard.reorder,
					{ id: uid },
					{ id: "dash-ws-a", sortKey: "z9" },
				),
			).rejects.toThrow(/access denied/);
			await expect(
				call(mutators.dashboard.delete, { id: uid }, { id: "dash-ws-a" }),
			).rejects.toThrow(/access denied/);
		}
	});

	test("member can delete their own workspace dashboard", async () => {
		await call(
			mutators.dashboard.delete,
			{ id: "dash-c" },
			{ id: "dash-ws-c" },
		);
		expect(await dashRow("dash-ws-c")).toBeUndefined();
	});

	test("member cannot delete another member's workspace dashboard; admin can", async () => {
		// dash-ws-a is owned by dash-a (workspace owner). Plain member denied.
		await expect(
			call(mutators.dashboard.delete, { id: "dash-c" }, { id: "dash-ws-a" }),
		).rejects.toThrow(/access denied/);
		expect(await dashRow("dash-ws-a")).toBeDefined();
		// Admin may delete another member's workspace dashboard.
		await call(
			mutators.dashboard.delete,
			{ id: "dash-d" },
			{ id: "dash-ws-a" },
		);
		expect(await dashRow("dash-ws-a")).toBeUndefined();
		// Cleanup admin's own.
		await call(
			mutators.dashboard.delete,
			{ id: "dash-d" },
			{ id: "dash-ws-d" },
		);
	});
});

describe("dashboard write-permission mutators (personal scope)", () => {
	test("owner can create/update/reorder a personal dashboard; others cannot; owner can delete", async () => {
		await call(
			mutators.dashboard.create,
			{ id: "dash-a" },
			{
				id: "dash-p2",
				name: "P2",
				scope: "personal" as const,
				workspaceId: null,
				panels: OK_PANELS,
				sortKey: "a5",
			},
		);
		let row = await dashRow("dash-p2");
		expect(row?.ownerId).toBe("dash-a");
		expect(row?.workspaceId).toBeNull();

		await call(
			mutators.dashboard.update,
			{ id: "dash-a" },
			{ id: "dash-p2", name: "P2 renamed" },
		);
		await call(
			mutators.dashboard.reorder,
			{ id: "dash-a" },
			{ id: "dash-p2", sortKey: "a6" },
		);
		row = await dashRow("dash-p2");
		expect(row?.name).toBe("P2 renamed");
		expect(row?.sortKey).toBe("a6");

		// A different user (even a co-member) cannot touch A's personal dashboard.
		for (const uid of ["dash-b", "dash-c"]) {
			await expect(
				call(
					mutators.dashboard.update,
					{ id: uid },
					{ id: "dash-p2", name: "hijack" },
				),
			).rejects.toThrow(/access denied/);
			await expect(
				call(
					mutators.dashboard.reorder,
					{ id: uid },
					{ id: "dash-p2", sortKey: "z9" },
				),
			).rejects.toThrow(/access denied/);
			await expect(
				call(mutators.dashboard.delete, { id: uid }, { id: "dash-p2" }),
			).rejects.toThrow(/access denied/);
		}

		await call(mutators.dashboard.delete, { id: "dash-a" }, { id: "dash-p2" });
		expect(await dashRow("dash-p2")).toBeUndefined();
	});
});

describe("dashboard create validation", () => {
	test("create scope=workspace with null workspaceId is rejected", async () => {
		await expect(
			call(
				mutators.dashboard.create,
				{ id: "dash-a" },
				{
					id: "dash-bad1",
					name: "bad",
					scope: "workspace" as const,
					workspaceId: null,
					panels: OK_PANELS,
					sortKey: "z2",
				},
			),
		).rejects.toThrow(/workspace dashboard needs workspaceId/);
		expect(await dashRow("dash-bad1")).toBeUndefined();
	});

	test("create scope=personal with a workspaceId is rejected", async () => {
		await expect(
			call(
				mutators.dashboard.create,
				{ id: "dash-a" },
				{
					id: "dash-bad2",
					name: "bad",
					scope: "personal" as const,
					workspaceId: "dash-w",
					panels: OK_PANELS,
					sortKey: "z3",
				},
			),
		).rejects.toThrow(/personal dashboard must not set workspaceId/);
		expect(await dashRow("dash-bad2")).toBeUndefined();
	});
});

// Server-side panel validation: the mutator validator runs before the fn body,
// so a caller with write access cannot store a malformed panel list that breaks
// or DoSes co-members at render time.
describe("dashboard panel validation", () => {
	const createWithPanels = (id: string, panels: ReadonlyJSONValue) =>
		call(
			mutators.dashboard.create,
			{ id: "dash-a" },
			{
				id,
				name: "bad panels",
				scope: "personal" as const,
				workspaceId: null,
				panels,
				sortKey: "z4",
			},
		);

	test("unknown panel type is rejected", async () => {
		await expect(
			createWithPanels("dash-badp1", [
				{ id: "p1", type: "weather", size: "s" },
			]),
		).rejects.toThrow(/invalid dashboard panels/);
		expect(await dashRow("dash-badp1")).toBeUndefined();
	});

	test("21 panels are rejected (MAX_PANELS cap)", async () => {
		const panels = Array.from({ length: 21 }, (_, i) => ({
			id: `p${i}`,
			type: "focus",
			range: "today",
			size: "s",
		}));
		await expect(createWithPanels("dash-badp2", panels)).rejects.toThrow(
			/invalid dashboard panels/,
		);
		expect(await dashRow("dash-badp2")).toBeUndefined();
	});

	test("duplicate panel ids are rejected", async () => {
		await expect(
			createWithPanels("dash-badp3", [
				{ id: "dup", type: "focus", range: "today", size: "s" },
				{ id: "dup", type: "focus", range: "week", size: "s" },
			]),
		).rejects.toThrow(/invalid dashboard panels/);
		expect(await dashRow("dash-badp3")).toBeUndefined();
	});

	test("over-deep inline filter is rejected", async () => {
		let node: unknown = { op: "and", conditions: [] };
		for (let i = 0; i < 6; i++) node = { op: "and", conditions: [node] };
		await expect(
			createWithPanels("dash-badp4", [
				{
					id: "p1",
					type: "tasks",
					source: {
						kind: "inline",
						filter: node,
						sort: { field: "sortKey", dir: "asc" },
						workspaceScope: { mode: "all" },
					},
					size: "m",
				},
			] as unknown as ReadonlyJSONValue),
		).rejects.toThrow(/invalid dashboard panels/);
		expect(await dashRow("dash-badp4")).toBeUndefined();
	});

	test("update rejects malformed panels too", async () => {
		await expect(
			call(
				mutators.dashboard.update,
				{ id: "dash-a" },
				{
					id: "dash-personal",
					panels: [{ id: "p1", type: "weather", size: "s" }],
				},
			),
		).rejects.toThrow(/invalid dashboard panels/);
	});
});

describe("dashboard scope immutability", () => {
	test("update cannot change scope/workspaceId/ownerId (runtime row equality after a legit update)", async () => {
		const before = await dashRow("dash-ws");
		await call(
			mutators.dashboard.update,
			{ id: "dash-a" },
			{ id: "dash-ws", name: "Team dashboard v2", panels: OK_PANELS },
		);
		const after = await dashRow("dash-ws");
		expect(after?.name).toBe("Team dashboard v2");
		expect(after?.scope).toBe(before?.scope);
		expect(after?.workspaceId).toBe(before?.workspaceId);
		expect(after?.ownerId).toBe(before?.ownerId);
	});
});
