import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { type Schema, schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const zdb = zeroNodePg(schema, pool);

const users = ["owner", "member", "viewer", "outsider"] as const;

// Run one mutator inside a transaction, matching the permissions harness shape.
type Ctx = { id: string };
async function call<A>(
	mutator: {
		fn: (a: { tx: Transaction<Schema>; ctx: Ctx; args: A }) => Promise<void>;
	},
	ctx: Ctx,
	args: A,
) {
	return zdb.transaction((tx) => mutator.fn({ tx, ctx, args }));
}

// Sibling test files predate the folder/label/template tables and their cleanup
// does not touch them, so this file must fully wipe (and leave) an empty domain.
async function wipe() {
	await db.delete(tables.taskLabel);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.folder);
	await db.delete(tables.label);
	await db.delete(tables.template);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.user);
}

beforeAll(async () => {
	await wipe();

	await db
		.insert(tables.user)
		.values(users.map((id) => ({ id, name: id, email: `${id}@test.invalid` })));
	// w1: owner/member/viewer are members. w2: only owner (member lacks access).
	await db.insert(tables.workspace).values([
		{ id: "w1", name: "W1", ownerId: "owner", kind: "shared" },
		{ id: "w2", name: "W2", ownerId: "owner", kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{ id: "m-owner", userId: "owner", workspaceId: "w1", role: "owner" },
		{ id: "m-member", userId: "member", workspaceId: "w1", role: "member" },
		{ id: "m-viewer", userId: "viewer", workspaceId: "w1", role: "viewer" },
		{ id: "m-owner2", userId: "owner", workspaceId: "w2", role: "owner" },
	]);
	await db.insert(tables.folder).values([
		{ id: "f-full", workspaceId: "w1", name: "Full", sortKey: "a0" },
		{ id: "f-empty", workspaceId: "w1", name: "Empty", sortKey: "a1" },
	]);
	await db.insert(tables.list).values([
		{
			id: "l1",
			workspaceId: "w1",
			ownerId: "owner",
			title: "L1",
			kind: "tasks",
			folderId: "f-full",
			sortKey: "a0",
		},
		// Second w1 list so members can move tasks across lists within one workspace.
		{
			id: "l1b",
			workspaceId: "w1",
			ownerId: "owner",
			title: "L1b",
			kind: "tasks",
			sortKey: "a1",
		},
		{
			id: "l2",
			workspaceId: "w2",
			ownerId: "owner",
			title: "L2",
			kind: "tasks",
			sortKey: "a0",
		},
	]);
	await db.insert(tables.task).values([
		{ id: "t1", listId: "l1", title: "T1", sortKey: "a0" },
		{ id: "t-l2", listId: "l2", title: "T in L2", sortKey: "a0" },
	]);
	await db.insert(tables.label).values([
		{ id: "lab-urgent", workspaceId: "w1", name: "urgent", color: "red" },
		{ id: "lab-w2", workspaceId: "w2", name: "w2-label", color: "blue" },
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

describe("domain mutators", () => {
	// Every write-surface mutator with args that would succeed for a member;
	// a viewer must be denied on all of them.
	const viewerCases: [string, () => Promise<unknown>][] = [
		[
			"task.create",
			() =>
				call(
					mutators.task.create,
					{ id: "viewer" },
					{
						id: "v-task",
						listId: "l1",
						title: "x",
						sortKey: "a1",
					},
				),
		],
		[
			"task.update",
			() =>
				call(
					mutators.task.update,
					{ id: "viewer" },
					{
						id: "t1",
						title: "x",
					},
				),
		],
		[
			"task.move",
			() =>
				call(
					mutators.task.move,
					{ id: "viewer" },
					{
						id: "t1",
						listId: "l1",
						sortKey: "a2",
					},
				),
		],
		[
			"task.delete",
			() => call(mutators.task.delete, { id: "viewer" }, { id: "t1" }),
		],
		[
			"list.create",
			() =>
				call(
					mutators.list.create,
					{ id: "viewer" },
					{
						id: "v-list",
						workspaceId: "w1",
						title: "x",
						kind: "tasks",
						sortKey: "a1",
					},
				),
		],
		[
			"list.update",
			() =>
				call(
					mutators.list.update,
					{ id: "viewer" },
					{
						id: "l1",
						title: "x",
					},
				),
		],
		[
			"list.delete",
			() => call(mutators.list.delete, { id: "viewer" }, { id: "l1" }),
		],
		[
			"folder.create",
			() =>
				call(
					mutators.folder.create,
					{ id: "viewer" },
					{
						id: "v-folder",
						workspaceId: "w1",
						name: "x",
						sortKey: "a2",
					},
				),
		],
		[
			"folder.update",
			() =>
				call(
					mutators.folder.update,
					{ id: "viewer" },
					{
						id: "f-empty",
						name: "x",
					},
				),
		],
		[
			"folder.delete",
			() => call(mutators.folder.delete, { id: "viewer" }, { id: "f-empty" }),
		],
		[
			"label.create",
			() =>
				call(
					mutators.label.create,
					{ id: "viewer" },
					{
						id: "v-label",
						workspaceId: "w1",
						name: "new",
					},
				),
		],
		[
			"label.update",
			() =>
				call(
					mutators.label.update,
					{ id: "viewer" },
					{
						id: "lab-urgent",
						color: "blue",
					},
				),
		],
		[
			"label.delete",
			() => call(mutators.label.delete, { id: "viewer" }, { id: "lab-urgent" }),
		],
		[
			"taskLabel.set",
			() =>
				call(
					mutators.taskLabel.set,
					{ id: "viewer" },
					{
						taskId: "t1",
						labelIds: ["lab-urgent"],
					},
				),
		],
	];

	test.each(viewerCases)("viewer is denied on %s", async (_name, run) => {
		await expect(run()).rejects.toThrow(/access denied/);
	});

	test("member can create a task", async () => {
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "m-task",
				listId: "l1",
				title: "member task",
				sortKey: "a5",
			},
		);
	});

	test("member can create + fill + delete a folder", async () => {
		await call(
			mutators.folder.create,
			{ id: "member" },
			{
				id: "m-folder",
				workspaceId: "w1",
				name: "member folder",
				sortKey: "a5",
			},
		);
		await call(mutators.folder.delete, { id: "member" }, { id: "m-folder" });
	});

	test("member can create a label and set it on a task", async () => {
		await call(
			mutators.label.create,
			{ id: "member" },
			{
				id: "m-label",
				workspaceId: "w1",
				name: "member-label",
			},
		);
		await call(
			mutators.taskLabel.set,
			{ id: "member" },
			{
				taskId: "t1",
				labelIds: ["lab-urgent", "m-label"],
			},
		);
		const rows = await db.query.taskLabel.findMany();
		expect(rows.filter((r) => r.taskId === "t1")).toHaveLength(2);
		// Idempotent diff: removing one leaves exactly one.
		await call(
			mutators.taskLabel.set,
			{ id: "member" },
			{
				taskId: "t1",
				labelIds: ["m-label"],
			},
		);
		const after = await db.query.taskLabel.findMany();
		expect(after.filter((r) => r.taskId === "t1")).toHaveLength(1);
	});

	test("toggling done sets and clears completedAt", async () => {
		await call(
			mutators.task.update,
			{ id: "member" },
			{
				id: "t1",
				done: true,
			},
		);
		const done = await db.query.task.findFirst({
			where: (t, { eq }) => eq(t.id, "t1"),
		});
		expect(done?.completedAt).not.toBeNull();
		await call(
			mutators.task.update,
			{ id: "member" },
			{
				id: "t1",
				done: false,
			},
		);
		const undone = await db.query.task.findFirst({
			where: (t, { eq }) => eq(t.id, "t1"),
		});
		expect(undone?.completedAt).toBeNull();
	});

	test("subtasks are one level deep", async () => {
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "parent",
				listId: "l1",
				title: "parent",
				sortKey: "b0",
			},
		);
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "child",
				listId: "l1",
				title: "child",
				sortKey: "b1",
				parentId: "parent",
			},
		);
		await expect(
			call(
				mutators.task.create,
				{ id: "member" },
				{
					id: "grandchild",
					listId: "l1",
					title: "grandchild",
					sortKey: "b2",
					parentId: "child",
				},
			),
		).rejects.toThrow(/one level/);
	});

	test("subtask parent must share the same list", async () => {
		// member has write on l1; parent t-l2 lives in l2 -> rejected.
		await expect(
			call(
				mutators.task.create,
				{ id: "member" },
				{
					id: "cross",
					listId: "l1",
					title: "cross",
					sortKey: "b3",
					parentId: "t-l2",
				},
			),
		).rejects.toThrow(/different list/);
	});

	test("task.delete cascades subtasks", async () => {
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "p2",
				listId: "l1",
				title: "p2",
				sortKey: "c0",
			},
		);
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "c2",
				listId: "l1",
				title: "c2",
				sortKey: "c1",
				parentId: "p2",
			},
		);
		await call(mutators.task.delete, { id: "member" }, { id: "p2" });
		const rows = await db.query.task.findMany();
		expect(rows.map((r) => r.id)).not.toContain("p2");
		expect(rows.map((r) => r.id)).not.toContain("c2");
	});

	test("task.move into a workspace without membership is denied", async () => {
		// member is not a member of w2, which owns l2.
		await expect(
			call(
				mutators.task.move,
				{ id: "member" },
				{
					id: "m-task",
					listId: "l2",
					sortKey: "a9",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("task.move of a parent cascades its subtasks to the target list", async () => {
		await call(
			mutators.task.create,
			{ id: "member" },
			{ id: "mv-parent", listId: "l1", title: "mv-parent", sortKey: "d0" },
		);
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "mv-child",
				listId: "l1",
				title: "mv-child",
				sortKey: "d1",
				parentId: "mv-parent",
			},
		);
		await call(
			mutators.task.move,
			{ id: "member" },
			{ id: "mv-parent", listId: "l1b", sortKey: "e0" },
		);
		const rows = await db.query.task.findMany();
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get("mv-parent")?.listId).toBe("l1b");
		expect(byId.get("mv-child")?.listId).toBe("l1b");
	});

	test("task.move of a subtask into a different list is rejected", async () => {
		await call(
			mutators.task.create,
			{ id: "member" },
			{ id: "mv-parent2", listId: "l1", title: "mv-parent2", sortKey: "d2" },
		);
		await call(
			mutators.task.create,
			{ id: "member" },
			{
				id: "mv-child2",
				listId: "l1",
				title: "mv-child2",
				sortKey: "d3",
				parentId: "mv-parent2",
			},
		);
		await expect(
			call(
				mutators.task.move,
				{ id: "member" },
				{ id: "mv-child2", listId: "l1b", sortKey: "e1" },
			),
		).rejects.toThrow(/parent's list/);
	});

	test("task.move of a subtask within its own list (reorder) is allowed", async () => {
		await call(
			mutators.task.move,
			{ id: "member" },
			{ id: "mv-child2", listId: "l1", sortKey: "e2" },
		);
		const row = await db.query.task.findFirst({
			where: (t, { eq }) => eq(t.id, "mv-child2"),
		});
		expect(row?.listId).toBe("l1");
		expect(row?.sortKey).toBe("e2");
	});

	test("folder.delete rejects a non-empty folder", async () => {
		await expect(
			call(mutators.folder.delete, { id: "member" }, { id: "f-full" }),
		).rejects.toThrow(/not empty/);
	});

	test("label name collision is rejected", async () => {
		await expect(
			call(
				mutators.label.create,
				{ id: "member" },
				{
					id: "dup",
					workspaceId: "w1",
					name: "urgent",
				},
			),
		).rejects.toThrow(/already exists/);
	});

	test("taskLabel.set rejects a label from another workspace", async () => {
		// owner belongs to w1 and w2; lab-w2 lives in w2, t1's list is in w1.
		await expect(
			call(
				mutators.taskLabel.set,
				{ id: "owner" },
				{ taskId: "t1", labelIds: ["lab-w2"] },
			),
		).rejects.toThrow(/not in task workspace/);
	});

	test("non-owner member cannot delete another user's list without admin", async () => {
		// l1 owner is `owner`; member has write but is not admin/owner of the list.
		await expect(
			call(mutators.list.delete, { id: "member" }, { id: "l1" }),
		).rejects.toThrow(/access denied/);
	});
});
