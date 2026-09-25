import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL });
const role = "ditero_imported_history_test";
const namespace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const claimedNamespace = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = new Date("2026-09-25T12:34:56.123Z");

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
		// No imported-history policy may trust an application-supplied GUC.
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

async function importedComment(
	id: string,
	sourceRowId = "",
	authorName = "A claimed name",
): Promise<void> {
	await admin.query(
		`insert into comment (id, task_id, author_id, body, created_at,
		 source_namespace, source_row_id, historical_author_kind, historical_author_namespace,
		 historical_author_principal_id, historical_author_name, imported_at)
		 values ($1, 'ih-task', null, 'Imported text', $2, $3, $4,
		 'source_claim', $5, 'same-local-name', $6, $2)`,
		[id, now, namespace, sourceRowId, claimedNamespace, authorName],
	);
}

async function importedTemplate(id: string): Promise<void> {
	await admin.query(
		`insert into template (id, workspace_id, kind, name, content, created_by,
		 source_namespace, source_row_id, historical_creator_kind,
		 historical_creator_namespace, historical_creator_principal_id,
		 historical_creator_name, imported_at)
		 values ($1, 'ih-space', 'task', 'Imported template', '{}'::jsonb,
		 'ih-owner', $2, '', 'source_claim', $3, 'same-local-name', 'Claimed creator', $4)`,
		[id, namespace, claimedNamespace, now],
	);
}

async function importedEvent(
	id: string,
	originLabel = "External app",
): Promise<void> {
	await admin.query(
		`insert into imported_completion_event
		 (id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,
		 actor_namespace,actor_principal_id,actor_name,origin_kind,origin_mechanism,
		 origin_label,action,before_due_all_day,before_done,after_done)
		 values ($1,'ih-task',$2,'',$3,'source_claim',$4,'same-local-name',
		 'Claimed actor','source_claim','member_mutation',$5,
		 'complete',false,false,true)`,
		[id, namespace, now, claimedNamespace, originLabel],
	);
}

async function wipe(): Promise<void> {
	await admin.query(
		"delete from task where id in ('ih-task', 'ih-other-task')",
	);
	await admin.query("delete from template where id like 'ih-%'");
	await admin.query(
		"delete from list where id in ('ih-list', 'ih-other-list')",
	);
	await admin.query("delete from membership where id like 'ih-%'");
	await admin.query(
		"delete from workspace where id in ('ih-space', 'ih-other-space')",
	);
	await admin.query(
		"delete from \"user\" where id in ('ih-owner','ih-member','ih-outsider')",
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
		`grant select, insert, update, delete on imported_completion_event, comment, template to ${role}`,
	);
	await wipe();
	for (const id of ["ih-owner", "ih-member", "ih-outsider"]) {
		await admin.query(
			`insert into "user" (id,name,email,email_verified,created_at,updated_at)
			 values ($1,$1,$2,false,now(),now())`,
			[id, `${id}@example.test`],
		);
	}
	await admin.query(`insert into workspace (id,name,owner_id,kind) values
		('ih-space','History','ih-owner','shared'),
		('ih-other-space','Other','ih-outsider','shared')`);
	for (const [id, userId, space] of [
		["ih-membership-owner", "ih-owner", "ih-space"],
		["ih-membership-member", "ih-member", "ih-space"],
		["ih-membership-outsider", "ih-outsider", "ih-other-space"],
	]) {
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,'member')",
			[id, userId, space],
		);
	}
	await admin.query(`insert into list (id,workspace_id,owner_id,title,sort_key) values
		('ih-list','ih-space','ih-owner','History','a0'),
		('ih-other-list','ih-other-space','ih-outsider','Other','a0')`);
	await admin.query(`insert into task (id,list_id,title,sort_key) values
		('ih-task','ih-list','History task','a0'),
		('ih-other-task','ih-other-list','Other task','a0')`);
});

afterAll(async () => {
	await wipe();
	await runtime.end();
	await admin.end();
});

