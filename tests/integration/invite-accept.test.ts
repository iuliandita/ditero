// Server-side sharing endpoints (Task 5): invite create/accept/preview, managed
// account, user lookup. These are the security-critical seams -- role escalation,
// token redemption gating, one-tx accept+attach, the managed-account registration
// bypass, and the no-email-leak lookup. Assertions are strict: they ARE the spec.
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import {
	acceptInvite,
	InviteAcceptError,
	previewInvite,
} from "../../src/auth/invite-accept.ts";
import {
	createInvite,
	InviteCreateError,
} from "../../src/auth/invite-create.ts";
import { createManagedAccount } from "../../src/auth/managed-account.ts";
import * as tables from "../../src/db/schema.ts";
import { lookupUsers } from "../../src/server/discovery.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

// Owner/admin/member/viewer in `shared`; `outsider` owns a foreign workspace with
// its own list+task (proves foreign-task attach is rejected).
async function seed() {
	await db.insert(tables.user).values(
		["owner", "admin", "member", "viewer", "outsider", "joiner"].map((id) => ({
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
			id: `m-${role}`,
			userId: role,
			workspaceId: "shared",
			role,
		})),
		{
			id: "m-outsider",
			userId: "outsider",
			workspaceId: "other",
			role: "owner" as const,
		},
	]);
	await db.insert(tables.list).values([
		{
			id: "shared-list",
			workspaceId: "shared",
			ownerId: "owner",
			title: "Shared",
			sortKey: "a0",
		},
		{
			id: "other-list",
			workspaceId: "other",
			ownerId: "outsider",
			title: "Other",
			sortKey: "a0",
		},
	]);
	await db.insert(tables.task).values([
		{ id: "shared-task", listId: "shared-list", title: "T", sortKey: "a0" },
		{ id: "other-task", listId: "other-list", title: "T", sortKey: "a0" },
	]);
}

beforeEach(async () => {
	await db.delete(tables.comment);
	await db.delete(tables.taskAssignee);
	await db.delete(tables.invite);
	await db.delete(tables.managedAccount);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
	await db.delete(tables.rateLimit);
	await seed();
});

afterAll(async () => {
	await pool.end();
});

describe("createInvite role-escalation gate", () => {
	test("member can mint a member invite (row persisted, token present)", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "member", email: "a@test.invalid" },
			"member",
			db,
			{},
		);
		expect(res.token).toBeTruthy();
		expect(res.link).toContain(`token=${res.token}`);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("member");
		expect(rows[0].status).toBe("pending");
		expect(rows[0].token).toBe(res.token);
	});

	test("restricted managed account cannot mint any invite (403, no row)", async () => {
		// `member` has the member role but is also a restricted managed account.
		await db.insert(tables.managedAccount).values({
			id: "ma-member",
			userId: "member",
			guardianId: "owner",
			restricted: true,
		});
		await expect(
			createInvite(
				{ workspaceId: "shared", role: "member", email: "a@test.invalid" },
				"member",
				db,
				{},
			),
		).rejects.toMatchObject({ status: 403 });
		const rows = await db.select().from(tables.invite);
		expect(rows).toHaveLength(0);
	});

	test("member can mint a viewer invite", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "viewer" },
			"member",
			db,
			{},
		);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(rows[0].role).toBe("viewer");
	});

	test("member is BLOCKED from minting an admin invite (403)", async () => {
		await expect(
			createInvite({ workspaceId: "shared", role: "admin" }, "member", db, {}),
		).rejects.toMatchObject({ status: 403 });
	});

	test("member is BLOCKED from minting an owner invite (403)", async () => {
		await expect(
			createInvite({ workspaceId: "shared", role: "owner" }, "member", db, {}),
		).rejects.toBeInstanceOf(InviteCreateError);
	});

	test("admin can mint an admin invite", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "admin" },
			"admin",
			db,
			{},
		);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(rows[0].role).toBe("admin");
	});

	test("admin is BLOCKED from minting an owner invite (403, no privilege escalation)", async () => {
		await expect(
			createInvite({ workspaceId: "shared", role: "owner" }, "admin", db, {}),
		).rejects.toMatchObject({ status: 403 });
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.role, "owner"));
		expect(rows).toHaveLength(0);
	});

	test("owner can mint an owner invite", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "owner" },
			"owner",
			db,
			{},
		);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].role).toBe("owner");
	});

	test("non-member cannot mint any invite (403)", async () => {
		await expect(
			createInvite(
				{ workspaceId: "shared", role: "member" },
				"outsider",
				db,
				{},
			),
		).rejects.toMatchObject({ status: 403 });
	});

	test("viewer cannot mint any invite (403)", async () => {
		await expect(
			createInvite({ workspaceId: "shared", role: "viewer" }, "viewer", db, {}),
		).rejects.toMatchObject({ status: 403 });
	});

	test("DITERO_MEMBER_INVITES=admin blocks a member from any invite", async () => {
		await expect(
			createInvite({ workspaceId: "shared", role: "member" }, "member", db, {
				DITERO_MEMBER_INVITES: "admin",
			}),
		).rejects.toMatchObject({ status: 403 });
		// admin still can under the strict policy
		const res = await createInvite(
			{ workspaceId: "shared", role: "member" },
			"admin",
			db,
			{ DITERO_MEMBER_INVITES: "admin" },
		);
		expect(res.token).toBeTruthy();
	});
});

