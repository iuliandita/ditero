import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { workspaceAccessScope } from "../../src/db/schema.ts";
import { schema } from "../../src/zero/schema.gen.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const runtimeRole = "ditero_access_scope_runtime_test";
const ownerRole = "ditero_access_scope_owner_test";
const users = ["was-owner", "was-member", "was-other"];
const spaces = ["was-space", "was-other-space"];

beforeAll(async () => {
	for (const role of [runtimeRole, ownerRole]) {
		await pool.query(`DO $$ BEGIN
			IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
				CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
			END IF;
		END $$`);
		await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
	}
	await pool.query(`GRANT CREATE ON SCHEMA public TO ${ownerRole}`);
	await pool.query(
		`GRANT SELECT, TRIGGER ON public.membership TO ${ownerRole}`,
	);
	await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.membership,
		public.workspace_access_scope TO ${runtimeRole}`);
	for (const id of users) {
		await pool.query(
			`INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at)
			VALUES ($1,$1,$2,false,now(),now())`,
			[id, `${id}@example.test`],
		);
	}
	for (const id of spaces) {
		await pool.query(
			`INSERT INTO workspace (id,name,owner_id,kind)
			VALUES ($1,$1,'was-owner','shared')`,
			[id],
		);
	}
});

afterAll(async () => {
	await pool.query("DELETE FROM membership WHERE user_id = ANY($1::text[])", [
		users,
	]);
	await pool.query("DELETE FROM workspace WHERE id = ANY($1::text[])", [
		spaces,
	]);
	await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [users]);
	await pool.end();
});

async function transaction(callback: (client: PoolClient) => Promise<void>) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await callback(client);
	} finally {
		await client.query("ROLLBACK");
		client.release();
	}
}

async function insertMembership(
	client: PoolClient,
	id: string,
	user = "was-member",
	space = "was-space",
) {
	await client.query(
		`INSERT INTO public.membership (id,user_id,workspace_id,role)
		VALUES ($1,$2,$3,'viewer')`,
		[id, user, space],
	);
}

async function readScope(client: PoolClient, id: string) {
	return (
		await client.query(
			"SELECT id,user_id,workspace_id FROM public.workspace_access_scope WHERE id=$1",
			[id],
		)
	).rows;
}

test("projection has no Drizzle or Zero relationships and forces row security", async () => {
	expect(getTableConfig(workspaceAccessScope).enableRLS).toBe(true);
	expect("workspaceAccessScope" in schema.relationships).toBe(false);
	for (const relationships of Object.values(schema.relationships)) {
		for (const chain of Object.values(relationships)) {
			for (const relationship of chain) {
				expect(relationship.destSchema).not.toBe("workspaceAccessScope");
			}
		}
	}
	const result =
		await pool.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class
		WHERE oid='public.workspace_access_scope'::regclass`);
	expect(result.rows).toEqual([
		{ relrowsecurity: true, relforcerowsecurity: true },
	]);
	const fn = await pool.query(
		`SELECT prosecdef,proconfig,has_function_privilege($1,
		'public.maintain_workspace_access_scope()','EXECUTE') AS runtime_execute
		FROM pg_proc WHERE oid='public.maintain_workspace_access_scope()'::regprocedure`,
		[runtimeRole],
	);
	expect(fn.rows).toEqual([
		{
			prosecdef: true,
			proconfig: ["search_path=pg_catalog"],
			runtime_execute: false,
		},
	]);
});