test("migrations expose only display claims to Zero and force event RLS", async () => {
	const policy = await admin.query<{
		relrowsecurity: boolean;
		relforcerowsecurity: boolean;
	}>(
		"select relrowsecurity, relforcerowsecurity from pg_class where oid = 'imported_completion_event'::regclass",
	);
	expect(policy.rows[0]).toEqual({
		relrowsecurity: true,
		relforcerowsecurity: true,
	});
	const policies = await admin.query<{ cmd: string }>(
		"select cmd from pg_policies where tablename = 'imported_completion_event'",
	);
	expect(policies.rows.map((row) => row.cmd)).toEqual(["SELECT"]);
	const indexes = await admin.query<{ indexdef: string }>(
		"select indexdef from pg_indexes where indexname = 'imported_completion_event_page_idx'",
	);
	expect(indexes.rows[0].indexdef).toMatch(
		/\(task_id, occurred_at DESC NULLS LAST, id DESC NULLS LAST\)/,
	);
	const zero = await import("../../src/zero/schema.gen.ts");
	expect(Object.keys(zero.schema.tables)).not.toContain(
		"importedCompletionEvent",
	);
	for (const table of ["comment", "template"] as const) {
		const fields = Object.keys(zero.schema.tables[table].columns);
		expect(fields).not.toContain("sourceNamespace");
		expect(fields).not.toContain("sourceRowId");
	}
});

test("native comment and template writes still work while malformed provenance fails", async () => {
	await asRuntime("ih-member", async (client) => {
		await client.query(
			"insert into comment (id,task_id,author_id,body) values ('ih-native-comment','ih-task','ih-member','Native')",
		);
		await client.query(
			"update comment set body = 'Edited' where id = 'ih-native-comment'",
		);
		await client.query(
			"insert into template (id,workspace_id,kind,name,content,created_by) values ('ih-native-template','ih-space','task','Native','{}'::jsonb,'ih-member')",
		);
	});
	await expect(
		admin.query(
			"insert into comment (id,task_id,body) values ('ih-bad','ih-task','Missing author')",
		),
	).rejects.toMatchObject({ constraint: "comment_provenance" });
	await expect(
		admin.query(
			"update comment set source_namespace = $1 where id = 'ih-native-comment'",
			[namespace],
		),
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		admin.query(
			"update template set historical_creator_name = 'fake' where id = 'ih-native-template'",
		),
	).rejects.toMatchObject({ constraint: "template_provenance" });
});

test("privileged seeding retains empty and long source IDs; claims have a bounded name", async () => {
	await importedComment("ih-comment", "");
	await importedComment("ih-long-comment", "x".repeat(5000));
	await importedTemplate("ih-template");
	await importedEvent("ih-event");
	await importedEvent("ih-origin-label-128", "x".repeat(128));
	await expect(
		importedEvent("ih-origin-label-129", "x".repeat(129)),
	).rejects.toMatchObject({
		constraint: "imported_completion_event_claim_length",
	});
	expect(
		(
			await admin.query(
				"select source_row_id from comment where id = 'ih-long-comment'",
			)
		).rows[0].source_row_id,
	).toHaveLength(5000);
	await expect(
		importedComment("ih-long-name", "", "x".repeat(513)),
	).rejects.toMatchObject({
		constraint: "comment_historical_author_name_length",
	});
	await expect(
		admin.query(
			"insert into imported_completion_event (id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,origin_kind,action,before_due_all_day,before_done,after_done) values ('','ih-task',$1,'',$2,'unknown','unknown','complete',false,false,true)",
			[namespace, now],
		),
	).rejects.toMatchObject({
		constraint: "imported_completion_event_id_nonempty",
	});
	await expect(
		admin.query(
			"update imported_completion_event set before_done = true where id = 'ih-event'",
		),
	).rejects.toMatchObject({ code: "23514" });
});