describe("createInvite maxUses defaults", () => {
	test("email invite defaults to maxUses 1 and is single-use", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "member", email: "joiner@test.invalid" },
			"owner",
			db,
			{},
		);
		const [row] = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(row.maxUses).toBe(1);

		await acceptInvite(res.token, "joiner", "joiner@test.invalid", db);
		const [after] = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(after.status).toBe("accepted");
		await expect(
			acceptInvite(res.token, "member", "member@test.invalid", db),
		).rejects.toBeInstanceOf(InviteAcceptError);
	});

	test("explicit maxUses on an email invite is honored", async () => {
		const res = await createInvite(
			{
				workspaceId: "shared",
				role: "member",
				email: "five@test.invalid",
				maxUses: 5,
			},
			"owner",
			db,
			{},
		);
		const [row] = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(row.maxUses).toBe(5);
	});

	test("link (email-null) invite stays reusable (maxUses null)", async () => {
		const res = await createInvite(
			{ workspaceId: "shared", role: "member" },
			"owner",
			db,
			{},
		);
		const [row] = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(row.maxUses).toBeNull();

		await acceptInvite(res.token, "joiner", "joiner@test.invalid", db);
		await acceptInvite(res.token, "member", "member@test.invalid", db);
		const memberships = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.workspaceId, "shared"));
		const joined = memberships.filter(
			(m) => m.userId === "joiner" || m.userId === "member",
		);
		expect(joined).toHaveLength(2);
	});
});

describe("createInvite attach validation", () => {
	test("foreign-task attach is rejected (400)", async () => {
		await expect(
			createInvite(
				{
					workspaceId: "shared",
					role: "member",
					attachTaskId: "other-task",
					attachKind: "assign",
				},
				"admin",
				db,
				{},
			),
		).rejects.toMatchObject({ status: 400 });
	});

	test("attachTaskId without attachKind is rejected (400)", async () => {
		await expect(
			createInvite(
				{ workspaceId: "shared", role: "member", attachTaskId: "shared-task" },
				"admin",
				db,
				{},
			),
		).rejects.toMatchObject({ status: 400 });
	});

	test("same-workspace task attach is accepted", async () => {
		const res = await createInvite(
			{
				workspaceId: "shared",
				role: "member",
				attachTaskId: "shared-task",
				attachKind: "assign",
			},
			"admin",
			db,
			{},
		);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, res.id));
		expect(rows[0].attachTaskId).toBe("shared-task");
		expect(rows[0].attachKind).toBe("assign");
	});
});