test("restricted canonical writes maintain exact scope while direct projection writes fail", async () => {
	await transaction(async (client) => {
		await client.query(
			`ALTER TABLE public.workspace_access_scope OWNER TO ${ownerRole}`,
		);
		await client.query(
			`ALTER FUNCTION public.maintain_workspace_access_scope() OWNER TO ${ownerRole}`,
		);
		const flags = await client.query(
			"SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",
			[ownerRole],
		);
		expect(flags.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		await client.query(`SET LOCAL ROLE ${runtimeRole}`);
		await client.query("SELECT set_config('ditero.user_id','was-member',true)");
		await insertMembership(client, "was-runtime");
		expect(await readScope(client, "was-runtime")).toEqual([
			{ id: "was-runtime", user_id: "was-member", workspace_id: "was-space" },
		]);
		await client.query(
			"UPDATE public.membership SET user_id='was-other',workspace_id='was-other-space' WHERE id='was-runtime'",
		);
		expect(await readScope(client, "was-runtime")).toEqual([]);
		await client.query("SELECT set_config('ditero.user_id','was-other',true)");
		expect(await readScope(client, "was-runtime")).toEqual([
			{
				id: "was-runtime",
				user_id: "was-other",
				workspace_id: "was-other-space",
			},
		]);
		await client.query("SAVEPOINT direct_insert");
		await expect(
			client.query(`INSERT INTO public.workspace_access_scope (id,user_id,workspace_id)
			VALUES ('forged','was-other','was-space')`),
		).rejects.toThrow(/row-level security/i);
		await client.query("ROLLBACK TO SAVEPOINT direct_insert");
		expect(
			(
				await client.query(
					"UPDATE public.workspace_access_scope SET workspace_id='was-space' WHERE id='was-runtime'",
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await client.query(
					"DELETE FROM public.workspace_access_scope WHERE id='was-runtime'",
				)
			).rowCount,
		).toBe(0);
		expect(await readScope(client, "was-runtime")).toEqual([
			{
				id: "was-runtime",
				user_id: "was-other",
				workspace_id: "was-other-space",
			},
		]);
		await client.query("DELETE FROM public.membership WHERE id='was-runtime'");
		expect(await readScope(client, "was-runtime")).toEqual([]);
		await insertMembership(client, "was-runtime", "was-other", "was-space");
		expect(await readScope(client, "was-runtime")).toEqual([
			{ id: "was-runtime", user_id: "was-other", workspace_id: "was-space" },
		]);
	});
});

test("membership and projection inserts roll back together", async () => {
	await transaction(async (client) => {
		await client.query("SAVEPOINT membership_write");
		await insertMembership(client, "was-rollback");
		expect(await readScope(client, "was-rollback")).toHaveLength(1);
		await client.query("ROLLBACK TO SAVEPOINT membership_write");
		expect(await readScope(client, "was-rollback")).toEqual([]);
		expect(
			(await client.query("SELECT id FROM membership WHERE id='was-rollback'"))
				.rows,
		).toEqual([]);
	});
});

test("actual maintenance migration backfills canonical rows as a non-superuser owner", async () => {
	const migration = await readFile(
		new URL(
			"../../drizzle/0054_workspace_access_scope_maintenance.sql",
			import.meta.url,
		),
		"utf8",
	);
	await transaction(async (client) => {
		await client.query(
			"DROP TRIGGER membership_workspace_access_scope ON public.membership",
		);
		await client.query(
			"DROP FUNCTION public.maintain_workspace_access_scope()",
		);
		await client.query("DELETE FROM public.workspace_access_scope");
		await insertMembership(client, "was-backfill");
		await insertMembership(
			client,
			"was-backfill-other",
			"was-other",
			"was-other-space",
		);
		await client.query(
			`ALTER TABLE public.workspace_access_scope OWNER TO ${ownerRole}`,
		);
		await client.query(`SET LOCAL ROLE ${ownerRole}`);
		await client.query(migration);
		const difference = await client.query(`
			(SELECT id,user_id,workspace_id FROM public.membership EXCEPT SELECT id,user_id,workspace_id FROM public.workspace_access_scope)
			UNION ALL
			(SELECT id,user_id,workspace_id FROM public.workspace_access_scope EXCEPT SELECT id,user_id,workspace_id FROM public.membership)`);
		expect(difference.rows).toEqual([]);
		expect(await readScope(client, "was-backfill")).toEqual([
			{ id: "was-backfill", user_id: "was-member", workspace_id: "was-space" },
		]);
		expect(await readScope(client, "was-backfill-other")).toEqual([
			{
				id: "was-backfill-other",
				user_id: "was-other",
				workspace_id: "was-other-space",
			},
		]);
	});
});
