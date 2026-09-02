// Write-permission boundary for the membership.setRole / membership.remove
// mutators (plan 004). No synced-query change here -- memberships.mine
// already exposes co-members with their roles -- so this file is
// write-authorization only, modelled on dashboards.test.ts's `call` helper.
import type { Transaction } from "@rocicorp/zero";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { eq, inArray } from "drizzle-orm";
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

// mem-w: two owners (owner, owner2), one admin, one member, one viewer -- the
// second owner is what lets "owner can be demoted while another owner exists"
// be distinguished from "the sole owner cannot be demoted or removed".
// mem-solo: a workspace with exactly one owner (mem-lonely), for the
// last-owner rules. mem-personal: a personal workspace owned by mem-owner.
const userIds = [
	"mem-owner",
	"mem-owner2",
	"mem-admin",
	"mem-member",
	"mem-viewer",
	"mem-lonely",
] as const;
const workspaceIds = ["mem-w", "mem-solo", "mem-personal"] as const;

const membershipIds = {
	owner: "mem-mid-owner",
	owner2: "mem-mid-owner2",
	admin: "mem-mid-admin",
	member: "mem-mid-member",
	viewer: "mem-mid-viewer",
	lonely: "mem-mid-lonely",
	personal: "mem-mid-personal",
} as const;

// FK order: taskAssignee -> task -> list -> membership -> workspace -> user.
async function wipe() {
	await db
		.delete(tables.taskAssignee)
		.where(inArray(tables.taskAssignee.userId, [...userIds]));
	await db.delete(tables.task).where(inArray(tables.task.id, ["mem-task"]));
	await db.delete(tables.list).where(inArray(tables.list.id, ["mem-list"]));
	await db
		.delete(tables.membership)
		.where(inArray(tables.membership.userId, [...userIds]));
	await db
		.delete(tables.workspace)
		.where(inArray(tables.workspace.id, [...workspaceIds]));
	await db.delete(tables.user).where(inArray(tables.user.id, [...userIds]));
}

beforeAll(async () => {
	await wipe();
	await db
		.insert(tables.user)
		.values(
			userIds.map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
		);
	await db.insert(tables.workspace).values([
		{ id: "mem-w", name: "Mem WS", ownerId: "mem-owner", kind: "shared" },
		{ id: "mem-solo", name: "Solo WS", ownerId: "mem-lonely", kind: "shared" },
		{
			id: "mem-personal",
			name: "Personal",
			ownerId: "mem-owner",
			kind: "personal",
		},
	]);
	await db.insert(tables.membership).values([
		{
			id: membershipIds.owner,
			userId: "mem-owner",
			workspaceId: "mem-w",
			role: "owner",
		},
		{
			id: membershipIds.owner2,
			userId: "mem-owner2",
			workspaceId: "mem-w",
			role: "owner",
		},
		{
			id: membershipIds.admin,
			userId: "mem-admin",
			workspaceId: "mem-w",
			role: "admin",
		},
		{
			id: membershipIds.member,
			userId: "mem-member",
			workspaceId: "mem-w",
			role: "member",
		},
		{
			id: membershipIds.viewer,
			userId: "mem-viewer",
			workspaceId: "mem-w",
			role: "viewer",
		},
		{
			id: membershipIds.lonely,
			userId: "mem-lonely",
			workspaceId: "mem-solo",
			role: "owner",
		},
		{
			id: membershipIds.personal,
			userId: "mem-owner",
			workspaceId: "mem-personal",
			role: "owner",
		},
	]);
	await db.insert(tables.keyGrantRequest).values({
		id: "mem-request-member",
		membershipId: membershipIds.member,
		userId: "mem-member",
		workspaceId: "mem-w",
		requestedVersion: 1,
	});
	// Owned by mem-member so "removing them does not delete content they own"
	// is a real assertion, not a vacuous one.
	await db.insert(tables.list).values({
		id: "mem-list",
		workspaceId: "mem-w",
		ownerId: "mem-member",
		title: "Mem list",
		kind: "tasks",
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "mem-task",
		listId: "mem-list",
		title: "Mem task",
		sortKey: "a0",
	});
	await db.insert(tables.taskAssignee).values([
		{ id: "mem-task:mem-member", taskId: "mem-task", userId: "mem-member" },
		{ id: "mem-task:mem-owner2", taskId: "mem-task", userId: "mem-owner2" },
	]);
});

