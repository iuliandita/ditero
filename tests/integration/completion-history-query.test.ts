import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);
const OWNER = "history-query-owner";
const VIEWER = "history-query-viewer";
const OUTSIDER = "history-query-outsider";
const SPACE = "history-query-space";
const FOREIGN = "history-query-foreign";
const LIST = "history-query-list";
const FOREIGN_LIST = "history-query-foreign-list";
const TASK = "history-query-task";
const FOREIGN_TASK = "history-query-foreign-task";
const STAMP = Date.parse("2026-09-25T12:34:56.123Z");
const cursor = (row: { recordedAt: number; id: string }) => ({
	recordedAt: row.recordedAt,
	id: row.id,
});
const page = (
	userId: string,
	taskId = TASK,
	after: ReturnType<typeof cursor> | null = null,
) =>
	zdb.run(
		queries.taskCompletionEvents.page.fn({
			args: { taskId, cursor: after },
			ctx: { id: userId },
		}),
	);

async function clean() {
	await db
		.delete(tables.task)
		.where(inArray(tables.task.id, [TASK, FOREIGN_TASK]));
	await db
		.delete(tables.list)
		.where(inArray(tables.list.id, [LIST, FOREIGN_LIST]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.workspaceId, [SPACE, FOREIGN]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, [SPACE, FOREIGN]));
	await db
		.delete(tables.user)
		.where(inArray(tables.user.id, [OWNER, VIEWER, OUTSIDER]));
}

beforeAll(async () => {
	await clean();
	await db.insert(tables.user).values(
		[OWNER, VIEWER, OUTSIDER].map((id) => ({
			id,
			name: id,
			email: `${id}@example.test`,
		})),
	);
	await db.insert(tables.workspace).values([
		{ id: SPACE, name: "Visible", ownerId: OWNER, kind: "shared" },
		{ id: FOREIGN, name: "Foreign", ownerId: OUTSIDER, kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{
			id: "history-query-owner-seat",
			workspaceId: SPACE,
			userId: OWNER,
			role: "owner",
		},
		{
			id: "history-query-viewer-seat",
			workspaceId: SPACE,
			userId: VIEWER,
			role: "viewer",
		},
		{
			id: "history-query-foreign-seat",
			workspaceId: FOREIGN,
			userId: OUTSIDER,
			role: "owner",
		},
	]);
	await db.insert(tables.list).values([
		{
			id: LIST,
			workspaceId: SPACE,
			ownerId: OWNER,
			title: "Visible",
			sortKey: "a0",
		},
		{
			id: FOREIGN_LIST,
			workspaceId: FOREIGN,
			ownerId: OUTSIDER,
			title: "Foreign",
			sortKey: "a0",
		},
	]);
	await db.insert(tables.task).values([
		{ id: TASK, listId: LIST, title: "Visible", sortKey: "a0" },
		{ id: FOREIGN_TASK, listId: FOREIGN_LIST, title: "Foreign", sortKey: "a0" },
	]);
	await db.insert(tables.taskCompletionEvent).values(
		Array.from({ length: 102 }, (_, index) => ({
			id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
			taskId: TASK,
			actorUserId: OWNER,
			recordedAt: new Date(STAMP),
			origin: "member_mutation" as const,
			action: "complete" as const,
			beforeDueAt: null,
			beforeDueAllDay: false,
			beforeDone: false,
			afterDueAt: null,
			afterDone: true,
		})),
	);
});

afterAll(async () => {
	try {
		await clean();
	} finally {
		await pool.end();
	}
});

test("bounded pages preserve timestamp ties and exact millisecond cursors", async () => {
	const first = await page(VIEWER);
	expect(first).toHaveLength(100);
	expect(first[0]?.recordedAt).toBe(STAMP);
	expect(first[0]?.id).toBe("00000000-0000-4000-8000-000000000101");
	const last = first.at(-1);
	if (!last) throw new Error("First page is unexpectedly empty");
	const second = await page(VIEWER, TASK, cursor(last));
	expect(second.map((row) => row.id)).toEqual([
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-4000-8000-000000000000",
	]);
	expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(102);
	const end = second.at(-1);
	if (!end) throw new Error("Second page is unexpectedly empty");
	expect(await page(VIEWER, TASK, cursor(end))).toEqual([]);
});

test("foreign and missing tasks reveal no events, while a visible actor remains attributable", async () => {
	expect(await page(OUTSIDER)).toEqual([]);
	expect(await page(VIEWER, "history-query-missing")).toEqual([]);
	expect(await page(VIEWER, FOREIGN_TASK)).toEqual([]);
	const rows = await page(VIEWER);
	expect(rows[0]?.actor?.name).toBe(OWNER);
});

test("each page rechecks current membership", async () => {
	const rows = await page(VIEWER);
	const last = rows.at(-1);
	if (!last) throw new Error("First page is unexpectedly empty");
	await db
		.delete(tables.membership)
		.where(eq(tables.membership.id, "history-query-viewer-seat"));
	try {
		expect(await page(VIEWER, TASK, cursor(last))).toEqual([]);
	} finally {
		await db.insert(tables.membership).values({
			id: "history-query-viewer-seat",
			workspaceId: SPACE,
			userId: VIEWER,
			role: "viewer",
		});
	}
});

test("history follows current task location and resolves the current anonymized actor", async () => {
	await db
		.update(tables.task)
		.set({ listId: FOREIGN_LIST })
		.where(eq(tables.task.id, TASK));
	await db
		.update(tables.user)
		.set({ name: "Deleted user", image: null })
		.where(eq(tables.user.id, OWNER));
	try {
		expect(await page(VIEWER)).toEqual([]);
		const visible = await page(OUTSIDER);
		expect(visible).toHaveLength(100);
		expect(visible[0]?.actor?.name).toBe("Deleted user");
	} finally {
		await db
			.update(tables.task)
			.set({ listId: LIST })
			.where(eq(tables.task.id, TASK));
		await db
			.update(tables.user)
			.set({ name: OWNER })
			.where(eq(tables.user.id, OWNER));
	}
});

test.each([
	{ taskId: TASK, cursor: null, limit: 10_000 },
	{ taskId: TASK, cursor: { recordedAt: Number.NaN, id: "x" } },
	{ taskId: TASK, cursor: { recordedAt: Number.POSITIVE_INFINITY, id: "x" } },
	{ taskId: TASK, cursor: { recordedAt: 1.1, id: "x" } },
	{ taskId: TASK, cursor: { recordedAt: 8_640_000_000_000_001, id: "x" } },
	{ taskId: TASK, cursor: { recordedAt: -210_866_803_200_001, id: "x" } },
	{ taskId: TASK, cursor: { recordedAt: STAMP, id: "x", actorUserId: OWNER } },
])("rejects forged or invalid query arguments %#", (args) => {
	expect(() =>
		queries.taskCompletionEvents.page.fn({
			args: args as never,
			ctx: { id: VIEWER },
		}),
	).toThrow();
});

test("accepts the PostgreSQL lower timestamp boundary", async () => {
	expect(
		await page(VIEWER, TASK, { recordedAt: -210_866_803_200_000, id: "x" }),
	).toEqual([]);
});

test("accepts an empty task identifier without granting access to anything else", async () => {
	expect(await page(VIEWER, "")).toEqual([]);
});
