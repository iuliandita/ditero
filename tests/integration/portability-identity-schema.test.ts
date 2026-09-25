import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import zeroConfig from "../../drizzle-zero.config.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = "ditero_portability_identity_test";
const userId = "portability-identity-live-user";

async function asRuntime<T>(
	caller: string | null,
	query: (client: PoolClient) => Promise<T>,
	readOnly = false,
): Promise<T> {
	const client = await runtime.connect();
	try {
		await client.query(`set role ${role}`);
		await client.query("begin");
		if (caller !== null)
			await client.query("select set_config('ditero.user_id', $1, true)", [
				caller,
			]);
		if (readOnly) await client.query("set transaction read only");
		const result = await query(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		await client.query("reset role");
		client.release();
	}
}

beforeAll(async () => {
	await admin.query(`do $$ begin
		if not exists (select from pg_roles where rolname = '${role}') then
			create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(`grant select on "user" to ${role}`);
	// Grant every operation so a denied write proves the RLS policy, not a
	// missing table privilege in this test fixture.
	await admin.query(
		`grant select, insert, update, delete on portability_identity to ${role}`,
	);
	await admin.query(
		`insert into "user" (id,name,email,email_verified,created_at,updated_at)
		 values ($1,'Identity fixture','portability-identity@example.test',false,now(),now())`,
		[userId],
	);
});

afterAll(async () => {
	try {
		await admin.query('delete from "user" where id = $1', [userId]);
	} finally {
		await runtime.end();
		await admin.end();
	}
});

test("migration seeds one stable UUID before a read-only export", async () => {
	const seeded = await admin.query<{ id: number; namespace: string }>(
		"select id, namespace from portability_identity",
	);
	expect(seeded.rows).toHaveLength(1);
	expect(seeded.rows[0]?.id).toBe(1);
	expect(seeded.rows[0]?.namespace).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	const read = () =>
		asRuntime(
			userId,
			(client) =>
				client.query<{ namespace: string }>(
					"select namespace from portability_identity",
				),
			true,
		);
	expect((await read()).rows[0]?.namespace).toBe(seeded.rows[0]?.namespace);
	expect((await read()).rows[0]?.namespace).toBe(seeded.rows[0]?.namespace);
});

test("FORCE RLS permits only a live user context to read", async () => {
	const policy = await admin.query<{
		relrowsecurity: boolean;
		relforcerowsecurity: boolean;
	}>(
		"select relrowsecurity, relforcerowsecurity from pg_class where oid = 'portability_identity'::regclass",
	);
	expect(policy.rows[0]).toEqual({
		relrowsecurity: true,
		relforcerowsecurity: true,
	});
	for (const caller of [null, "missing-portability-user"]) {
		const rows = await asRuntime(caller, (client) =>
			client.query("select namespace from portability_identity"),
		);
		expect(rows.rowCount).toBe(0);
	}
	await admin.query('update "user" set deleted_at = now() where id = $1', [
		userId,
	]);
	try {
		const rows = await asRuntime(userId, (client) =>
			client.query("select namespace from portability_identity"),
		);
		expect(rows.rowCount).toBe(0);
	} finally {
		await admin.query('update "user" set deleted_at = null where id = $1', [
			userId,
		]);
	}
});

test("runtime cannot insert, update, or delete the singleton", async () => {
	await expect(
		asRuntime(userId, (client) =>
			client.query(
				"insert into portability_identity (id, namespace) values (1, gen_random_uuid())",
			),
		),
	).rejects.toThrow(/row-level security/i);
	for (const statement of [
		"update portability_identity set namespace = gen_random_uuid() where id = 1",
		"delete from portability_identity where id = 1",
	]) {
		const result = await asRuntime(userId, (client) => client.query(statement));
		expect(result.rowCount).toBe(0);
	}
	const rows = await admin.query("select id from portability_identity");
	expect(rows.rows).toHaveLength(1);
});

test("singleton constraint and Zero allowlist exclude extra identities", async () => {
	await expect(
		admin.query(
			"insert into portability_identity (id, namespace) values (2, gen_random_uuid())",
		),
	).rejects.toThrow(/portability_identity_singleton/);
	const exposed = Object.keys(zeroConfig.tables ?? {});
	expect(exposed).toContain("task");
	expect(exposed).not.toContain("portabilityIdentity");
});