afterAll(async () => {
	await wipe();
	await pool.end();
});

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

async function membershipRow(id: string) {
	return (
		await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.id, id))
	)[0];
}

async function assigneeRow(id: string) {
	return (
		await db
			.select()
			.from(tables.taskAssignee)
			.where(eq(tables.taskAssignee.id, id))
	)[0];
}

async function listRow(id: string) {
	return (await db.select().from(tables.list).where(eq(tables.list.id, id)))[0];
}

async function taskRow(id: string) {
	return (await db.select().from(tables.task).where(eq(tables.task.id, id)))[0];
}

async function rotationRequired() {
	return (
		await db
			.select({ value: tables.workspace.rotationRequired })
			.from(tables.workspace)
			.where(eq(tables.workspace.id, "mem-w"))
	)[0]?.value;
}

async function grantRequestRow(id: string) {
	return (
		await db
			.select()
			.from(tables.keyGrantRequest)
			.where(eq(tables.keyGrantRequest.id, id))
	)[0];
}

describe("membership.setRole", () => {
	test("admin can change a member to viewer", async () => {
		await call(
			mutators.membership.setRole,
			{ id: "mem-admin" },
			{ id: membershipIds.member, role: "viewer" },
		);
		expect((await membershipRow(membershipIds.member))?.role).toBe("viewer");
		// Restore for the rest of the suite.
		await call(
			mutators.membership.setRole,
			{ id: "mem-admin" },
			{ id: membershipIds.member, role: "member" },
		);
	});

	test("owner can change a member to admin", async () => {
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.member, role: "admin" },
		);
		expect((await membershipRow(membershipIds.member))?.role).toBe("admin");
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.member, role: "member" },
		);
	});

	test("member cannot change anyone's role", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-member" },
				{ id: membershipIds.viewer, role: "member" },
			),
		).rejects.toThrow(/access denied/);
		expect((await membershipRow(membershipIds.viewer))?.role).toBe("viewer");
	});

	test("viewer cannot change anyone's role", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-viewer" },
				{ id: membershipIds.member, role: "viewer" },
			),
		).rejects.toThrow(/access denied/);
		expect((await membershipRow(membershipIds.member))?.role).toBe("member");
	});

	test("admin cannot grant owner", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-admin" },
				{ id: membershipIds.member, role: "owner" },
			),
		).rejects.toThrow(/access denied/);
		expect((await membershipRow(membershipIds.member))?.role).toBe("member");
	});

	test("owner can grant owner", async () => {
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.viewer, role: "owner" },
		);
		expect((await membershipRow(membershipIds.viewer))?.role).toBe("owner");
		// Restore: demote back to viewer (owner acting, another owner still exists).
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.viewer, role: "viewer" },
		);
	});

	test("admin cannot change an owner's role", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-admin" },
				{ id: membershipIds.owner2, role: "member" },
			),
		).rejects.toThrow(/access denied/);
		expect((await membershipRow(membershipIds.owner2))?.role).toBe("owner");
	});

	test("the sole owner of mem-solo cannot be demoted", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-lonely" },
				{ id: membershipIds.lonely, role: "member" },
			),
		).rejects.toThrow(/last owner/);
		expect((await membershipRow(membershipIds.lonely))?.role).toBe("owner");
	});

	test("an owner can be demoted while a second owner exists", async () => {
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.owner2, role: "admin" },
		);
		expect((await membershipRow(membershipIds.owner2))?.role).toBe("admin");
		// Restore: owner promotes owner2 back (owner acting, so grant-owner is legal).
		await call(
			mutators.membership.setRole,
			{ id: "mem-owner" },
			{ id: membershipIds.owner2, role: "owner" },
		);
	});

	test("caller cannot change their own role", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-owner" },
				{ id: membershipIds.owner, role: "admin" },
			),
		).rejects.toThrow(/access denied|own membership/);
		expect((await membershipRow(membershipIds.owner))?.role).toBe("owner");
	});

	test("setRole on the personal workspace's membership rejects", async () => {
		await expect(
			call(
				mutators.membership.setRole,
				{ id: "mem-admin" },
				{ id: membershipIds.personal, role: "member" },
			),
		).rejects.toThrow(/personal/);
		expect((await membershipRow(membershipIds.personal))?.role).toBe("owner");
	});
});

