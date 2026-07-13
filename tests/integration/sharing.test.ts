// Isolation tests for the M1b sharing read queries (queries.ts). These queries
// are the read-permission boundary: zero-cache only syncs rows they return, so a
// gap here leaks other workspaces' invites/assignees/comments. Assertions are the
// spec -- keep them strict.
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq } from "drizzle-orm";
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

// owner/admin/member/viewer are members of `shared`; outsider owns `other`;
// kid/guardian back the managed_account (no `shared` membership).
const users = [
	"owner",
	"admin",
	"member",
	"viewer",
	"outsider",
	"kid",
	"guardian",
] as const;

const ctx = (id: string) => ({ args: undefined, ctx: { id } }) as const;

beforeAll(async () => {
	await db.delete(tables.comment);
	await db.delete(tables.taskAssignee);
	await db.delete(tables.invite);
	await db.delete(tables.managedAccount);
	await db.delete(tables.taskLabel);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.user);

	await db.insert(tables.user).values(
		users.map((id) => ({
			id,
			name: id,
			email: `${id}@test.invalid`,
		})),
	);
	await db.insert(tables.workspace).values([
		{ id: "shared", name: "Shared", ownerId: "owner", kind: "shared" },
		{ id: "other", name: "Other", ownerId: "outsider", kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		...(["owner", "admin", "member", "viewer"] as const).map((role) => ({
			id: `membership-${role}`,
			userId: role,
			workspaceId: "shared",
			role,
		})),
		// outsider is a lone member of `other` -- proves isolation is per-workspace,
		// not "any membership sees everything".
		{
			id: "membership-outsider",
			userId: "outsider",
			workspaceId: "other",
			role: "owner" as const,
		},
	]);
	await db.insert(tables.list).values({
		id: "shared-list",
		workspaceId: "shared",
		ownerId: "owner",
		title: "Shared list",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "shared-task",
		listId: "shared-list",
		title: "Shared task",
		sortKey: "a0",
	});
	await db.insert(tables.invite).values([
		{
			id: "invite-pending",
			workspaceId: "shared",
			role: "member",
			email: "invitee@test.invalid",
			token: "token-pending",
			status: "pending",
			createdBy: "owner",
		},
		// Non-pending invite: must never appear (status filter).
		{
			id: "invite-accepted",
			workspaceId: "shared",
			role: "member",
			email: "gone@test.invalid",
			token: "token-accepted",
			status: "accepted",
			createdBy: "owner",
		},
	]);
	await db.insert(tables.taskAssignee).values({
		id: "shared-task:member",
		taskId: "shared-task",
		userId: "member",
	});
	await db.insert(tables.comment).values({
		id: "comment-1",
		taskId: "shared-task",
		authorId: "owner",
		body: "hello",
	});
	await db.insert(tables.managedAccount).values({
		id: "managed-1",
		userId: "kid",
		guardianId: "guardian",
	});
});

afterAll(async () => {
	// Clean the sharing tables this file seeds: sibling integration files predate
	// them (Task 1) and only delete workspace/user, so leftover invite/comment/
	// assignee/managed rows would break their FK-ordered cleanup.
	await db.delete(tables.comment);
	await db.delete(tables.taskAssignee);
	await db.delete(tables.invite);
	await db.delete(tables.managedAccount);
	await pool.end();
});

