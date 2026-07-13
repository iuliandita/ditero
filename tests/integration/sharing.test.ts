// Isolation tests for the M1b sharing read queries (queries.ts). These queries
// are the read-permission boundary: zero-cache only syncs rows they return, so a
// gap here leaks other workspaces' invites/assignees/comments. Assertions are the
// spec -- keep them strict.
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
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
