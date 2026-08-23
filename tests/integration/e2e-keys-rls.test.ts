import { Pool, type QueryResultRow } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import zeroConfig from "../../drizzle-zero.config.ts";
import { withUserContext } from "../../src/db/user-context.ts";

// M-E2E Task 7. The key tables are backend-owned and must never be readable
// across users, so isolation is asserted the way 0004 established it: through a
// NON-OWNER role. A table owner bypasses RLS unless FORCE is set, so running
// these as the migration owner would pass against a table with no policy at
// all -- the exact vacuous shape this repo keeps hitting.
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const runtimePool = new Pool({ connectionString: databaseURL });

const KEY_TABLES = [
	"user_key",
	"workspace_key",
	"membership_key",
	"key_grant_request",
	"user_device",
] as const;

beforeAll(async () => {
	await pool.query(`do $$
	begin
		if not exists (select from pg_roles where rolname = 'ditero_runtime_test') then
			create role ditero_runtime_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await pool.query("grant usage on schema public to ditero_runtime_test");
	for (const table of KEY_TABLES) {
		await pool.query(
			`grant select, insert, update, delete on ${table} to ditero_runtime_test`,
		);
	}
	// workspace_key's policy reads membership, so the querying role needs it.
	await pool.query("grant select on membership to ditero_runtime_test");
	runtimePool.on("connect", (client) => {
		void client.query("set role ditero_runtime_test");
	});
});

// Deleting the users cascades into every key table. A direct delete would not:
// FORCE RLS applies to the owner too, and with no ditero.user_id set the policy
// evaluates NULL and silently deletes nothing.
beforeEach(async () => {
	await pool.query("delete from membership");
	await pool.query("delete from workspace");
	await pool.query('delete from "user"');
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values
		 ('u_alice', 'Alice', 'alice@keys.test', true, now(), now()),
		 ('u_bob', 'Bob', 'bob@keys.test', true, now(), now())`,
	);
	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ('ws_alice', 'Alice space', 'u_alice', 'personal')`,
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role)
		 values ('m_alice', 'u_alice', 'ws_alice', 'owner')`,
	);
});

afterAll(async () => {
	await runtimePool.end();
	await pool.end();
});

const asAlice = <T extends QueryResultRow>(sql: string, values?: unknown[]) =>
	withUserContext(runtimePool, "u_alice", (c) => c.query<T>(sql, values));
const asBob = <T extends QueryResultRow>(sql: string, values?: unknown[]) =>
	withUserContext(runtimePool, "u_bob", (c) => c.query<T>(sql, values));

// Each builder writes one row for `userId` under `id`. Parameterised rather
// than fixed so the isolation test can claim ANOTHER user's id explicitly: an
// `insert ... select` reads zero rows under Bob's policy and then inserts
// nothing, succeeding without ever reaching the WITH CHECK clause.
const insertUserKey = (id: string, userId: string) =>
	`insert into user_key (id, user_id, public_key, passphrase_wrapped, recovery_wrapped,
	 passphrase_salt, recovery_salt, format_version, state)
	 values ('${id}', '${userId}', 'pk_a', 'w_a', 'r_a', 's_a', 's_a2', 1, 'ready')`;

const insertMembershipKey = (id: string, userId: string) =>
	`insert into membership_key (id, membership_id, user_id, workspace_id, key_version,
	 enc, ciphertext, recipient_public_key, granted_by)
	 values ('${id}', 'm_alice', '${userId}', 'ws_alice', ${version(id)},
	 'enc_a', 'ct_a', 'pk_a', 'u_alice')`;

const insertGrantRequest = (id: string, userId: string) =>
	`insert into key_grant_request (id, membership_id, user_id, workspace_id, requested_version)
	 values ('${id}', 'm_alice', '${userId}', 'ws_alice', ${version(id)})`;

const insertUserDevice = (id: string, userId: string) =>
	`insert into user_device (id, user_id, label)
	 values ('${id}', '${userId}', 'Alice laptop')`;