describe("sharing read-permission isolation", () => {
	test("outsider reads no shared memberships", async () => {
		const rows = await zdb.run(queries.memberships.mine.fn(ctx("outsider")));
		expect(rows.map((r) => r.workspaceId)).not.toContain("shared");
	});

	test("member sees co-members in shared (picker works)", async () => {
		const rows = await zdb.run(queries.memberships.mine.fn(ctx("member")));
		const shared = rows
			.filter((r) => r.workspaceId === "shared")
			.map((r) => r.userId);
		expect(new Set(shared)).toEqual(
			new Set(["owner", "admin", "member", "viewer"]),
		);
	});

	test("outsider reads no shared assignees", async () => {
		expect(await zdb.run(queries.assignees.mine.fn(ctx("outsider")))).toEqual(
			[],
		);
	});

	test("member reads the shared assignee", async () => {
		const rows = await zdb.run(queries.assignees.mine.fn(ctx("member")));
		expect(rows.map((r) => r.id)).toContain("shared-task:member");
	});

	test("outsider reads no shared comments", async () => {
		expect(await zdb.run(queries.comments.mine.fn(ctx("outsider")))).toEqual(
			[],
		);
	});

	test("member reads the shared comment", async () => {
		const rows = await zdb.run(queries.comments.mine.fn(ctx("member")));
		expect(rows.map((r) => r.id)).toContain("comment-1");
	});

	test("outsider reads no shared invites", async () => {
		expect(
			await zdb.run(queries.invites.forWorkspace.fn(ctx("outsider"))),
		).toEqual([]);
	});

	test.each([
		"member",
		"viewer",
	] as const)("%s (non-admin) reads no invites (admin gate)", async (userId) => {
		expect(await zdb.run(queries.invites.forWorkspace.fn(ctx(userId)))).toEqual(
			[],
		);
	});

	test.each([
		"owner",
		"admin",
	] as const)("%s sees only the pending invite", async (userId) => {
		const rows = await zdb.run(queries.invites.forWorkspace.fn(ctx(userId)));
		expect(rows.map((r) => r.id)).toEqual(["invite-pending"]);
	});

	test("kid reads own managed_account row", async () => {
		const rows = await zdb.run(queries.managedAccounts.mine.fn(ctx("kid")));
		expect(rows.map((r) => r.id)).toEqual(["managed-1"]);
	});

	test("guardian reads owned managed_account row", async () => {
		const rows = await zdb.run(
			queries.managedAccounts.mine.fn(ctx("guardian")),
		);
		expect(rows.map((r) => r.id)).toEqual(["managed-1"]);
	});

	test.each([
		"owner",
		"admin",
		"member",
		"viewer",
		"outsider",
	] as const)("%s reads no managed_account rows", async (userId) => {
		expect(await zdb.run(queries.managedAccounts.mine.fn(ctx(userId)))).toEqual(
			[],
		);
	});
});

// Write-permission boundary: these mutators are the write authorization gate.
// Run each via a real Zero tx (server path) so the role lookup hits Postgres.
// `call` mirrors the typed helper in domain.test.ts so the two files stay
// consistent (generic args, no `unknown` casts).
type Ctx = { id: string };
async function call<A>(
	mutator: {
		fn: (a: { tx: Transaction<Schema>; ctx: Ctx; args: A }) => Promise<void>;
	},
	c: Ctx,
	args: A,
) {
	return zdb.transaction((tx) => mutator.fn({ tx, ctx: c, args }));
}

