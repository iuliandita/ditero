import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { acceptInvite } from "../../src/auth/invite-accept.ts";
import { emailHasRedeemableInvite } from "../../src/auth/invite-bypass.ts";
import { createInvite } from "../../src/auth/invite-create.ts";
import {
	claimFastInvite,
	finalizeFastInvite,
} from "../../src/auth/invite-fast-path.ts";
import * as tables from "../../src/db/schema.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(admin, { schema: tables });
const restricted = drizzle(runtime, { schema: tables });
const zero = zeroNodePg(schema, runtime);

beforeAll(async () => {
	await admin.query(
		"create role invite_authority_test nosuperuser nobypassrls",
	);
	await admin.query("grant usage on schema public to invite_authority_test");
	await admin.query(
		"grant select,insert,update,delete on all tables in schema public to invite_authority_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role invite_authority_test");
	});
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email) values
		('owner','Owner','owner@example.test'), ('creator','Creator','creator@example.test'),
		('joiner','Joiner','joiner@example.test')`);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values ('ws','Shared','owner','shared')",
	);
	await admin.query(`insert into membership(id,user_id,workspace_id,role) values
		('mo','owner','ws','owner'),('mc','creator','ws','admin')`);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values ('list','ws','owner','List','a0')",
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values ('task','list','Task','a0')",
	);
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,active,minted_by) values ('wk','ws',1,$1,true,'owner')",
		["a".repeat(64)],
	);
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query("drop owned by invite_authority_test");
	await admin.query("drop role invite_authority_test");
	await admin.end();
});

async function make(
	role: "owner" | "admin" | "member" = "admin",
	attached = false,
	fast = false,
) {
	return createInvite(
		{
			workspaceId: "ws",
			role,
			...(attached
				? { attachTaskId: "task", attachKind: "assign" as const }
				: {}),
			...(fast
				? {
						email: "joiner@example.test",
						maxUses: 1,
						expiresAt: Date.now() + 600_000,
					}
				: {}),
		},
		"creator",
		db,
		{},
	);
}
async function change(
	next: "owner" | "member" | "viewer" | "remove" | "leave",
) {
	if (next === "leave")
		return zero.transaction((tx) =>
			withZeroUserContext(tx, "creator", () =>
				mutators.membership.leave.fn({
					tx,
					ctx: { id: "creator" },
					args: { id: "mc" },
				}),
			),
		);

	return zero.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			next === "remove"
				? mutators.membership.remove.fn({
						tx,
						ctx: { id: "owner" },
						args: { id: "mc" },
					})
				: mutators.membership.setRole.fn({
						tx,
						ctx: { id: "owner" },
						args: { id: "mc", role: next },
					}),
		),
	);
}

// Direct changes model old pending rows; mutator checks below prove proactive cleanup.
test.each([
	false,
	true,
])("legacy redemption rechecks creator authority (attached=%s)", async (attached) => {
	const inv = await make("admin", attached);
	await admin.query("update membership set role='member' where id='mc'");
	await expect(
		acceptInvite(inv.token, "joiner", "joiner@example.test", restricted),
	).rejects.toMatchObject({ reason: "not_found" });
	expect(
		(await admin.query("select id from membership where user_id='joiner'"))
			.rows,
	).toEqual([]);
	expect(
		(await admin.query("select uses from invite where id=$1", [inv.id])).rows[0]
			.uses,
	).toBe(0);
});

test.each([
	false,
	true,
])("new fragment claims recheck creator membership (attached=%s)", async (attached) => {
	const inv = await make("member", attached, true);
	await admin.query("delete from membership where id='mc'");
	await expect(
		claimFastInvite(runtime, inv.token, "joiner", "joiner@example.test"),
	).rejects.toMatchObject({ reason: "not_found" });
	expect(
		(await admin.query("select id from membership where user_id='joiner'"))
			.rows,
	).toEqual([]);
	expect(
		(await admin.query("select claimed_by from invite where id=$1", [inv.id]))
			.rows[0].claimed_by,
	).toBeNull();
});

test.each([
	"member",
	"viewer",
	"remove",
	"leave",
] as const)("membership %s revokes only unclaimed grants beyond the new authority", async (next) => {
	const high = await make();
	const low = await make("member");
	const reserved = await make("member", false, true);
	await claimFastInvite(
		runtime,
		reserved.token,
		"joiner",
		"joiner@example.test",
	);
	await change(next);
	const rows = (await admin.query("select id,status from invite")).rows;
	expect(rows.find((row) => row.id === high.id).status).toBe("revoked");
	expect(rows.find((row) => row.id === low.id).status).toBe(
		next === "member" ? "pending" : "revoked",
	);
	expect(rows.find((row) => row.id === reserved.id).status).toBe("pending");
	await expect(
		claimFastInvite(runtime, reserved.token, "joiner", "joiner@example.test"),
	).resolves.toMatchObject({ inviteId: reserved.id });
	await expect(
		finalizeFastInvite(runtime, reserved.token, "joiner", "fallback"),
	).resolves.toMatchObject({ workspaceId: "ws" });
});

test("owner grants and tightened member-invite policy use current creator authority", async () => {
	await admin.query("update membership set role='owner' where id='mc'");
	const inv = await make("owner");
	await admin.query("update membership set role='admin' where id='mc'");
	await expect
		.soft(acceptInvite(inv.token, "joiner", "joiner@example.test", restricted))
		.rejects.toMatchObject({ reason: "not_found" });
	const member = await make("member");
	await admin.query("update membership set role='member' where id='mc'");
	const previous = process.env.DITERO_MEMBER_INVITES;
	process.env.DITERO_MEMBER_INVITES = "admin";
	try {
		await expect
			.soft(
				acceptInvite(member.token, "joiner", "joiner@example.test", restricted),
			)
			.rejects.toMatchObject({ reason: "not_found" });
	} finally {
		if (previous === undefined) delete process.env.DITERO_MEMBER_INVITES;
		else process.env.DITERO_MEMBER_INVITES = previous;
	}
});

test("email creation normalizes casing and old mixed-case addresses still match", async () => {
	const inv = await createInvite(
		{ workspaceId: "ws", role: "member", email: "Joiner@Example.Test" },
		"creator",
		db,
		{},
	);
	expect
		.soft(
			(
				await admin.query("select email,max_uses from invite where id=$1", [
					inv.id,
				])
			).rows[0],
		)
		.toEqual({ email: "joiner@example.test", max_uses: 1 });
	await admin.query(
		"update invite set email='Joiner@Example.Test' where id=$1",
		[inv.id],
	);
	expect
		.soft(await emailHasRedeemableInvite("joiner@example.test", db, Date.now()))
		.toBe(true);
	expect
		.soft(await emailHasRedeemableInvite("JOINER@EXAMPLE.TEST", db, Date.now()))
		.toBe(true);
	expect
		.soft(await emailHasRedeemableInvite("other@example.test", db, Date.now()))
		.toBe(false);
});

test.each([
	{ maxUses: 0 },
	{ maxUses: -1 },
	{ maxUses: 1.5 },
	{ maxUses: 32768 },
	{ maxUses: Number.NaN },
	{ expiresAt: 0 },
	{ expiresAt: -1 },
	{ expiresAt: Date.now() - 1 },
	{ expiresAt: 8_640_000_000_000_001 },
	{ expiresAt: Number.NaN },
])("invalid invite fields return 400 without a row: %j", async (fields) => {
	await expect(
		createInvite(
			{ workspaceId: "ws", role: "member", ...fields },
			"creator",
			db,
			{},
		),
	).rejects.toMatchObject({ status: 400 });
	expect((await admin.query("select id from invite")).rows).toEqual([]);
});

test("promotion from admin to owner preserves pending invitations", async () => {
	const high = await make();
	const low = await make("member");
	await change("owner");
	expect(
		(await admin.query("select status from invite order by id")).rows,
	).toEqual([{ status: "pending" }, { status: "pending" }]);
	await expect(
		acceptInvite(high.token, "joiner", "joiner@example.test", restricted),
	).resolves.toMatchObject({ workspaceId: "ws" });
	expect(
		(await admin.query("select status from invite where id=$1", [low.id]))
			.rows[0].status,
	).toBe("pending");
});

test.each([
	[false, "fallback"],
	[true, "fallback"],
	[false, "fast"],
	[true, "fast"],
] as const)("removed invitee cannot finalize or consume its reservation (attached=%s, mode=%s)", async (attached, mode) => {
	const inv = await make("member", attached, true);
	await claimFastInvite(runtime, inv.token, "joiner", "joiner@example.test");
	const member = (
		await admin.query(
			"select id from membership where user_id='joiner' and workspace_id='ws'",
		)
	).rows[0];
	await zero.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.membership.remove.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: member.id },
			}),
		),
	);
	await expect
		.soft(finalizeFastInvite(runtime, inv.token, "joiner", mode))
		.rejects.toMatchObject({ reason: "not_found" });
	expect
		.soft(
			(
				await admin.query("select status,uses from invite where id=$1", [
					inv.id,
				])
			).rows,
		)
		.toEqual([{ status: "pending", uses: 0 }]);
	expect
		.soft(
			(await admin.query("select id from task_assignee where user_id='joiner'"))
				.rows,
		)
		.toEqual([]);
	expect
		.soft(
			(
				await admin.query(
					"select id from membership where user_id='joiner' and workspace_id='ws'",
				)
			).rows,
		)
		.toEqual([]);
});

test.each([
	[undefined, 1],
	[null, null],
	[3, 3],
] as const)("email invite cap preserves omitted/default and explicit values (%s)", async (maxUses, expected) => {
	const inv = await createInvite(
		{
			workspaceId: "ws",
			role: "member",
			email: "joiner@example.test",
			maxUses,
		},
		"creator",
		db,
		{},
	);
	expect(
		(await admin.query("select max_uses from invite where id=$1", [inv.id]))
			.rows[0].max_uses,
	).toBe(expected);
});

test.each([
	"revoke",
	"redeem",
] as const)("concurrent revocation and redemption preserve the first committed outcome (%s first)", async (first) => {
	const inv = await make("member");
	const holder = await admin.connect();
	let redeem: Promise<unknown> | undefined;
	let revoke: Promise<unknown> | undefined;
	const redeemOperation = () =>
		acceptInvite(inv.token, "joiner", "joiner@example.test", restricted).then(
			() => "accepted",
			(error: unknown) => error,
		);
	const revokeOperation = () =>
		zero.transaction((tx) =>
			withZeroUserContext(tx, "owner", () =>
				mutators.invite.revoke.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: inv.id },
				}),
			),
		);
	async function waiting(count: number) {
		await vi.waitFor(
			async () => {
				expect(
					(
						await admin.query(`select pid from pg_stat_activity
				where datname=current_database() and cardinality(pg_blocking_pids(pid))>0
				and query ilike '%invite%'`)
					).rows,
				).toHaveLength(count);
			},
			{ timeout: 5000 },
		);
	}
	try {
		await holder.query("begin");
		await holder.query("select id from invite where id=$1 for update", [
			inv.id,
		]);
		if (first === "revoke") revoke = revokeOperation();
		else redeem = redeemOperation();
		await waiting(1);
		if (first === "revoke") redeem = redeemOperation();
		else revoke = revokeOperation();
		await waiting(2);
		await holder.query("commit");
		expect(await redeem).toEqual(
			first === "revoke"
				? expect.objectContaining({ reason: "revoked" })
				: "accepted",
		);
		await revoke;
		expect(
			(
				await admin.query("select uses,status from invite where id=$1", [
					inv.id,
				])
			).rows,
		).toEqual([{ uses: first === "revoke" ? 0 : 1, status: "revoked" }]);
		expect(
			(
				await admin.query(
					"select id from membership where user_id='joiner' and workspace_id='ws'",
				)
			).rows,
		).toHaveLength(first === "revoke" ? 0 : 1);
	} finally {
		await holder.query("rollback");
		holder.release();
		await Promise.allSettled(
			[redeem, revoke].filter((promise) => promise !== undefined),
		);
	}
});
