// Isolation tests for the M1c view / user_pref read queries (queries.ts). These
// synced queries are the read-permission boundary: zero-cache only syncs rows
// they return, so a gap leaks other users' saved views or prefs. Assertions are
// the spec -- keep them strict. Mirrors sharing.test.ts: rows are seeded via
// Drizzle, then the compiled ZQL is run against Postgres through zeroNodePg.
import type { ReadonlyJSONValue, Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import {
	DEFAULT_MAX_REPEATS,
	resolveEscalationPolicy,
} from "../../src/domain/escalation-policy.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { type Schema, schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

// view.create/update now validate filter/display against the domain schemas, so
// mutator calls must pass a well-formed (if trivial) AST + display. Typed as
// ReadonlyJSONValue to match the mutator's JSON arg surface.
const OK_FILTER: ReadonlyJSONValue = { op: "and", conditions: [] };
const OK_DISPLAY: ReadonlyJSONValue = {
	layout: "list",
	groupBy: "none",
	sort: { field: "sortKey", dir: "asc" },
	workspaceScope: { mode: "all" },
};

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
			filter: OK_FILTER,
			display: OK_DISPLAY,
			sortKey: "a0",
		},
		{
			id: "viz-view-ws",
			ownerId: "viz-a",
			workspaceId: "viz-w",
			name: "Team view",
			scope: "workspace",
			filter: OK_FILTER,
			display: OK_DISPLAY,
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
					filter: OK_FILTER,
					display: OK_DISPLAY,
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
					filter: OK_FILTER,
					display: OK_DISPLAY,
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
					filter: OK_FILTER,
					display: OK_DISPLAY,
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
				filter: OK_FILTER,
				display: OK_DISPLAY,
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
				filter: OK_FILTER,
				display: OK_DISPLAY,
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
				filter: OK_FILTER,
				display: OK_DISPLAY,
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
				filter: OK_FILTER,
				display: OK_DISPLAY,
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

// Server-side AST/display validation (M1c security pass): the mutator validator
// runs before the fn body, so a member with shared-workspace write access cannot
// store a malformed filter that DoSes co-members at read time.
describe("view AST/display validation", () => {
	test("create rejects a malformed filter (unknown field)", async () => {
		await expect(
			call(
				mutators.view.create,
				{ id: "viz-a" },
				{
					id: "viz-view-badast",
					name: "bad ast",
					scope: "personal" as const,
					workspaceId: null,
					filter: {
						op: "and",
						conditions: [{ field: "bogus", operator: "eq", value: 1 }],
					},
					display: OK_DISPLAY,
					sortKey: "z6",
				},
			),
		).rejects.toThrow();
		expect(await viewRow("viz-view-badast")).toBeUndefined();
	});

	test("create rejects an over-deep filter", async () => {
		let node: unknown = { op: "and", conditions: [] };
		for (let i = 0; i < 6; i++) node = { op: "and", conditions: [node] };
		await expect(
			call(
				mutators.view.create,
				{ id: "viz-a" },
				{
					id: "viz-view-deepast",
					name: "deep ast",
					scope: "personal" as const,
					workspaceId: null,
					filter: node as ReadonlyJSONValue,
					display: OK_DISPLAY,
					sortKey: "z5",
				},
			),
		).rejects.toThrow();
		expect(await viewRow("viz-view-deepast")).toBeUndefined();
	});

	test("create accepts a valid non-trivial filter", async () => {
		await call(
			mutators.view.create,
			{ id: "viz-a" },
			{
				id: "viz-view-okast",
				name: "ok ast",
				scope: "personal" as const,
				workspaceId: null,
				filter: {
					op: "and",
					conditions: [{ field: "done", operator: "is", value: true }],
				},
				display: OK_DISPLAY,
				sortKey: "z4",
			},
		);
		expect(await viewRow("viz-view-okast")).toBeDefined();
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

	test("rejects an over-cap pinnedViews / keymap write", async () => {
		await expect(
			call(
				mutators.userPref.set,
				{ id: "viz-c" },
				{ pinnedViews: Array.from({ length: 201 }, (_, i) => `v${i}`) },
			),
		).rejects.toThrow();
		const bigKeymap: Record<string, string[][]> = Object.fromEntries(
			Array.from({ length: 101 }, (_, i) => [`cmd${i}`, [["a"]]]),
		);
		await expect(
			call(mutators.userPref.set, { id: "viz-c" }, { keymap: bigKeymap }),
		).rejects.toThrow();
	});
});

// M3a: timezone/quietHours/escalationDefaults. viz-d has no seeded pref row,
// so its set exercises the insert branch -- the one the original bug missed,
// since it enumerated columns explicitly and never mentioned these three.
describe("userPref write-permission mutator: M3a notification defaults", () => {
	test("a valid IANA timezone is persisted", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-a" },
			{ timezone: "Europe/Bucharest" },
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-a"))
		)[0];
		expect(row?.timezone).toBe("Europe/Bucharest");
	});

	test("an invalid timezone string is rejected", async () => {
		await expect(
			call(
				mutators.userPref.set,
				{ id: "viz-a" },
				{ timezone: "Europe/Bucarest" },
			),
		).rejects.toThrow();
	});

	test("valid quiet hours are persisted", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-a" },
			{ quietHours: { start: "22:00", end: "07:00" } },
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-a"))
		)[0];
		expect(row?.quietHours).toEqual({ start: "22:00", end: "07:00" });
	});

	test("malformed quiet hours are rejected", async () => {
		const bad: ReadonlyJSONValue[] = [
			{ start: "22:00" }, // missing end
			{ start: "24:00", end: "07:00" }, // out-of-range hour
			{ start: "22:60", end: "07:00" }, // out-of-range minute
			{ start: "22:00", end: "07:00", extra: "x" }, // unknown key
		];
		for (const quietHours of bad) {
			await expect(
				call(mutators.userPref.set, { id: "viz-a" }, { quietHours }),
			).rejects.toThrow();
		}
	});

	// S5: a user setting both pickers to the same time means "quiet all day",
	// but the domain reads equal start/end as "never quiet" -- the exact
	// opposite. Rejected at the write path rather than reinterpreted; all-day
	// quiet already has a primitive (disable the channel).
	test("equal quiet-hours start and end is rejected", async () => {
		await expect(
			call(
				mutators.userPref.set,
				{ id: "viz-a" },
				{ quietHours: { start: "22:00", end: "22:00" } },
			),
		).rejects.toThrow();
	});

	// S3: repeatEveryMin without maxRepeats is deliberately ACCEPTED. null means
	// "inherit", and at the user level the resolver's DEFAULT_MAX_REPEATS floor
	// is the terminal answer -- rejecting the pair would forbid "repeat every 10
	// minutes, use the default count".
	test("repeatEveryMin with a null maxRepeats is accepted and inherits the floor", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-c" },
			{
				escalationDefaults: {
					repeatEveryMin: 10,
					maxRepeats: null,
					fallbackUserId: null,
				},
			},
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-c"))
		)[0];
		expect(row?.escalationDefaults).toEqual({
			repeatEveryMin: 10,
			maxRepeats: null,
			fallbackUserId: null,
		});
		expect(
			resolveEscalationPolicy(
				{
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				},
				row?.escalationDefaults,
			).maxRepeats,
		).toBe(DEFAULT_MAX_REPEATS);
	});

	test("valid escalation defaults are persisted", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-c" },
			{
				escalationDefaults: {
					repeatEveryMin: 10,
					maxRepeats: 3,
					fallbackUserId: "viz-a",
				},
			},
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-c"))
		)[0];
		expect(row?.escalationDefaults).toEqual({
			repeatEveryMin: 10,
			maxRepeats: 3,
			fallbackUserId: "viz-a",
		});
	});

	test("repeatEveryMin: 0 and a negative value are rejected", async () => {
		for (const repeatEveryMin of [0, -5]) {
			await expect(
				call(
					mutators.userPref.set,
					{ id: "viz-c" },
					{
						escalationDefaults: {
							repeatEveryMin,
							maxRepeats: 3,
							fallbackUserId: null,
						},
					},
				),
			).rejects.toThrow();
		}
	});

	test("maxRepeats above the cap (20) is rejected", async () => {
		await expect(
			call(
				mutators.userPref.set,
				{ id: "viz-c" },
				{
					escalationDefaults: {
						repeatEveryMin: 1,
						maxRepeats: 32767,
						fallbackUserId: null,
					},
				},
			),
		).rejects.toThrow();
	});

	test("a fallbackUserId with no shared workspace with the caller is rejected", async () => {
		// viz-c (member of viz-w) naming viz-b (in no workspace at all).
		await expect(
			call(
				mutators.userPref.set,
				{ id: "viz-c" },
				{
					escalationDefaults: {
						repeatEveryMin: 5,
						maxRepeats: 2,
						fallbackUserId: "viz-b",
					},
				},
			),
		).rejects.toThrow(/share a workspace/);
	});

	test("a fallbackUserId naming a co-member is accepted", async () => {
		// viz-c and viz-d both belong to viz-w.
		await call(
			mutators.userPref.set,
			{ id: "viz-c" },
			{
				escalationDefaults: {
					repeatEveryMin: 5,
					maxRepeats: 2,
					fallbackUserId: "viz-d",
				},
			},
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-c"))
		)[0];
		expect(
			(row?.escalationDefaults as { fallbackUserId: string | null } | null)
				?.fallbackUserId,
		).toBe("viz-d");
	});

	test("insert branch (no existing pref row) persists timezone/quietHours/escalationDefaults", async () => {
		// viz-d has no seeded row (only viz-a/viz-b are seeded in beforeAll) --
		// this set() call must take the insert path, not the update path.
		const before = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-d"))
		)[0];
		expect(before).toBeUndefined();

		await call(
			mutators.userPref.set,
			{ id: "viz-d" },
			{
				timezone: "Asia/Tokyo",
				quietHours: { start: "23:00", end: "06:00" },
				escalationDefaults: {
					repeatEveryMin: 15,
					maxRepeats: 4,
					fallbackUserId: "viz-a",
				},
			},
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-d"))
		)[0];
		expect(row?.timezone).toBe("Asia/Tokyo");
		expect(row?.quietHours).toEqual({ start: "23:00", end: "06:00" });
		expect(row?.escalationDefaults).toEqual({
			repeatEveryMin: 15,
			maxRepeats: 4,
			fallbackUserId: "viz-a",
		});
	});
});

// M-i18n: persisted per-user locale, synced cross-device and read server-side
// to render mail/notifications in the recipient's locale.
describe("userPref write-permission mutator: locale", () => {
	test("rejects an unsupported locale", async () => {
		await expect(
			call(mutators.userPref.set, { id: "viz-a" }, { locale: "zz" }),
		).rejects.toThrow();
	});

	test("accepts and persists a supported locale", async () => {
		await call(
			mutators.userPref.set,
			{ id: "viz-a" },
			{ locale: "de" as const },
		);
		const row = (
			await db
				.select()
				.from(tables.userPref)
				.where(eq(tables.userPref.id, "viz-a"))
		)[0];
		expect(row?.locale).toBe("de");
	});
});