// membership_key and key_grant_request are unique per (membership, version), so
// a second row in one test needs its own version or it fails on the constraint
// instead of the policy -- which would pass the test for the wrong reason.
function version(id: string): number {
	return id.endsWith("_evil") ? 2 : 1;
}

// The four user-scoped tables share one policy shape, so they share one suite:
// a per-table copy would drift, and the differences that matter (the columns)
// live in the builders above.
const USER_SCOPED = [
	{
		table: "user_key",
		id: "uk_alice",
		column: "public_key",
		insert: insertUserKey,
	},
	{
		table: "membership_key",
		id: "mk_alice",
		column: "ciphertext",
		insert: insertMembershipKey,
	},
	{
		table: "key_grant_request",
		id: "kgr_alice",
		column: "failure_reason",
		insert: insertGrantRequest,
	},
	{
		table: "user_device",
		id: "ud_alice",
		column: "label",
		insert: insertUserDevice,
	},
] as const;

describe.each(USER_SCOPED)("$table is user-isolated", ({
	table,
	id,
	column,
	insert,
}) => {
	beforeEach(() => asAlice(insert(id, "u_alice")));

	test("another user reads no row", async () => {
		const theirs = await asBob(
			`select id from ${table} where user_id = 'u_alice'`,
		);
		expect(theirs.rowCount).toBe(0);
		// Presence assertion: the row exists and the query can find it, so the
		// zero above is isolation rather than a broken fixture.
		const mine = await asAlice(
			`select id from ${table} where user_id = 'u_alice'`,
		);
		expect(mine.rowCount).toBe(1);
	});

	test("another user overwrites no row", async () => {
		const written = await asBob(
			`update ${table} set ${column} = 'evil' where id = '${id}'`,
		);
		expect(written.rowCount).toBe(0);
		const after = await asAlice(
			`select ${column} as v from ${table} where id = '${id}'`,
		);
		expect(after.rows[0]).not.toBe("evil");
	});

	test("an insert claiming another user id is refused", async () => {
		await expect(asBob(insert(`${table}_evil`, "u_alice"))).rejects.toThrow(
			/row-level security/i,
		);
		// The presence half is beforeEach: it runs this same builder as Alice and
		// every test in the suite depends on that row, so a malformed insert
		// could not reach this assertion. A second insert here cannot serve that
		// purpose anyway -- user_key_active is unique on user_id where retired_at
		// is null, so a user has at most one LIVE identity and the builder writes
		// live rows.
	});
});

describe("workspace_key is membership-scoped", () => {
	beforeEach(async () => {
		await asAlice(
			`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
			 values ('wk_1', 'ws_alice', 1, 'commit_1', 'u_alice')`,
		);
	});

	test("a non-member reads no row", async () => {
		const theirs = await asBob(
			"select id from workspace_key where workspace_id = 'ws_alice'",
		);
		expect(theirs.rowCount).toBe(0);
		const mine = await asAlice(
			"select id from workspace_key where workspace_id = 'ws_alice'",
		);
		expect(mine.rowCount).toBe(1);
	});

	test("a member added later reads the row", async () => {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ('m_bob', 'u_bob', 'ws_alice', 'member')`,
		);
		const theirs = await asBob(
			"select id from workspace_key where workspace_id = 'ws_alice'",
		);
		expect(theirs.rowCount).toBe(1);
	});

	test("a non-member mints no version", async () => {
		await expect(
			asBob(
				`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
				 values ('wk_evil', 'ws_alice', 2, 'commit_evil', 'u_bob')`,
			),
		).rejects.toThrow(/row-level security/i);
	});
});

test("no key table is exposed to Zero", () => {
	const exposed = Object.keys(zeroConfig.tables ?? {});
	for (const table of [
		"userKey",
		"workspaceKey",
		"membershipKey",
		"keyGrantRequest",
		"userDevice",
	]) {
		expect(exposed).not.toContain(table);
	}
	// Presence assertion: the allowlist is populated, so the absences mean
	// something. Without it this passes against an empty config.
	expect(exposed).toContain("task");
});
