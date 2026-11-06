import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { verifyRuntimeDatabaseRole } from "../../src/db/runtime-role.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const suffix = randomUUID().replaceAll("-", "");
const runtimeRole = `role_guard_${suffix}`;
const privilegedRole = `role_privileged_${suffix}`;
const intermediaryRole = `role_middle_${suffix}`;
const outsiderRole = `role_outsider_${suffix}`;
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({
	connectionString: databaseURL,
	options: `-c role=${runtimeRole}`,
});
const outsider = new Pool({
	connectionString: databaseURL,
	options: `-c role=${outsiderRole}`,
});
const alice = `role-alice-${suffix}`;
const bob = `role-bob-${suffix}`;
const workspace = `role-workspace-${suffix}`;
const otherWorkspace = `role-other-${suffix}`;
const request = `role-request-${suffix}`;

async function asAlice<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("select set_config('ditero.user_id', $1, true)", [
			alice,
		]);
		return await run(client);
	} finally {
		await client.query("rollback");
		client.release();
	}
}

beforeAll(async () => {
	for (const role of [
		runtimeRole,
		privilegedRole,
		intermediaryRole,
		outsiderRole,
	]) {
		await admin.query(
			`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
		);
	}
	await admin.query(
		`grant usage on schema public to "${runtimeRole}", "${outsiderRole}"`,
	);
	// Deliberately retain broad grants to exercise the trigger as well as RLS.
	await admin.query(
		`grant select, insert, update, delete on membership_key, key_grant_request to "${runtimeRole}"`,
	);
	await admin.query(`grant select on membership to "${runtimeRole}"`);
	await admin.query(
		`grant execute on function public.prune_focus_intervals() to "${runtimeRole}"`,
	);
	await admin.query(
		`insert into "user" (id, name, email, email_verified) values ($1, 'Alice', $1 || '@example.test', true), ($2, 'Bob', $2 || '@example.test', true)`,
		[alice, bob],
	);
	await admin.query(
		`insert into workspace (id, name, owner_id, kind) values ($1, 'Shared', $3, 'shared'), ($2, 'Other', $3, 'shared')`,
		[workspace, otherWorkspace, alice],
	);
	await admin.query(
		`insert into membership (id, user_id, workspace_id, role) values ($1, $3, $5, 'owner'), ($2, $4, $5, 'member'), ($6, $4, $7, 'member'), ($8, $3, $7, 'owner')`,
		[
			`${alice}-member`,
			`${bob}-member`,
			alice,
			bob,
			workspace,
			`${bob}-other`,
			otherWorkspace,
			`${alice}-other`,
		],
	);
	await admin.query(
		`insert into key_grant_request (id, membership_id, user_id, workspace_id, requested_version) values ($1, $2, $3, $4, 1)`,
		[request, `${bob}-member`, bob, workspace],
	);
	await admin.query(
		`insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by)
   values ($1, $2, $3, $4, 100, 'enc', 'ciphertext', 'pk', $3)`,
		[`${alice}-wrap`, `${alice}-member`, alice, workspace],
	);
});

afterAll(async () => {
	await runtime.end();
	await outsider.end();
	await admin.query("delete from membership where workspace_id = any($1)", [
		[workspace, otherWorkspace],
	]);
	await admin.query("delete from workspace where id = any($1)", [
		[workspace, otherWorkspace],
	]);
	await admin.query('delete from "user" where id = any($1)', [[alice, bob]]);
	for (const role of [
		runtimeRole,
		privilegedRole,
		intermediaryRole,
		outsiderRole,
	]) {
		await admin.query(`drop owned by "${role}"`);
		await admin.query(`drop role "${role}"`);
	}
	await admin.end();
});

describe("key-grant database boundaries", () => {
	test.each([
		"recipient",
		"workspace",
		"self",
	])("rejects a mismatched %s membership tuple", async (mismatch) => {
		const recipient = mismatch === "self" ? alice : bob;
		const membership =
			mismatch === "workspace" ? `${bob}-other` : `${alice}-member`;
		await expect(
			asAlice((client) =>
				client.query(
					`insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by) values ($1, $2, $3, $4, 1, 'enc', 'ciphertext', 'pk', $5)`,
					[
						randomUUID(),
						mismatch === "self" ? `${bob}-member` : membership,
						recipient,
						workspace,
						alice,
					],
				),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	test("accepts a wrap for the actual co-member tuple under NOBYPASSRLS", async () => {
		await asAlice(async (client) => {
			expect(
				(
					await client.query(
						"select rolsuper, rolbypassrls from pg_roles where rolname=current_user",
					)
				).rows,
			).toEqual([{ rolsuper: false, rolbypassrls: false }]);
			expect(
				(
					await client.query(
						`insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by) values ($1, $2, $3, $4, 1, 'enc', 'ciphertext', 'pk', $5) returning user_id`,
						[randomUUID(), `${bob}-member`, bob, workspace, alice],
					)
				).rows,
			).toEqual([{ user_id: bob }]);
		});
	});

	test.each([
		["id", "changed"],
		["membership_id", `${bob}-other`],
		["user_id", alice],
		["workspace_id", otherWorkspace],
		["requested_version", 2],
		["requested_at", new Date(0)],
	])("cannot update request %s through a broad table grant", async (column, value) => {
		await expect(
			asAlice((client) =>
				client.query(`update key_grant_request set ${column}=$1 where id=$2`, [
					value,
					request,
				]),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	test("a self-grant must name the caller as granter", async () => {
		await expect(
			asAlice((client) =>
				client.query(
					`insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by)
    values ($1, $2, $3, $4, 1, 'enc', 'ciphertext', 'pk', $5)`,
					[randomUUID(), `${alice}-member`, alice, workspace, bob],
				),
			),
		).rejects.toThrow(/row-level security/);
		await asAlice(async (client) => {
			expect(
				(
					await client.query(
						`insert into membership_key (id, membership_id, user_id, workspace_id, key_version, enc, ciphertext, recipient_public_key, granted_by)
     values ($1, $2, $3, $4, 1, 'enc', 'ciphertext', 'pk', $3) returning granted_by`,
						[randomUUID(), `${alice}-member`, alice, workspace],
					)
				).rows,
			).toEqual([{ granted_by: alice }]);
		});
	});

	test.each([
		["id", "changed"],
		["membership_id", `${bob}-member`],
		["user_id", bob],
		["workspace_id", otherWorkspace],
		["key_version", 101],
		["granted_by", bob],
		["created_at", new Date(0)],
	])("cannot change membership key %s through a broad table grant", async (column, value) => {
		await expect(
			asAlice((client) =>
				client.query(`update membership_key set ${column}=$1 where id=$2`, [
					value,
					`${alice}-wrap`,
				]),
			),
		).rejects.toThrow("membership key identity is immutable");
	});

	test("identity rotation can still replace its own wrap columns", async () => {
		await asAlice(async (client) => {
			expect(
				(
					await client.query(
						`update membership_key set enc='new-enc', ciphertext='new-ciphertext', recipient_public_key='new-pk'
     where id=$1 returning enc, ciphertext, recipient_public_key`,
						[`${alice}-wrap`],
					)
				).rows,
			).toEqual([
				{
					enc: "new-enc",
					ciphertext: "new-ciphertext",
					recipient_public_key: "new-pk",
				},
			]);
		});
	});

	test("a co-member can still fulfil the request", async () => {
		await asAlice(async (client) => {
			expect(
				(
					await client.query(
						`update key_grant_request set state='ready', granted_at=now(), failure_reason=null where id=$1 returning state, user_id`,
						[request],
					)
				).rows,
			).toEqual([{ state: "ready", user_id: bob }]);
		});
	});
});

test("only explicitly authorized roles can prune, and runtime can prune expired rows", async () => {
	await expect(
		outsider.query("select public.prune_focus_intervals()"),
	).rejects.toMatchObject({
		code: "42501",
		message: "permission denied for function prune_focus_intervals",
	});
	const id = randomUUID();
	await admin.query(
		`insert into server_private.focus_interval_clock (user_id, interval_id, started_at) values ($1, $2, now() - interval '15 days')`,
		[alice, id],
	);
	await admin.query(
		"insert into focus_interval_start (user_id, interval_id) values ($1,$2)",
		[alice, id],
	);
	expect(
		(await runtime.query("select public.prune_focus_intervals() as removed"))
			.rows,
	).toEqual([{ removed: 1 }]);
	expect(
		(
			await admin.query(
				"select interval_id from server_private.focus_interval_clock where user_id=$1",
				[alice],
			)
		).rows,
	).toEqual([]);
	expect(
		(
			await admin.query(
				"select interval_id from focus_interval_start where user_id=$1",
				[alice],
			)
		).rows,
	).toEqual([]);
});

describe("runtime boot privilege inspection", () => {
	test("accepts the isolated runtime", async () => {
		await expect(verifyRuntimeDatabaseRole(runtime)).resolves.toBeUndefined();
	});

	test("rejects missing prune execution with the exact repair grant", async () => {
		try {
			await admin.query(
				`revoke execute on function public.prune_focus_intervals() from "${runtimeRole}"`,
			);
			await expect(verifyRuntimeDatabaseRole(runtime)).rejects.toThrow(
				`GRANT EXECUTE ON FUNCTION public.prune_focus_intervals() TO "${runtimeRole}";`,
			);
		} finally {
			await admin.query(
				`grant execute on function public.prune_focus_intervals() to "${runtimeRole}"`,
			);
		}
	});

	test.each([
		"superuser",
		"bypassrls",
		"createrole",
		"replication",
	])("rejects direct %s", async (attribute) => {
		try {
			await admin.query(`alter role "${runtimeRole}" ${attribute}`);
			await expect(verifyRuntimeDatabaseRole(runtime)).rejects.toThrow(
				`Runtime database role ${runtimeRole} has forbidden attributes: ${attribute.toUpperCase()}`,
			);
		} finally {
			await admin.query(`alter role "${runtimeRole}" no${attribute}`);
		}
	});

	test.each([
		"superuser",
		"bypassrls",
		"createrole",
		"replication",
	])("rejects transitive NOINHERIT membership in a %s role", async (attribute) => {
		try {
			await admin.query(`alter role "${privilegedRole}" ${attribute}`);
			await admin.query(`grant "${privilegedRole}" to "${intermediaryRole}"`);
			await admin.query(`grant "${intermediaryRole}" to "${runtimeRole}"`);
			await expect(verifyRuntimeDatabaseRole(runtime)).rejects.toThrow(
				`${privilegedRole} (${attribute.toUpperCase()})`,
			);
		} finally {
			await admin.query(`revoke "${intermediaryRole}" from "${runtimeRole}"`);
			await admin.query(
				`revoke "${privilegedRole}" from "${intermediaryRole}"`,
			);
			await admin.query(`alter role "${privilegedRole}" no${attribute}`);
		}
	});

	test.each([
		"direct",
		"inherited",
	])("rejects %s ownership of a different FORCE RLS table", async (path) => {
		const table = `public."role_probe_${suffix}"`;
		try {
			await admin.query(`create table ${table} (id int)`);
			await admin.query(`alter table ${table} enable row level security`);
			await admin.query(`alter table ${table} force row level security`);
			await admin.query(
				`alter table ${table} owner to "${path === "direct" ? runtimeRole : privilegedRole}"`,
			);
			if (path === "inherited")
				await admin.query(`grant "${privilegedRole}" to "${runtimeRole}"`);
			await expect(verifyRuntimeDatabaseRole(runtime)).rejects.toThrow(
				`RLS tables: public.role_probe_${suffix} (owner ${path === "direct" ? runtimeRole : privilegedRole})`,
			);
		} finally {
			if (path === "inherited")
				await admin.query(`revoke "${privilegedRole}" from "${runtimeRole}"`);
			await admin.query(`drop table ${table}`);
		}
	});
});

test("migration preserves custom runtime cleanup authority without granting read-only roles", async () => {
	const client = await admin.connect();
	const customRole = `custom_cleanup_${suffix}`;
	const readerRole = `cleanup_reader_${suffix}`;
	try {
		await client.query("begin");
		await client.query(
			`create role "${customRole}" nosuperuser nocreaterole noinherit nobypassrls`,
		);
		await client.query(
			`create role "${readerRole}" nosuperuser nocreaterole noinherit nobypassrls`,
		);
		await client.query(
			`grant usage on schema public to "${customRole}", "${readerRole}"`,
		);
		await client.query(
			`grant delete on public.focus_interval_start to "${customRole}"`,
		);
		await client.query(
			`grant select on public.focus_interval_start to "${readerRole}"`,
		);
		await client.query(
			"drop function public.guard_key_grant_request_update() cascade",
		);
		await client.query(
			"drop function if exists public.guard_membership_key_update() cascade",
		);
		const migration = await readFile(
			new URL(
				"../../drizzle/0092_database_role_boundaries.sql",
				import.meta.url,
			),
			"utf8",
		);
		await client.query(migration);
		expect(
			(
				await client.query(
					`select has_function_privilege($1, 'public.prune_focus_intervals()', 'EXECUTE') as custom,
           has_function_privilege($2, 'public.prune_focus_intervals()', 'EXECUTE') as reader`,
					[customRole, readerRole],
				)
			).rows,
		).toEqual([{ custom: true, reader: false }]);
		await client.query(`set local role "${customRole}"`);
		expect(
			(
				await client.query(
					"select rolsuper, rolbypassrls from pg_roles where rolname=current_user",
				)
			).rows,
		).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		expect(
			(await client.query("select public.prune_focus_intervals() as removed"))
				.rows[0].removed,
		).toBeTypeOf("number");
	} finally {
		await client.query("rollback");
		client.release();
	}
});
