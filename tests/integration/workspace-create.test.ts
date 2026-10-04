import { randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import type { WorkspaceCreateInput } from "../../src/domain/workspace-create.ts";
import {
	pendingProvisions,
	provisionWorkspace,
} from "../../src/server/e2e/provision.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString });
const role = `workspace_create_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
const runtimeURL = new URL(connectionString);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.href,
	application_name: role,
});
const zdb = zeroNodePg(schema, runtime);
const alice = randomUUID();
const bob = randomUUID();
const tracked: string[] = [];
function input(): WorkspaceCreateInput {
	const args = {
		id: randomUUID(),
		membershipId: randomUUID(),
		name: "Our group",
	};
	tracked.push(args.id);
	return args;
}
function create(args: WorkspaceCreateInput, userId = alice) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, userId, () =>
			mutators.workspace.create.fn({ tx, ctx: { id: userId }, args }),
		),
	);
}
async function count(id: string) {
	return (
		await admin.query("select count(*)::int n from workspace where id=$1", [id])
	).rows[0].n;
}
async function foreign(
	args: WorkspaceCreateInput,
	owner = bob,
	kind = "shared",
) {
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,$4)",
		[args.id, args.name, owner, kind],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[args.membershipId, owner, args.id],
	);
}
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select current_user,session_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([
		{
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
		},
	]);
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values($1,'Alice',$2,true),($3,'Bob',$4,true)`,
		[alice, `${alice}@workspace.test`, bob, `${bob}@workspace.test`],
	);
});
async function clearWorkspaces() {
	await admin.query("delete from membership where workspace_id=any($1)", [
		tracked,
	]);
	await admin.query("delete from workspace where id=any($1)", [tracked]);
}
beforeEach(async () => {
	await clearWorkspaces();
	await admin.query('update "user" set deleted_at=null where id=any($1)', [
		[alice, bob],
	]);
});
afterAll(async () => {
	await clearWorkspaces();
	await admin.query('delete from "user" where id=any($1)', [[alice, bob]]);
	expect(
		(
			await admin.query(
				"select count(*)::int n from workspace where owner_id=any($1)",
				[[alice, bob]],
			)
		).rows[0].n,
	).toBe(0);
	await runtime.end();
	expect(
		(
			await admin.query(
				"select count(*)::int n from pg_stat_activity where usename=$1",
				[role],
			)
		).rows[0].n,
	).toBe(0);
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});

