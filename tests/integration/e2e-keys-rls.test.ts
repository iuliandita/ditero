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
	"user_key_secret",
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
	// Key-table policies read these ordinary tables. Production's default-table
	// grants already include them; the hand-built non-owner fixture must mirror
	// that or PostgreSQL fails policy planning before evaluating the predicate.
	await pool.query(
		"grant select on membership, workspace to ditero_runtime_test",
	);
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
	`insert into user_key (id, user_id, public_key, state)
	 values ('${id}', '${userId}', 'pk_a', 'ready')`;

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
		//
		// Reads are no longer in this suite FOR user_key: since the secret split
		// its SELECT policy also admits workspace co-members, and Bob is
		// deliberately not one here. The co-member half has its own suite below.
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

// The split's whole justification, asserted rather than assumed: a granter must
// read a co-member's public key to address a WDK wrap to it, and Postgres RLS
// is row-level, so before the split the only policy that could expose the key
// exposed the passphrase wrap beside it -- an offline Argon2id target for
// someone else's passphrase.
describe("user_key is co-member readable, user_key_secret is not", () => {
	beforeEach(async () => {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ('m_bob', 'u_bob', 'ws_alice', 'member')`,
		);
		await asAlice(insertUserKey("uk_alice", "u_alice"));
		await asAlice(
			`insert into user_key_secret (user_key_id, user_id, passphrase_wrapped,
			 recovery_wrapped, passphrase_salt, recovery_salt, format_version)
			 values ('uk_alice', 'u_alice', 'w_a', 'r_a', 's_a', 's_a2', 1)`,
		);
	});

	test("a co-member reads the public key", async () => {
		const theirs = await asBob<{ public_key: string }>(
			"select public_key from user_key where user_id = 'u_alice'",
		);
		expect(theirs.rows[0]?.public_key).toBe("pk_a");
	});

	test("a co-member reads no wrap", async () => {
		const theirs = await asBob(
			"select passphrase_wrapped from user_key_secret where user_id = 'u_alice'",
		);
		expect(theirs.rowCount).toBe(0);
		// Presence half: the owner does read it, so the zero above is the policy
		// and not a table that is empty or a column that does not exist.
		const mine = await asAlice<{ passphrase_wrapped: string }>(
			"select passphrase_wrapped from user_key_secret where user_id = 'u_alice'",
		);
		expect(mine.rows[0]?.passphrase_wrapped).toBe("w_a");
	});

	test("a co-member cannot overwrite the public key", async () => {
		const written = await asBob(
			"update user_key set public_key = 'evil' where user_id = 'u_alice'",
		);
		// Readable is not writable: the read policy is SELECT-only and UPDATE
		// stayed owner-scoped, so a co-member sees the key and cannot move it.
		expect(written.rowCount).toBe(0);
		const after = await asAlice<{ public_key: string }>(
			"select public_key from user_key where user_id = 'u_alice'",
		);
		expect(after.rows[0]?.public_key).toBe("pk_a");
	});

	test("a co-member cannot write a secret row claiming another user", async () => {
		await expect(
			asBob(
				`insert into user_key_secret (user_key_id, user_id, passphrase_wrapped,
				 recovery_wrapped, passphrase_salt, recovery_salt, format_version)
				 values ('uk_evil', 'u_alice', 'w_e', 'r_e', 's_e', 's_e2', 1)`,
			),
		).rejects.toThrow(/row-level security/i);
	});

	test("a stranger reads neither half", async () => {
		await pool.query("delete from membership where id = 'm_bob'");
		const key = await asBob(
			"select public_key from user_key where user_id = 'u_alice'",
		);
		const secret = await asBob(
			"select passphrase_wrapped from user_key_secret where user_id = 'u_alice'",
		);
		expect([key.rowCount, secret.rowCount]).toEqual([0, 0]);
	});
});

// Task 15 widened three policies so a granter can write a row the RECIPIENT
// owns. None of that is exercised by the grant endpoint's own tests: those go
// through the app pool, which connects as a superuser and bypasses RLS
// entirely. Asserted here, under the non-bypassing role, or the widening is
// only as correct as it looks.
describe("grant writes cross the owner boundary under RLS", () => {
	beforeEach(async () => {
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ('m_bob', 'u_bob', 'ws_alice', 'member')`,
		);
	});

	const grantRow = (id: string, grantedBy: string) =>
		`insert into membership_key (id, membership_id, user_id, workspace_id,
		 key_version, enc, ciphertext, recipient_public_key, granted_by)
		 values ('${id}', 'm_bob', 'u_bob', 'ws_alice', 1, 'enc', 'ct', 'pk_b',
		 '${grantedBy}')`;

	test("a co-member writes a wrap the recipient owns", async () => {
		await expect(
			asAlice(grantRow("mk_grant", "u_alice")),
		).resolves.toBeTruthy();
		const theirs = await asBob<{ id: string }>(
			"select id from membership_key where user_id = 'u_bob'",
		);
		expect(theirs.rows[0]?.id).toBe("mk_grant");
	});

	test("a granter cannot attribute the grant to someone else", async () => {
		// granted_by is the only thing tying a row to the person who wrote it.
		// Left unchecked, a substituting granter could sign the delivery with a
		// co-member's name and the audit trail would name the wrong account.
		await expect(asAlice(grantRow("mk_forged", "u_bob"))).rejects.toThrow(
			/row-level security/i,
		);
	});

	test("a non-member writes nothing", async () => {
		await pool.query("delete from membership where id = 'm_bob'");
		await pool.query(
			`insert into membership (id, user_id, workspace_id, role)
			 values ('m_bob', 'u_bob', 'ws_alice', 'member')`,
		);
		await pool.query("delete from membership where id = 'm_alice'");
		await expect(asAlice(grantRow("mk_outsider", "u_alice"))).rejects.toThrow(
			/row-level security/i,
		);
	});

	test("a granter cannot move a wrap after writing it", async () => {
		await asAlice(grantRow("mk_move", "u_alice"));
		const moved = await asAlice(
			"update membership_key set ciphertext = 'evil' where id = 'mk_move'",
		);
		// Create-for-someone is not edit-for-someone: UPDATE stayed owner-only,
		// so a delivered wrap can be refused by its recipient but never swapped
		// underneath them.
		expect(moved.rowCount).toBe(0);
		const after = await asBob<{ ciphertext: string }>(
			"select ciphertext from membership_key where id = 'mk_move'",
		);
		expect(after.rows[0]?.ciphertext).toBe("ct");
	});

	test("a co-member reads and fulfils a request, a stranger does neither", async () => {
		await asBob(
			`insert into key_grant_request (id, membership_id, user_id, workspace_id,
			 requested_version) values ('kgr_1', 'm_bob', 'u_bob', 'ws_alice', 1)`,
		);
		const seen = await asAlice<{ id: string }>(
			"select id from key_grant_request where id = 'kgr_1'",
		);
		expect(seen.rows[0]?.id).toBe("kgr_1");
		const fulfilled = await asAlice(
			"update key_grant_request set state = 'ready' where id = 'kgr_1'",
		);
		expect(fulfilled.rowCount).toBe(1);

		await pool.query("delete from membership where id = 'm_alice'");
		const gone = await asAlice(
			"select id from key_grant_request where id = 'kgr_1'",
		);
		expect(gone.rowCount).toBe(0);
	});

	test("a co-member cannot open a request naming someone else", async () => {
		// Reads and fulfilment widened; creation did not. Otherwise any member
		// could manufacture a request in another member's name and the queue
		// would carry entries nobody asked for.
		await expect(
			asAlice(
				`insert into key_grant_request (id, membership_id, user_id,
				 workspace_id, requested_version)
				 values ('kgr_forged', 'm_bob', 'u_bob', 'ws_alice', 1)`,
			),
		).rejects.toThrow(/row-level security/i);
	});

	test("an own request must name the caller's exact membership tuple", async () => {
		await asAlice(
			`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
			 values ('wk_request_v1', 'ws_alice', 1, 'commit_1', 'u_alice')`,
		);
		await expect(
			asAlice(
				`insert into key_grant_request (id, membership_id, user_id,
				 workspace_id, requested_version)
				 values ('kgr_wrong_seat', 'm_bob', 'u_alice', 'ws_alice', 1)`,
			),
		).rejects.toThrow(/row-level security/i);
		await expect(
			asAlice(
				`insert into key_grant_request (id, membership_id, user_id,
				 workspace_id, requested_version)
				 values ('kgr_own', 'm_alice', 'u_alice', 'ws_alice', 1)`,
			),
		).resolves.toBeTruthy();
	});

	test("an Owner creates the next-version request for an unenrolled member only during rotation", async () => {
		await pool.query(
			"update workspace set rotation_required = true where id = 'ws_alice'",
		);
		await asAlice(
			`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
			 values ('wk_rotation_v2', 'ws_alice', 2, 'commit_2', 'u_alice')`,
		);
		await expect(
			asAlice(
				`insert into key_grant_request (id, membership_id, user_id,
				 workspace_id, requested_version)
				 values ('kgr_rotation', 'm_bob', 'u_bob', 'ws_alice', 2)`,
			),
		).resolves.toBeTruthy();

		await pool.query("delete from key_grant_request where id = 'kgr_rotation'");
		await pool.query(
			"update membership set role = 'member' where id = 'm_alice'",
		);
		await expect(
			asAlice(
				`insert into key_grant_request (id, membership_id, user_id,
				 workspace_id, requested_version)
				 values ('kgr_rotation_member', 'm_bob', 'u_bob', 'ws_alice', 2)`,
			),
		).rejects.toThrow(/row-level security/i);
	});
});
