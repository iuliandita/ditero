import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = "ditero_import_history_ledger_test";
const namespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const digest = "b".repeat(64);

function sourceHash(sourceRowId: string): string {
	return createHash("sha256").update(sourceRowId, "utf8").digest("hex");
}

async function insertLedger(
	id: string,
	collection: "comments" | "templates" | "completionEvents",
	parent: string,
	sourceRowId: string,
	target: string,
	namespaceValue = namespace,
): Promise<void> {
	await admin.query(
		`insert into import_history_ledger
		 (id,collection,target_parent_id,source_namespace,source_row_id,
		 source_row_id_sha256,target_id,content_digest)
		 values ($1,$2,$3,$4,$5,$6,$7,$8)`,
		[
			id,
			collection,
			parent,
			namespaceValue,
			sourceRowId,
			sourceHash(sourceRowId),
			target,
			digest,
		],
	);
}

async function asRuntime<T>(
	userId: string,
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await runtime.connect();
	try {
		await client.query(`set role ${role}`);
		await client.query("begin");
		await client.query("select set_config('ditero.user_id', $1, true)", [
			userId,
		]);
		await client.query(
			"select set_config('ditero.import_history_scope_present', '1', true)",
		);
		const result = await fn(client);
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

async function wipe(): Promise<void> {
	await admin.query(
		"alter table import_history_redaction disable trigger user",
	);
	await admin.query("alter table import_history_ledger disable trigger user");
	try {
		await admin.query(
			"delete from import_history_redaction where ledger_id like 'ihl-%'",
		);
		await admin.query(
			"delete from import_history_ledger where id like 'ihl-%'",
		);
	} finally {
		await admin.query(
			"alter table import_history_redaction enable trigger user",
		);
		await admin.query("alter table import_history_ledger enable trigger user");
	}
	await admin.query("delete from import_source where id = 'ihl-source'");
	await admin.query(
		"delete from task where id in ('ihl-task','ihl-other-task')",
	);
	await admin.query("delete from comment where id = 'ihl-comment'");
	await admin.query(
		"delete from list where id in ('ihl-list','ihl-other-list')",
	);
	await admin.query("delete from membership where id like 'ihl-%'");
	await admin.query(
		"delete from workspace where id in ('ihl-space','ihl-other-space')",
	);
	await admin.query(
		"delete from \"user\" where id in ('ihl-owner','ihl-member','ihl-outsider','ihl-importer')",
	);
}

beforeAll(async () => {
	await admin.query(`do $$ begin
		if not exists (select from pg_roles where rolname = '${role}') then
			create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if;
	end $$`);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select on task, list, membership, "user" to ${role}`,
	);
	await admin.query(
		`grant select, insert, update, delete on import_history_ledger, import_history_redaction to ${role}`,
	);
	await wipe();
	for (const id of [
		"ihl-owner",
		"ihl-member",
		"ihl-outsider",
		"ihl-importer",
	]) {
		await admin.query(
			`insert into "user" (id,name,email,email_verified,created_at,updated_at)
			 values ($1,$1,$2,false,now(),now())`,
			[id, `${id}@example.test`],
		);
	}
	await admin.query(`insert into workspace (id,name,owner_id,kind) values
		('ihl-space','History','ihl-owner','shared'),
		('ihl-other-space','Other','ihl-outsider','shared')`);
	for (const [id, userId, workspaceId] of [
		["ihl-owner-member", "ihl-owner", "ihl-space"],
		["ihl-member-member", "ihl-member", "ihl-space"],
		["ihl-outsider-member", "ihl-outsider", "ihl-other-space"],
	]) {
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,'member')",
			[id, userId, workspaceId],
		);
	}
	await admin.query(`insert into list (id,workspace_id,owner_id,title,sort_key) values
		('ihl-list','ihl-space','ihl-owner','History','a0'),
		('ihl-other-list','ihl-other-space','ihl-outsider','Other','a0')`);
	await admin.query(`insert into task (id,list_id,title,sort_key) values
		('ihl-task','ihl-list','History task','a0'),
		('ihl-other-task','ihl-other-list','Other task','a0')`);
});

afterAll(async () => {
	try {
		await wipe();
	} finally {
		await runtime.end();
		await admin.end();
	}
});

test("source tuples support empty and UTF-8 IDs, UUID case, and separate parent copies", async () => {
	await insertLedger(
		"ihl-empty",
		"comments",
		"ihl-task",
		"",
		"ihl-target-empty",
		namespace.toUpperCase(),
	);
	await insertLedger(
		"ihl-copy",
		"comments",
		"ihl-other-task",
		"",
		"ihl-target-copy",
	);
	await insertLedger(
		"ihl-utf8",
		"completionEvents",
		"ihl-task",
		"🐕é",
		"ihl-target-utf8",
	);
	const rows = await admin.query(
		"select source_row_id,source_row_id_sha256 from import_history_ledger where id = 'ihl-utf8'",
	);
	expect(rows.rows[0]).toEqual({
		source_row_id: "🐕é",
		source_row_id_sha256: sourceHash("🐕é"),
	});
	await expect(
		insertLedger("ihl-case", "comments", "ihl-task", "", "ihl-target-case"),
	).rejects.toMatchObject({ constraint: "import_history_ledger_source" });
	await expect(
		insertLedger(
			"ihl-target-collision",
			"comments",
			"ihl-other-task",
			"another",
			"ihl-target-empty",
		),
	).rejects.toMatchObject({ constraint: "import_history_ledger_target" });
	await insertLedger(
		"ihl-cross-collection",
		"templates",
		"ihl-space",
		"",
		"ihl-target-empty",
	);
});

test("rejects malformed identity and digest fields", async () => {
	for (const [values, constraint] of [
		[
			["", "ihl-task", sourceHash("x"), "ihl-invalid-target", digest],
			"import_history_ledger_id_nonempty",
		],
		[
			["ihl-invalid", "", sourceHash("x"), "ihl-invalid-target", digest],
			"import_history_ledger_parent_nonempty",
		],
		[
			["ihl-invalid", "ihl-task", sourceHash("x"), "", digest],
			"import_history_ledger_target_nonempty",
		],
		[
			["ihl-invalid", "ihl-task", "A".repeat(64), "ihl-invalid-target", digest],
			"import_history_ledger_source_hash",
		],
		[
			["ihl-invalid", "ihl-task", "0".repeat(64), "ihl-invalid-target", digest],
			"import_history_ledger_source_hash",
		],
		[
			[
				"ihl-invalid",
				"ihl-task",
				sourceHash("x"),
				"ihl-invalid-target",
				"A".repeat(64),
			],
			"import_history_ledger_digest",
		],
	] as const) {
		await expect(
			admin.query(
				`insert into import_history_ledger (id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest)
			 values ($1,'comments',$2,$3,'x',$4,$5,$6)`,
				[values[0], values[1], namespace, values[2], values[3], values[4]],
			),
		).rejects.toMatchObject({ constraint });
	}
	await expect(
		admin.query(
			`insert into import_history_ledger (id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest)
		 values ('ihl-bad-uuid','comments','ihl-task','bad-uuid','x',$1,'ihl-bad-uuid-target',$2)`,
			[sourceHash("x"), digest],
		),
	).rejects.toMatchObject({ code: "22P02" });
});

test("FORCE RLS reads follow current parent and live membership; writes stay closed", async () => {
	await insertLedger(
		"ihl-access",
		"comments",
		"ihl-task",
		"access",
		"ihl-access-target",
	);
	await admin.query(
		"insert into import_history_redaction (ledger_id) values ('ihl-access')",
	);
	const zero = await import("../../src/zero/schema.gen.ts");
	expect(Object.keys(zero.schema.tables)).not.toContain("importHistoryLedger");
	expect(Object.keys(zero.schema.tables)).not.toContain(
		"importHistoryRedaction",
	);
	for (const table of ["import_history_ledger", "import_history_redaction"]) {
		const settings = await admin.query(
			"select relrowsecurity,relforcerowsecurity from pg_class where oid = $1::regclass",
			[table],
		);
		expect(settings.rows[0]).toEqual({
			relrowsecurity: true,
			relforcerowsecurity: true,
		});
		const policies = await admin.query(
			"select cmd from pg_policies where tablename = $1",
			[table],
		);
		expect(policies.rows.map((row) => row.cmd)).toEqual(["SELECT"]);
		const field = table === "import_history_ledger" ? "id" : "ledger_id";
		const count = async (userId: string) =>
			(
				await asRuntime(userId, (client) =>
					client.query(
						`select ${field} from ${table} where ${field} = 'ihl-access'`,
					),
				)
			).rowCount;
		expect(await count("ihl-member")).toBe(1);
		expect(await count("ihl-outsider")).toBe(0);
		await admin.query(
			"update task set list_id = 'ihl-other-list' where id = 'ihl-task'",
		);
		expect(await count("ihl-member")).toBe(0);
		expect(await count("ihl-outsider")).toBe(1);
		await admin.query(
			"update task set list_id = 'ihl-list' where id = 'ihl-task'",
		);
	}
	await expect(
		asRuntime("ihl-owner", (client) =>
			client.query(
				`insert into import_history_ledger (id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest)
		 values ('ihl-runtime','comments','ihl-task',$1,'runtime',$2,'ihl-runtime-target',$3)`,
				[namespace, sourceHash("runtime"), digest],
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	await expect(
		asRuntime("ihl-owner", (client) =>
			client.query(
				"insert into import_history_redaction (ledger_id) values ('ihl-empty')",
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	expect(
		(
			await asRuntime("ihl-owner", (client) =>
				client.query(
					"update import_history_ledger set content_digest = $1 where id = 'ihl-access'",
					["c".repeat(64)],
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query("delete from membership where id = 'ihl-member-member'");
	expect(
		(
			await asRuntime("ihl-member", (client) =>
				client.query(
					"select id from import_history_ledger where id = 'ihl-access'",
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query(
		"update \"user\" set deleted_at = now() where id = 'ihl-owner'",
	);
	expect(
		(
			await asRuntime("ihl-owner", (client) =>
				client.query(
					"select id from import_history_ledger where id = 'ihl-access'",
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query(
		"update \"user\" set deleted_at = null where id = 'ihl-owner'",
	);
	await admin.query("delete from task where id = 'ihl-task'");
	expect(
		(
			await asRuntime("ihl-owner", (client) =>
				client.query(
					"select id from import_history_ledger where id = 'ihl-access'",
				),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select id from import_history_ledger where id = 'ihl-access'",
			)
		).rowCount,
	).toBe(1);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('ihl-task','ihl-list','History task','a0')",
	);
});

test("templates resolve workspace membership and retained rows survive content, source, and importer deletion", async () => {
	await admin.query(
		"insert into template (id,workspace_id,kind,name,content,created_by) values ('ihl-template','ihl-space','task','Imported','{}'::jsonb,'ihl-owner')",
	);
	await insertLedger(
		"ihl-retained",
		"templates",
		"ihl-space",
		"source",
		"ihl-template",
	);
	expect(
		(
			await asRuntime("ihl-owner", (client) =>
				client.query(
					"select id from import_history_ledger where id = 'ihl-retained'",
				),
			)
		).rowCount,
	).toBe(1);
	expect(
		(
			await asRuntime("ihl-outsider", (client) =>
				client.query(
					"select id from import_history_ledger where id = 'ihl-retained'",
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query("delete from template where id = 'ihl-template'");
	await admin.query(
		"insert into import_source (id,owner_user_id,label,format,schema_version,source_user_id) values ('ihl-source','ihl-importer','Source','native_json',2,'source-user')",
	);
	await admin.query("delete from import_source where id = 'ihl-source'");
	await admin.query("delete from \"user\" where id = 'ihl-importer'");
	expect(
		(
			await admin.query(
				"select id from import_history_ledger where id = 'ihl-retained'",
			)
		).rowCount,
	).toBe(1);
	expect(
		(
			await admin.query(
				"select target_id from import_history_ledger where id = 'ihl-retained'",
			)
		).rows[0].target_id,
	).toBe("ihl-template");
	const fks = await admin.query(
		"select confrelid::regclass::text as target from pg_constraint where conrelid = 'import_history_ledger'::regclass and contype = 'f'",
	);
	expect(fks.rows).toEqual([]);
});

test("ledger and redaction remain immutable under privileged normal DML", async () => {
	await insertLedger(
		"ihl-immutable",
		"comments",
		"ihl-task",
		"immutable",
		"ihl-immutable-target",
	);
	await admin.query(
		"insert into import_history_redaction (ledger_id) values ('ihl-immutable')",
	);
	for (const query of [
		"update import_history_ledger set source_row_id = 'changed' where id = 'ihl-immutable'",
		"update import_history_ledger set target_id = 'changed' where id = 'ihl-immutable'",
		"update import_history_ledger set content_digest = 'changed' where id = 'ihl-immutable'",
		"delete from import_history_ledger where id = 'ihl-immutable'",
		"update import_history_redaction set redacted_at = now() where ledger_id = 'ihl-immutable'",
		"delete from import_history_redaction where ledger_id = 'ihl-immutable'",
	])
		await expect(admin.query(query)).rejects.toMatchObject({ code: "23514" });
	const fields = await admin.query(
		"select column_name from information_schema.columns where table_name = 'import_history_redaction'",
	);
	expect(fields.rows.map((row) => row.column_name).sort()).toEqual([
		"ledger_id",
		"redacted_at",
	]);
});