describe("acceptInvite", () => {
	async function makeInvite(
		values: Partial<typeof tables.invite.$inferInsert>,
	) {
		const id = crypto.randomUUID();
		const token = `tok-${id}`;
		await db.insert(tables.invite).values({
			id,
			workspaceId: "shared",
			role: "member",
			token,
			status: "pending",
			createdBy: "owner",
			...values,
		});
		return { id, token };
	}

	test("existing user accepts -> membership created", async () => {
		const { token } = await makeInvite({});
		const res = await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		expect(res.workspaceId).toBe("shared");
		const rows = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.userId, "joiner"));
		expect(rows.map((r) => r.workspaceId)).toContain("shared");
		expect(rows.find((r) => r.workspaceId === "shared")?.role).toBe("member");
	});

	test("'assign' attach resolves into a task_assignee row in one tx", async () => {
		const { token } = await makeInvite({
			attachTaskId: "shared-task",
			attachKind: "assign",
		});
		await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		const rows = await db
			.select()
			.from(tables.taskAssignee)
			.where(eq(tables.taskAssignee.id, "shared-task:joiner"));
		expect(rows).toHaveLength(1);
	});

	test("'mention' attach resolves to membership only (no assignee row)", async () => {
		const { token } = await makeInvite({
			attachTaskId: "shared-task",
			attachKind: "mention",
		});
		await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		const rows = await db
			.select()
			.from(tables.taskAssignee)
			.where(eq(tables.taskAssignee.userId, "joiner"));
		expect(rows).toHaveLength(0);
	});

	test("revoked token rejected with reason 'revoked'", async () => {
		const { token } = await makeInvite({ status: "revoked" });
		await expect(
			acceptInvite(token, "joiner", "joiner@test.invalid", db),
		).rejects.toMatchObject({
			reason: "revoked",
		});
	});

	test("expired token rejected with reason 'expired'", async () => {
		const { token } = await makeInvite({
			expiresAt: new Date(Date.now() - 60_000),
		});
		await expect(
			acceptInvite(token, "joiner", "joiner@test.invalid", db),
		).rejects.toMatchObject({
			reason: "expired",
		});
	});

	test("exhausted token rejected with reason 'exhausted'", async () => {
		const { token } = await makeInvite({ maxUses: 1, uses: 1 });
		await expect(
			acceptInvite(token, "joiner", "joiner@test.invalid", db),
		).rejects.toMatchObject({
			reason: "exhausted",
		});
	});

	test("unknown token rejected with reason 'not_found'", async () => {
		await expect(
			acceptInvite("nope", "joiner", "joiner@test.invalid", db),
		).rejects.toMatchObject({
			reason: "not_found",
		});
	});

	test("maxUses:1 -> first use accepts, status flips, second use rejected", async () => {
		const { id, token } = await makeInvite({ maxUses: 1 });
		await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, id));
		expect(rows[0].uses).toBe(1);
		expect(rows[0].status).toBe("accepted");
		await expect(
			acceptInvite(token, "member", "member@test.invalid", db),
		).rejects.toBeInstanceOf(InviteAcceptError);
	});

	test("email invite redeemed by the MATCHING email succeeds", async () => {
		const { token } = await makeInvite({ email: "joiner@test.invalid" });
		const res = await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		expect(res.workspaceId).toBe("shared");
		const rows = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.userId, "joiner"));
		expect(rows.map((r) => r.workspaceId)).toContain("shared");
	});

	test("email invite match is case-insensitive", async () => {
		const { token } = await makeInvite({ email: "Joiner@Test.Invalid" });
		const res = await acceptInvite(token, "joiner", "joiner@test.invalid", db);
		expect(res.workspaceId).toBe("shared");
	});

	test("email invite redeemed by a DIFFERENT email is rejected (email_mismatch)", async () => {
		const { token } = await makeInvite({ email: "someone@test.invalid" });
		await expect(
			acceptInvite(token, "joiner", "joiner@test.invalid", db),
		).rejects.toMatchObject({ reason: "email_mismatch" });
		const rows = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.userId, "joiner"));
		expect(rows).toHaveLength(0);
	});

	test("link (email-null) invite is redeemable by any email", async () => {
		const { token } = await makeInvite({});
		const res = await acceptInvite(token, "member", "member@test.invalid", db);
		expect(res.workspaceId).toBe("shared");
	});
});

describe("previewInvite", () => {
	test("valid pending invite returns only {valid, workspaceName, email}", async () => {
		await db.insert(tables.invite).values({
			id: "prev",
			workspaceId: "shared",
			role: "admin",
			email: "who@test.invalid",
			token: "prev-token",
			status: "pending",
			createdBy: "owner",
		});
		const res = await previewInvite("prev-token", db);
		expect(res).toEqual({
			valid: true,
			workspaceName: "Shared",
			email: "who@test.invalid",
		});
		// no token, role, id, or workspaceId leaked
		expect(Object.keys(res).sort()).toEqual([
			"email",
			"valid",
			"workspaceName",
		]);
		expect(JSON.stringify(res)).not.toContain("prev-token");
		expect(JSON.stringify(res)).not.toContain("admin");
	});

	test("revoked invite previews as {valid:false} with nothing else", async () => {
		await db.insert(tables.invite).values({
			id: "prev2",
			workspaceId: "shared",
			role: "member",
			token: "prev2-token",
			status: "revoked",
			createdBy: "owner",
		});
		expect(await previewInvite("prev2-token", db)).toEqual({ valid: false });
	});

	test("unknown token previews as {valid:false}", async () => {
		expect(await previewInvite("ghost", db)).toEqual({ valid: false });
	});
});