test("fresh creation atomically owns its shared workspace and trigger projection", async () => {
	const args = input();
	await create(args);
	expect(
		(
			await admin.query(
				"select owner_id,kind,rotation_required from workspace where id=$1",
				[args.id],
			)
		).rows,
	).toEqual([{ owner_id: alice, kind: "shared", rotation_required: false }]);
	expect(
		(
			await admin.query(
				"select id,user_id,workspace_id,role from membership where id=$1",
				[args.membershipId],
			)
		).rows,
	).toEqual([
		{
			id: args.membershipId,
			user_id: alice,
			workspace_id: args.id,
			role: "owner",
		},
	]);
	expect(
		(
			await withUserContext(runtime, alice, (c) =>
				c.query(
					"select workspace_id from workspace_access_scope where workspace_id=$1",
					[args.id],
				),
			)
		).rows,
	).toHaveLength(1);
	expect(
		(
			await withUserContext(runtime, bob, (c) =>
				c.query(
					"select workspace_id from workspace_access_scope where workspace_id=$1",
					[args.id],
				),
			)
		).rows,
	).toHaveLength(0);
});
test("a viewer elsewhere can own a separate shared workspace without changing personal scope", async () => {
	const other = input();
	await foreign(other);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'viewer')",
		[randomUUID(), alice, other.id],
	);
	const personal = input();
	await foreign(personal, alice, "personal");
	const args = input();
	await create(args);
	expect(await count(args.id)).toBe(1);
	expect(
		(await admin.query("select kind from workspace where id=$1", [personal.id]))
			.rows[0].kind,
	).toBe("personal");
});
test("complete replay after lost response preserves rotation and key/member state", async () => {
	const args = input();
	await create(args);
	await admin.query("update workspace set rotation_required=true where id=$1", [
		args.id,
	]);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'viewer')",
		[randomUUID(), bob, args.id],
	);
	const before = (
		await admin.query(
			"select row_to_json(w) value from workspace w where id=$1",
			[args.id],
		)
	).rows;
	await create(args);
	expect(
		(
			await admin.query(
				"select row_to_json(w) value from workspace w where id=$1",
				[args.id],
			)
		).rows,
	).toEqual(before);
	expect(
		(
			await admin.query(
				"select count(*)::int n from membership where workspace_id=$1",
				[args.id],
			)
		).rows[0].n,
	).toBe(2);
});
test.each([
	"foreign",
	"name",
	"personal",
	"seat-role",
	"seat-id",
	"incomplete",
])("refuses existing %s without repair", async (kind) => {
	const args = input();
	await foreign(
		args,
		kind === "foreign" ? bob : alice,
		kind === "personal" ? "personal" : "shared",
	);
	if (kind === "seat-role")
		await admin.query("update membership set role='member' where id=$1", [
			args.membershipId,
		]);
	if (kind === "incomplete")
		await admin.query("delete from membership where id=$1", [
			args.membershipId,
		]);
	const submitted = {
		...args,
		...(kind === "name" ? { name: "Changed" } : {}),
		...(kind === "seat-id" ? { membershipId: randomUUID() } : {}),
	};
	const before = (
		await admin.query(
			"select row_to_json(w) value from workspace w where id=$1",
			[args.id],
		)
	).rows;
	await expect(create(submitted)).rejects.toThrow("conflicts");
	expect(
		(
			await admin.query(
				"select row_to_json(w) value from workspace w where id=$1",
				[args.id],
			)
		).rows,
	).toEqual(before);
});
test("foreign membership primary key refuses and leaves no new workspace", async () => {
	const other = input();
	await foreign(other);
	const args = input();
	args.membershipId = other.membershipId;
	await expect(create(args)).rejects.toThrow("conflicts");
	expect(await count(args.id)).toBe(0);
});
test("cross-actor chosen workspace collision admits exactly one owner", async () => {
	const args = input();
	const results = await Promise.allSettled([
		create(args),
		create({ ...args, membershipId: randomUUID() }, bob),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(
		(
			await admin.query(
				"select count(*)::int n from membership where workspace_id=$1",
				[args.id],
			)
		).rows[0].n,
	).toBe(1);
});
test("cross-actor membership collision rolls back losing workspace after insert", async () => {
	const first = input();
	const second = input();
	second.membershipId = first.membershipId;
	const results = await Promise.allSettled([
		create(first),
		create(second, bob),
	]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect((await count(first.id)) + (await count(second.id))).toBe(1);
});
test("tombstoned actor waiting for its account lock cannot create", async () => {
	const args = input();
	const lock = await admin.connect();
	await lock.query("begin");
	await lock.query('select id from "user" where id=$1 for update', [alice]);
	const pending = create(args);
	const refusal = expect(pending).rejects.toThrow("active");
	try {
		await vi.waitFor(
			async () =>
				expect(
					(
						await admin.query(
							"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
							[role],
						)
					).rows[0].n,
				).toBeGreaterThan(0),
			{ timeout: 1500, interval: 10 },
		);
		await lock.query('update "user" set deleted_at=now() where id=$1', [alice]);
		await lock.query("commit");
		await refusal;
		expect(await count(args.id)).toBe(0);
	} finally {
		await lock.query("rollback");
		lock.release();
	}
});
test("existing key provisioning discovers the new owner and keeps key rows isolated", async () => {
	const args = input();
	await create(args);
	await withUserContext(runtime, alice, async (c) => {
		await c.query(
			"insert into user_key(id,user_id,public_key,state) values($1,$2,'test-public-key','ready')",
			[randomUUID(), alice],
		);
		expect(
			(await pendingProvisions(c, alice)).some((row) => row.id === args.id),
		).toBe(true);
		expect(
			await provisionWorkspace(c, alice, {
				workspaceId: args.id,
				recipientPublicKey: "test-public-key",
				commitment: "test-commitment",
				enc: "test-enc",
				ciphertext: "test-ciphertext",
			}),
		).toMatchObject({ ok: true, outcome: "minted" });
		expect(
			(
				await c.query("select id from workspace_key where workspace_id=$1", [
					args.id,
				])
			).rows,
		).toHaveLength(1);
		expect(
			(
				await c.query("select id from membership_key where workspace_id=$1", [
					args.id,
				])
			).rows,
		).toHaveLength(1);
	});
	await withUserContext(runtime, bob, async (c) => {
		expect(
			(await pendingProvisions(c, bob)).some((row) => row.id === args.id),
		).toBe(false);
		expect(
			(
				await c.query("select id from workspace_key where workspace_id=$1", [
					args.id,
				])
			).rows,
		).toHaveLength(0);
		expect(
			(
				await c.query("select id from membership_key where workspace_id=$1", [
					args.id,
				])
			).rows,
		).toHaveLength(0);
		expect(
			await provisionWorkspace(c, bob, {
				workspaceId: args.id,
				recipientPublicKey: "test-public-key",
				commitment: "test-commitment",
				enc: "test-enc",
				ciphertext: "test-ciphertext",
			}),
		).toEqual({ ok: false, reason: "not-permitted" });
	});
});
test("late foreign membership collision reaches insert and rolls back workspace", async () => {
	const other = input();
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,$2,$3,'shared')",
		[other.id, other.name, bob],
	);
	const args = input();
	const blocker = await admin.connect();
	await blocker.query("begin");
	await blocker.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
		[args.membershipId, bob, other.id],
	);
	const pending = create(args);
	const outcome = pending.then(
		() => null,
		(error: unknown) => error,
	);
	try {
		await vi.waitFor(
			async () => {
				const waiting = await admin.query(
					"select query from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
					[role],
				);
				expect(
					waiting.rows.some(
						(row) =>
							row.query.includes("membership") &&
							row.query.toLowerCase().includes("insert"),
					),
				).toBe(true);
			},
			{ timeout: 1500, interval: 10 },
		);
		await blocker.query("commit");
		expect(await outcome).toBeInstanceOf(Error);
		expect(String(await outcome)).toContain("conflicts");
		expect(await count(args.id)).toBe(0);
	} finally {
		await blocker.query("rollback");
		blocker.release();
		await outcome;
	}
});