describe("membership.remove", () => {
	test("a rolled-back removal keeps both the membership and rotation flag", async () => {
		await expect(
			zdb.transaction(async (tx) => {
				await mutators.membership.remove.fn({
					tx,
					ctx: { id: "mem-admin" },
					args: { id: membershipIds.viewer },
				});
				throw new Error("simulated rollback");
			}),
		).rejects.toThrow("simulated rollback");
		expect(await membershipRow(membershipIds.viewer)).toBeDefined();
		expect(await rotationRequired()).toBe(false);
	});

	test("admin cannot remove an owner", async () => {
		await expect(
			call(
				mutators.membership.remove,
				{ id: "mem-admin" },
				{ id: membershipIds.owner2 },
			),
		).rejects.toThrow(/access denied/);
		expect(await membershipRow(membershipIds.owner2)).toBeDefined();
	});

	test("the sole owner cannot be removed", async () => {
		await expect(
			call(
				mutators.membership.remove,
				{ id: "mem-lonely" },
				{ id: membershipIds.lonely },
			),
		).rejects.toThrow(/last owner/);
		expect(await membershipRow(membershipIds.lonely)).toBeDefined();
	});

	test("caller cannot remove themselves", async () => {
		await expect(
			call(
				mutators.membership.remove,
				{ id: "mem-owner" },
				{ id: membershipIds.owner },
			),
		).rejects.toThrow(/access denied|own membership/);
		expect(await membershipRow(membershipIds.owner)).toBeDefined();
	});

	test("remove on the personal workspace's membership rejects", async () => {
		await expect(
			call(
				mutators.membership.remove,
				{ id: "mem-owner" },
				{ id: membershipIds.personal },
			),
		).rejects.toThrow(/personal/);
		expect(await membershipRow(membershipIds.personal)).toBeDefined();
	});

	test("member cannot remove anyone", async () => {
		await expect(
			call(
				mutators.membership.remove,
				{ id: "mem-member" },
				{ id: membershipIds.viewer },
			),
		).rejects.toThrow(/access denied/);
		expect(await membershipRow(membershipIds.viewer)).toBeDefined();
	});

	test("admin can remove a member; side effect clears their task_assignee row but leaves other rows alone", async () => {
		expect(await assigneeRow("mem-task:mem-member")).toBeDefined();
		expect(await assigneeRow("mem-task:mem-owner2")).toBeDefined();

		await call(
			mutators.membership.remove,
			{ id: "mem-admin" },
			{ id: membershipIds.member },
		);

		expect(await membershipRow(membershipIds.member)).toBeUndefined();
		expect(await rotationRequired()).toBe(true);
		expect(await grantRequestRow("mem-request-member")).toBeUndefined();
		expect(await assigneeRow("mem-task:mem-member")).toBeUndefined();
		// Another member's assignee row is untouched.
		expect(await assigneeRow("mem-task:mem-owner2")).toBeDefined();
		// The list mem-member (previously "member") did not own, and the task,
		// both survive removal -- content is not deleted with the person.
		expect(await listRow("mem-list")).toBeDefined();
		expect(await taskRow("mem-task")).toBeDefined();
	});
});