describe("createManagedAccount", () => {
	test("creates a restricted managed_account + membership under @managed.invalid, bypassing the registration gate", async () => {
		// A guardian already exists, so bootstrap mode would normally reject new
		// signups; the bypass inside createManagedAccount is what lets this through.
		const res = await createManagedAccount(
			{
				guardianId: "owner",
				workspaceId: "shared",
				displayName: "Kiddo",
				password: "kid-password-1",
			},
			db,
			auth,
		);
		expect(res.email).toMatch(/^kid\.[0-9a-f-]+@managed\.invalid$/);

		const kid = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.id, res.userId));
		expect(kid).toHaveLength(1);
		expect(kid[0].email).toBe(res.email);

		const managed = await db
			.select()
			.from(tables.managedAccount)
			.where(eq(tables.managedAccount.userId, res.userId));
		expect(managed).toHaveLength(1);
		expect(managed[0].guardianId).toBe("owner");
		expect(managed[0].restricted).toBe(true);

		const memberships = await db
			.select()
			.from(tables.membership)
			.where(eq(tables.membership.userId, res.userId));
		expect(memberships.map((m) => m.workspaceId)).toContain("shared");
	});

	test("a non-member guardian is rejected (403)", async () => {
		await expect(
			createManagedAccount(
				{
					guardianId: "outsider",
					workspaceId: "shared",
					displayName: "Kiddo",
					password: "kid-password-1",
				},
				db,
				auth,
			),
		).rejects.toMatchObject({ status: 403 });
	});

	test("DITERO_MEMBER_INVITES=admin: a member guardian is rejected (403)", async () => {
		await expect(
			createManagedAccount(
				{
					guardianId: "member",
					workspaceId: "shared",
					displayName: "Kiddo",
					password: "kid-password-1",
				},
				db,
				auth,
				{ DITERO_MEMBER_INVITES: "admin" },
			),
		).rejects.toMatchObject({ status: 403 });
	});

	test("DITERO_MEMBER_INVITES=admin: an admin guardian succeeds", async () => {
		const res = await createManagedAccount(
			{
				guardianId: "admin",
				workspaceId: "shared",
				displayName: "Kiddo",
				password: "kid-password-1",
			},
			db,
			auth,
			{ DITERO_MEMBER_INVITES: "admin" },
		);
		expect(res.email).toMatch(/@managed\.invalid$/);
	});

	test("default policy lets a plain member create a kid", async () => {
		const res = await createManagedAccount(
			{
				guardianId: "member",
				workspaceId: "shared",
				displayName: "Kiddo",
				password: "kid-password-1",
			},
			db,
			auth,
			{},
		);
		expect(res.email).toMatch(/@managed\.invalid$/);
	});
});

describe("lookupUsers (email mode)", () => {
	test("exact-email match returns id/name/image and NEVER the email", async () => {
		const res = await lookupUsers("member@test.invalid", "owner", db, {});
		expect(res).toHaveLength(1);
		expect(res[0].id).toBe("member");
		expect(res[0].name).toBe("member");
		expect(Object.keys(res[0]).sort()).toEqual(["id", "image", "name"]);
		expect(JSON.stringify(res)).not.toContain("@test.invalid");
	});

	test("a non-matching email returns empty", async () => {
		expect(await lookupUsers("ghost@test.invalid", "owner", db, {})).toEqual(
			[],
		);
	});

	test("a name (non-email) does not match in email mode", async () => {
		expect(await lookupUsers("member", "owner", db, {})).toEqual([]);
	});
});

describe("lookupUsers (directory mode)", () => {
	const directory = { DITERO_DISCOVERY: "directory" };

	test("returns a co-workspace user by name prefix", async () => {
		const res = await lookupUsers("mem", "owner", db, directory);
		expect(res.map((r) => r.id)).toContain("member");
	});

	test("does NOT return a user who shares no workspace with the caller", async () => {
		// outsider is only in `other`; owner is only in `shared` -> no overlap.
		const res = await lookupUsers("outsi", "owner", db, directory);
		expect(res.map((r) => r.id)).not.toContain("outsider");
	});
});