describe("sharing write-permission mutators", () => {
	test("viewer cannot task.assign", async () => {
		await expect(
			call(
				mutators.task.assign,
				{ id: "viewer" },
				{
					taskId: "shared-task",
					userId: "member",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("viewer cannot task.unassign", async () => {
		await expect(
			call(
				mutators.task.unassign,
				{ id: "viewer" },
				{
					taskId: "shared-task",
					userId: "member",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("viewer cannot comment.add", async () => {
		await expect(
			call(
				mutators.comment.add,
				{ id: "viewer" },
				{
					id: "cmt-viewer",
					taskId: "shared-task",
					body: "nope",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("invite.revoke by member is rejected", async () => {
		await expect(
			call(mutators.invite.revoke, { id: "member" }, { id: "invite-pending" }),
		).rejects.toThrow(/access denied/);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, "invite-pending"));
		expect(rows[0]?.status).toBe("pending");
	});

	test("invite.revoke by admin sets status revoked", async () => {
		await call(
			mutators.invite.revoke,
			{ id: "admin" },
			{ id: "invite-pending" },
		);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, "invite-pending"));
		expect(rows[0]?.status).toBe("revoked");
	});

	test("task.assign of a non-member is rejected", async () => {
		await expect(
			call(
				mutators.task.assign,
				{ id: "owner" },
				{
					taskId: "shared-task",
					userId: "outsider",
				},
			),
		).rejects.toThrow(/assignee not a member/);
	});

	test("task.assign by a non-member of the task's workspace is rejected", async () => {
		await expect(
			call(
				mutators.task.assign,
				{ id: "outsider" },
				{
					taskId: "shared-task",
					userId: "member",
				},
			),
		).rejects.toThrow(/access denied/);
	});

	test("task.assign is idempotent (same pair twice -> one row)", async () => {
		await call(
			mutators.task.assign,
			{ id: "owner" },
			{
				taskId: "shared-task",
				userId: "admin",
			},
		);
		await call(
			mutators.task.assign,
			{ id: "owner" },
			{
				taskId: "shared-task",
				userId: "admin",
			},
		);
		const rows = await db
			.select()
			.from(tables.taskAssignee)
			.where(eq(tables.taskAssignee.id, "shared-task:admin"));
		expect(rows).toHaveLength(1);
	});

	test("task.unassign removes the assignee row", async () => {
		await call(
			mutators.task.assign,
			{ id: "member" },
			{
				taskId: "shared-task",
				userId: "viewer",
			},
		);
		await call(
			mutators.task.unassign,
			{ id: "member" },
			{
				taskId: "shared-task",
				userId: "viewer",
			},
		);
		const rows = await db
			.select()
			.from(tables.taskAssignee)
			.where(eq(tables.taskAssignee.id, "shared-task:viewer"));
		expect(rows).toHaveLength(0);
	});

	test("comment.add by a member inserts the row (authorId = caller)", async () => {
		await call(
			mutators.comment.add,
			{ id: "member" },
			{
				id: "cmt-add",
				taskId: "shared-task",
				body: "from member",
			},
		);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-add"));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.authorId).toBe("member");
		expect(rows[0]?.taskId).toBe("shared-task");
		expect(rows[0]?.body).toBe("from member");
	});

	test("comment.edit by a non-author is rejected", async () => {
		await db.insert(tables.comment).values({
			id: "cmt-edit",
			taskId: "shared-task",
			authorId: "owner",
			body: "original",
		});
		await expect(
			call(
				mutators.comment.edit,
				{ id: "member" },
				{
					id: "cmt-edit",
					body: "hijacked",
				},
			),
		).rejects.toThrow(/author only/);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-edit"));
		expect(rows[0]?.body).toBe("original");
		expect(rows[0]?.editedAt).toBeNull();
	});

	test("comment.edit by the author sets body and editedAt", async () => {
		await call(
			mutators.comment.edit,
			{ id: "owner" },
			{
				id: "cmt-edit",
				body: "revised",
			},
		);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-edit"));
		expect(rows[0]?.body).toBe("revised");
		expect(rows[0]?.editedAt).not.toBeNull();
	});

	test("comment.delete by the author (plain member) is allowed", async () => {
		await call(
			mutators.comment.add,
			{ id: "member" },
			{
				id: "cmt-del-author",
				taskId: "shared-task",
				body: "mine to delete",
			},
		);
		await call(
			mutators.comment.delete,
			{ id: "member" },
			{
				id: "cmt-del-author",
			},
		);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-del-author"));
		expect(rows).toHaveLength(0);
	});

	test("comment.delete by an admin (non-author) is allowed", async () => {
		await db.insert(tables.comment).values({
			id: "cmt-del-admin",
			taskId: "shared-task",
			authorId: "owner",
			body: "delete me",
		});
		await call(
			mutators.comment.delete,
			{ id: "admin" },
			{ id: "cmt-del-admin" },
		);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-del-admin"));
		expect(rows).toHaveLength(0);
	});

	test("comment.delete by an unrelated member (non-author) is rejected", async () => {
		await db.insert(tables.comment).values({
			id: "cmt-del-member",
			taskId: "shared-task",
			authorId: "owner",
			body: "keep me",
		});
		await expect(
			call(
				mutators.comment.delete,
				{ id: "member" },
				{
					id: "cmt-del-member",
				},
			),
		).rejects.toThrow(/access denied/);
		const rows = await db
			.select()
			.from(tables.comment)
			.where(eq(tables.comment.id, "cmt-del-member"));
		expect(rows).toHaveLength(1);
	});
});