test("runtime role cannot insert or edit imported records even with direct grants", async () => {
	await importedComment("ih-guard-comment");
	await importedTemplate("ih-guard-template");
	await importedEvent("ih-guard-event");
	await expect(
		asRuntime("ih-owner", (client) =>
			client.query(
				"insert into comment (id,task_id,body,source_namespace,source_row_id,historical_author_kind,imported_at) values ('ih-runtime-comment','ih-task','Fake',$1,'','unknown',$2)",
				[namespace, now],
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	await expect(
		asRuntime("ih-owner", (client) =>
			client.query(
				"update comment set body = 'Changed' where id = 'ih-guard-comment'",
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	await expect(
		asRuntime("ih-owner", (client) =>
			client.query(
				"update template set name = 'Changed' where id = 'ih-guard-template'",
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	await expect(
		asRuntime("ih-owner", (client) =>
			client.query(
				"insert into imported_completion_event (id,task_id,source_namespace,source_row_id,occurred_at,actor_kind,origin_kind,action,before_due_all_day,before_done,after_done) values ('ih-runtime-event','ih-task',$1,'',$2,'unknown','unknown','complete',false,false,true)",
				[namespace, now],
			),
		),
	).rejects.toMatchObject({ code: "42501" });
	expect(
		(
			await asRuntime("ih-owner", (client) =>
				client.query(
					"update imported_completion_event set action = 'skip' where id = 'ih-guard-event'",
				),
			)
		).rowCount,
	).toBe(0);
});

test.each([
	"comment",
	"template",
] as const)("non-BYPASS table owner still cannot seed imported %s", async (table) => {
	const client = await admin.connect();
	try {
		await client.query("begin");
		await client.query(`alter table ${table} owner to ${role}`);
		await client.query(`set role ${role}`);
		const insert =
			table === "comment"
				? "insert into comment (id,task_id,body,source_namespace,source_row_id,historical_author_kind,imported_at) values ('ih-owner-attempt','ih-task','Fake',$1,'','unknown',$2)"
				: "insert into template (id,workspace_id,kind,name,content,created_by,source_namespace,source_row_id,historical_creator_kind,imported_at) values ('ih-owner-attempt','ih-space','task','Fake','{}'::jsonb,'ih-owner',$1,'','unknown',$2)";
		await expect(client.query(insert, [namespace, now])).rejects.toMatchObject({
			code: "42501",
		});
	} finally {
		await client.query("rollback");
		client.release();
	}
});

test("event visibility follows current workspace membership, task moves, and deletion", async () => {
	await importedEvent("ih-access-event");
	expect(
		(
			await asRuntime("ih-member", (client) =>
				client.query(
					"select id from imported_completion_event where id = 'ih-access-event'",
				),
			)
		).rowCount,
	).toBe(1);
	expect(
		(
			await asRuntime("ih-outsider", (client) =>
				client.query(
					"select id from imported_completion_event where id = 'ih-access-event'",
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query(
		"update task set list_id = 'ih-other-list' where id = 'ih-task'",
	);
	expect(
		(
			await asRuntime("ih-member", (client) =>
				client.query(
					"select id from imported_completion_event where id = 'ih-access-event'",
				),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await asRuntime("ih-outsider", (client) =>
				client.query(
					"select id from imported_completion_event where id = 'ih-access-event'",
				),
			)
		).rowCount,
	).toBe(1);
	await admin.query("update task set list_id = 'ih-list' where id = 'ih-task'");
	await admin.query("delete from membership where id = 'ih-membership-member'");
	expect(
		(
			await asRuntime("ih-member", (client) =>
				client.query(
					"select id from imported_completion_event where id = 'ih-access-event'",
				),
			)
		).rowCount,
	).toBe(0);
	await admin.query("delete from task where id = 'ih-task'");
	expect(
		(
			await admin.query(
				"select id from imported_completion_event where id = 'ih-access-event'",
			)
		).rows,
	).toEqual([]);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ('ih-task','ih-list','History task','a0')",
	);
});

test("privileged redaction clears claims once and cannot restore attribution", async () => {
	await importedComment("ih-redact-comment");
	await importedTemplate("ih-redact-template");
	await importedEvent("ih-redact-event");
	await admin.query(
		`update comment set historical_author_kind = 'unknown',
		historical_author_namespace = null, historical_author_principal_id = null,
		historical_author_name = null, provenance_redacted_at = $1 where id = 'ih-redact-comment'`,
		[now],
	);
	await admin.query(
		`update template set historical_creator_kind = 'unknown',
		historical_creator_namespace = null, historical_creator_principal_id = null,
		historical_creator_name = null, provenance_redacted_at = $1 where id = 'ih-redact-template'`,
		[now],
	);
	await admin.query(
		`update imported_completion_event set actor_kind = 'unknown',
		actor_namespace = null, actor_principal_id = null, actor_name = null,
		origin_kind = 'unknown', origin_mechanism = null, origin_label = null,
		provenance_redacted_at = $1 where id = 'ih-redact-event'`,
		[now],
	);
	for (const [table, id] of [
		["comment", "ih-redact-comment"],
		["template", "ih-redact-template"],
		["imported_completion_event", "ih-redact-event"],
	]) {
		await expect(
			admin.query(
				`update ${table} set provenance_redacted_at = null where id = $1`,
				[id],
			),
		).rejects.toMatchObject({ code: "23514" });
	}
});
