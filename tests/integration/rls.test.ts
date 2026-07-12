import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import { createFieldKeyRing } from "../../src/security/field-encryption.ts";
import {
	getUserSecret,
	putUserSecret,
} from "../../src/security/user-secret-store.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const runtimePool = new Pool({ connectionString: databaseURL });
const oldRing = createFieldKeyRing({
	current: Buffer.alloc(32, 10).toString("base64"),
});
const rotatingRing = createFieldKeyRing({
	current: Buffer.alloc(32, 10).toString("base64"),
	next: Buffer.alloc(32, 11).toString("base64"),
});

beforeAll(async () => {
	await pool.query(`do $$
	begin
		if not exists (select from pg_roles where rolname = 'ditero_runtime_test') then
			create role ditero_runtime_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await pool.query("grant usage on schema public to ditero_runtime_test");
	await pool.query(
		"grant select, insert, update, delete on user_secret to ditero_runtime_test",
	);
	runtimePool.on("connect", (client) => {
		void client.query("set role ditero_runtime_test");
	});
});

beforeEach(async () => {
	await pool.query("delete from task");
	await pool.query("delete from list");
	await pool.query("delete from membership");
	await pool.query("delete from workspace");
	await pool.query("delete from user_secret");
	await pool.query("delete from session");
	await pool.query("delete from account");
	await pool.query('delete from "user"');
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values
		 ('user-a', 'A', 'a@rls.test', true, now(), now()),
		 ('user-b', 'B', 'b@rls.test', true, now(), now())`,
	);
});

afterAll(async () => {
	await runtimePool.end();
	await pool.end();
});

describe("backend-owned secret isolation", () => {
	test("forces request-local RLS for reads and writes", async () => {
		await withUserContext(runtimePool, "user-a", (client) =>
			putUserSecret(
				client,
				{
					id: "secret-a",
					userId: "user-a",
					kind: "webhook",
					plaintext: "user-a-secret",
				},
				oldRing,
			),
		);

		await expect(
			withUserContext(runtimePool, "user-a", (client) =>
				putUserSecret(
					client,
					{
						id: "secret-b",
						userId: "user-b",
						kind: "webhook",
						plaintext: "user-b-secret",
					},
					oldRing,
				),
			),
		).rejects.toThrow(/row-level security/i);

		await expect(
			withUserContext(runtimePool, "user-a", (client) =>
				getUserSecret(client, "user-b", "webhook", oldRing),
			),
		).resolves.toBeNull();
		await expect(
			withUserContext(runtimePool, "user-a", (client) =>
				getUserSecret(client, "user-a", "webhook", oldRing),
			),
		).resolves.toBe("user-a-secret");

		const stored = await pool.query<{ ciphertext: string }>(
			"select ciphertext from user_secret where id = 'secret-a'",
		);
		expect(stored.rows[0].ciphertext).toMatch(/^ditero:v1:/);
		expect(stored.rows[0].ciphertext).not.toContain("user-a-secret");
	});

	test("rotates ciphertext on a successful read", async () => {
		await withUserContext(runtimePool, "user-a", (client) =>
			putUserSecret(
				client,
				{
					id: "secret-a",
					userId: "user-a",
					kind: "telegram",
					plaintext: "token",
				},
				oldRing,
			),
		);
		const before = await pool.query<{ key_fingerprint: string }>(
			"select key_fingerprint from user_secret where id = 'secret-a'",
		);

		await expect(
			withUserContext(runtimePool, "user-a", (client) =>
				getUserSecret(client, "user-a", "telegram", rotatingRing),
			),
		).resolves.toBe("token");
		const after = await pool.query<{ key_fingerprint: string }>(
			"select key_fingerprint from user_secret where id = 'secret-a'",
		);
		expect(after.rows[0].key_fingerprint).not.toBe(
			before.rows[0].key_fingerprint,
		);
	});

	test("is forced and excluded from the Zero schema", async () => {
		const table = await pool.query<{
			relrowsecurity: boolean;
			relforcerowsecurity: boolean;
		}>(
			`select relrowsecurity, relforcerowsecurity
			 from pg_class where oid = 'user_secret'::regclass`,
		);
		expect(table.rows[0]).toEqual({
			relrowsecurity: true,
			relforcerowsecurity: true,
		});
		const zeroSchema = await readFile("src/zero/schema.gen.ts", "utf8");
		expect(zeroSchema).not.toContain("userSecret");
		expect(zeroSchema).not.toContain("user_secret");
	});
});
