import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeLiteral, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";

const url = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_ATTACHMENT_LEDGER_TEST_DATABASE ?? "ditero_e2e";
if (
	!url ||
	process.env.NODE_ENV !== "test" ||
	!/^[-a-zA-Z0-9_]{1,63}$/.test(expectedDatabase) ||
	new URL(url).pathname !== `/${expectedDatabase}`
)
	throw new Error("Exact test database and NODE_ENV=test are required");
const scope = randomUUID().replaceAll("-", "");
const childDatabase = `ditero_attachment_ledger_${scope}`;
if (!/^[a-z][a-z0-9_]{1,62}$/.test(childDatabase))
	throw new Error("Invalid generated child database identifier");
const allocation = new Pool({ connectionString: url, max: 1 });
const childUrl = new URL(url);
childUrl.pathname = `/${childDatabase}`;
const admin = new Pool({ connectionString: childUrl.toString() });
let runtime: Pool | undefined;
let allocated = false;
let retainedDatabase: "absent" | "may-exist" | "present" | "unknown" = "absent";
let setupPhase = "preflight";
let setupOutcome: "pending" | "passed" | "failed" = "pending";
let roleDropped = false;
let receiptPath = process.env.DITERO_ATTACHMENT_LEDGER_TEST_RECEIPT;
let receiptCreated = false;
function recordAllocation(state: string, cleanupFailures = 0) {
	if (!receiptPath) {
		const directory = mkdtempSync(join(tmpdir(), "ditero-attachment-ledger-"));
		chmodSync(directory, 0o700);
		receiptPath = join(directory, "receipt.json");
	}
	writeFileSync(
		receiptPath,
		`${JSON.stringify(
			{
				scope,
				sourceDatabase: expectedDatabase,
				childDatabase,
				allocated,
				state,
				retainedDatabase,
				setupPhase,
				setupOutcome,
				roleCreated,
				roleDropped,

				cleanupFailures,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, flag: receiptCreated ? "w" : "wx" },
	);
	receiptCreated = true;
}
const role = `ditero_ledger_test_${scope}`;
const owner = `ledger-owner-${scope}`;
const other = `ledger-other-${scope}`;
const users = [owner, other];
const workspace = (user: string) => `space-${user}`;
const source = (user: string) => `source-${user}`;
const list = (user: string) => `list-${user}`;
const job = (user: string) => createHash("sha256").update(user).digest("hex");
const digest = "a".repeat(64);
let roleCreated = false;
let guarded = false;
function restricted() {
	if (!runtime) throw new Error("Runtime not initialized");
	return runtime;
}
async function context<T>(
	user: string,
	body: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await restricted().connect();
	let discard = false;
	try {
		await client.query("begin");
		await client.query("set local statement_timeout='15s'");
		await client.query("select set_config('ditero.user_id',$1,true)", [user]);
		const value = await body(client);
		await client.query("commit");
		return value;
	} catch (error) {
		try {
			await client.query("rollback");
		} catch (rollback) {
			discard = true;
			throw new AggregateError(
				[error, rollback],
				"ledger fixture rollback failed",
				{ cause: error },
			);
		}
		throw error;
	} finally {
		client.release(discard);
	}
}
async function association(
	client: PoolClient,
	user = owner,
	target = workspace(user),
	attachment = randomUUID(),
) {
	const id = randomUUID();
	const result = await client.query(
		`insert into attachment_migration(id,owner_user_id,import_source_id,source_attachment_id,source_fingerprint,source_metadata,origin_job_id,origin_item_ordinal,document_digest,mapping_digest,plan_digest,target_workspace_id,target_parent_kind,target_parent_id) values($1,$2,$3,$4,$5,'{}',$6,0,$5,$5,$6,$7,'list',$8) returning id`,
		[id, user, source(user), attachment, digest, job(user), target, list(user)],
	);
	expect(result.rowCount).toBe(1);
	return id;
}
async function attempt(
	client: PoolClient,
	id: string,
	user = owner,
	revision = 1,
	target = `migration_${randomUUID()}`,
) {
	const aid = randomUUID();
	await client.query(
		`insert into attachment_migration_attempt(id,association_id,owner_user_id,revision,target_attachment_id,job_id,key_version,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,ciphertext_sha256) values($1,$2,$3,$4,$5,$6,1,'filename','type','wrapped',50,$7)`,
		[aid, id, user, revision, target, job(user), digest],
	);
	return { aid, target };
}
async function adopt(client: PoolClient, id: string, user = owner) {
	const a = await attempt(client, id, user);
	expect(
		(
			await client.query(
				"update attachment_migration set revision=1,current_attempt_id=$2 where id=$1",
				[id, a.aid],
			)
		).rowCount,
	).toBe(1);
	return a;
}
async function attachment(client: PoolClient, target: string, user = owner) {
	await client.query(
		`insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,storage_key,uploaded_by,reservation_expires_at) values($1,$2,'list',$3,1,'filename','type','wrapped',50,$1,$4,clock_timestamp()+interval '1 hour')`,
		[target, workspace(user), list(user), user],
	);
}
async function snapshot(id: string) {
	return (
		await admin.query("select * from attachment_migration where id=$1", [id])
	).rows[0];
}
async function refused(body: () => Promise<unknown>, code: string) {
	await expect(body()).rejects.toMatchObject({ code });
}
beforeAll(async () => {
	try {
		expect(
			(await allocation.query("select current_database() database")).rows[0]
				.database,
		).toBe(expectedDatabase);
		expect(
			(
				await allocation.query(
					"select count(*)::int n from pg_database where datname=$1",
					[childDatabase],
				)
			).rows[0].n,
		).toBe(0);
		setupPhase = "allocation-intent";
		retainedDatabase = "may-exist";
		recordAllocation(setupPhase);
		try {
			await allocation.query(
				`create database "${childDatabase}" template template0`,
			);
		} catch (error) {
			// A lost acknowledgement cannot establish absence. Use a fresh connection
			// only to observe this exact generated name, never adopt or delete it.
			const observer = new Pool({
				connectionString: url,
				max: 1,
				connectionTimeoutMillis: 5_000,
				query_timeout: 5_000,
			});
			const failures: unknown[] = [error];
			try {
				expect(
					(await observer.query("select current_database() database")).rows[0]
						.database,
				).toBe(expectedDatabase);
				const count = (
					await observer.query(
						"select count(*)::int n from pg_database where datname=$1",
						[childDatabase],
					)
				).rows[0].n;
				expect([0, 1]).toContain(count);
				retainedDatabase = count === 1 ? "present" : "absent";
			} catch (observation) {
				retainedDatabase = "unknown";
				failures.push(observation);
			} finally {
				try {
					await observer.end();
				} catch (close) {
					failures.push(close);
				}
			}
			if (failures.length > 1)
				throw new AggregateError(
					failures,
					"child allocation observation failed",
					{ cause: error },
				);
			throw error;
		}
		allocated = true;
		retainedDatabase = "present";
		setupPhase = "allocated-unmigrated";
		recordAllocation("allocated-unmigrated");
		await migrate(drizzle(admin), {
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle", import.meta.url),
			),
		});
		setupPhase = "migrated";
		recordAllocation(setupPhase);
		expect(
			(await admin.query("select current_database() database")).rows[0]
				.database,
		).toBe(childDatabase);
		expect(
			(await admin.query('select count(*)::int n from "user"')).rows[0].n,
		).toBe(0);
		expect(
			(await admin.query("select count(*)::int n from attachment_migration"))
				.rows[0].n,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int n from pg_roles where rolname=$1",
					[role],
				)
			).rows[0].n,
		).toBe(0);
		guarded = true;
		for (const user of users) {
			await admin.query(
				'insert into "user"(id,name,email,email_verified) values($1,$1,$2,false)',
				[user, `${user}@example.invalid`],
			);
			await admin.query(
				"insert into workspace(id,name,owner_id,kind) values($1,$1,$2,'shared')",
				[workspace(user), user],
			);
			await admin.query(
				"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
				[`seat-${user}`, user, workspace(user)],
			);
			await admin.query(
				"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Fixture','a0')",
				[list(user), workspace(user), user],
			);
			await admin.query(
				"insert into import_source(id,owner_user_id,label,format,schema_version,source_user_id) values($1,$2,'Fixture','ditero',1,$2)",
				[source(user), user],
			);
			await admin.query(
				"insert into import_job(id,source_id,owner_user_id,document_digest,mapping_digest,plan_digest,planner_version,apply_supported,report,payload_bytes) values($1,$2,$3,$4,$4,$1,2,true,'{}',0)",
				[job(user), source(user), user, digest],
			);
			await admin.query(
				"insert into import_run(job_id,owner_user_id,state) values($1,$2,'completed')",
				[job(user), user],
			);
		}
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'viewer')",
			[`viewer-${scope}`, other, workspace(owner)],
		);
		const password = randomBytes(32).toString("hex");
		await admin.query(
			`create role ${role} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password ${escapeLiteral(password)}`,
		);
		roleCreated = true;
		await admin.query(`grant usage on schema public to ${role}`);
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to ${role}`,
		);
		const runtimeUrl = new URL(childUrl);
		runtimeUrl.username = role;
		runtimeUrl.password = password;
		runtime = new Pool({
			connectionString: runtimeUrl.toString(),
			connectionTimeoutMillis: 5000,
			query_timeout: 15000,
		});
		const proof = (
			await restricted().query(
				`select current_user,session_user,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolinherit,(select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid) memberships,(select count(*)::int from pg_class where relowner=r.oid) owned from pg_roles r where rolname=current_user`,
			)
		).rows[0];
		expect(proof).toEqual({
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
			rolcanlogin: true,
			rolinherit: false,
			memberships: 0,
			owned: 0,
		});
		const policies = (
			await admin.query(
				"select relname::text,relrowsecurity,relforcerowsecurity from pg_class where oid=any(array['attachment_migration'::regclass,'attachment_migration_attempt'::regclass]) order by relname",
			)
		).rows;
		expect(policies).toHaveLength(2);
		expect(
			policies.every((row) => row.relrowsecurity && row.relforcerowsecurity),
		).toBe(true);
		for (const table of [
			"attachment_migration",
			"attachment_migration_attempt",
		])
			for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"])
				expect(
					(
						await restricted().query(
							"select has_table_privilege(current_user,$1,$2) allowed",
							[table, privilege],
						)
					).rows[0].allowed,
				).toBe(true);
		setupPhase = "ready";
		setupOutcome = "passed";
		recordAllocation(setupPhase);
	} catch (error) {
		setupOutcome = "failed";
		try {
			recordAllocation("setup-failed");
		} catch (receipt) {
			throw new AggregateError([error, receipt], "setup receipt failed", {
				cause: error,
			});
		}
		throw error;
	}
}, 60000);

// SQL fixtures qualify ledger guards, not blob encryption or API authorization.
test("identity uniqueness and immutable provenance retain positive owner rows", async () => {
	const key = randomUUID();
	const id = await context(owner, (c) =>
		association(c, owner, workspace(owner), key),
	);
	const before = await snapshot(id);
	await refused(
		() => context(owner, (c) => association(c, owner, workspace(owner), key)),
		"23505",
	);
	for (const column of [
		"source_fingerprint",
		"document_digest",
		"mapping_digest",
	])
		await refused(
			() =>
				context(owner, (c) =>
					c.query(`update attachment_migration set ${column}=$2 where id=$1`, [
						id,
						"b".repeat(64),
					]),
				),
			"23514",
		);
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment_migration set source_metadata=$2 where id=$1",
					[id, { changed: true }],
				),
			),
		"23514",
	);
	for (const [column, value] of [
		["source_attachment_id", randomUUID()],
		["origin_job_id", "b".repeat(64)],
		["origin_item_ordinal", 1],
		["target_workspace_id", workspace(other)],
		["target_parent_id", list(other)],
		["target_parent_kind", "task"],
	] as const)
		await refused(
			() =>
				context(owner, (c) =>
					c.query(`update attachment_migration set ${column}=$2 where id=$1`, [
						id,
						value,
					]),
				),
			"23514",
		);
	expect(await snapshot(id)).toEqual(before);
	expect(
		(
			await context(owner, (c) =>
				c.query("select id from attachment_migration where id=$1", [id]),
			)
		).rowCount,
	).toBe(1);
});
test("deferred adoption commits only exact revision and rejects rebind", async () => {
	const id = await context(owner, (c) => association(c));
	const a = await context(owner, (c) => adopt(c, id));
	const before = await snapshot(id);
	await refused(() => context(owner, (c) => attempt(c, id, owner, 2)), "23514");
	await refused(
		() =>
			context(owner, (c) =>
				c.query("update attachment_migration set revision=2 where id=$1", [id]),
			),
		"23514",
	);
	await refused(
		() =>
			context(owner, async (c) => {
				const next = await attempt(c, id, owner, 2);
				await c.query(
					"update attachment_migration set revision=3,current_attempt_id=$2 where id=$1",
					[id, next.aid],
				);
			}),
		"23514",
	);
	await refused(
		() => context(owner, (c) => attempt(c, id, owner, 2, a.target)),
		"23505",
	);
	expect(await snapshot(id)).toEqual(before);
	const attemptBefore = (
		await admin.query(
			"select * from attachment_migration_attempt where id=$1",
			[a.aid],
		)
	).rows[0];
	expect(
		(
			await context(owner, (c) =>
				c.query(
					"update attachment_migration_attempt set declared_bytes=51 where id=$1",
					[a.aid],
				),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await context(owner, (c) =>
				c.query("delete from attachment_migration_attempt where id=$1", [
					a.aid,
				]),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await context(owner, (c) =>
				c.query("delete from attachment_migration where id=$1", [id]),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select * from attachment_migration_attempt where id=$1",
				[a.aid],
			)
		).rows[0],
	).toEqual(attemptBefore);
});
test("foreign owner and Viewer writes refuse with independent positive controls", async () => {
	const a = await context(owner, (c) => association(c));
	await context(owner, (c) => adopt(c, a));
	expect(
		(
			await context(owner, (c) =>
				c.query(
					"select id from attachment_migration_attempt where association_id=$1",
					[a],
				),
			)
		).rowCount,
	).toBe(1);
	const b = await context(other, (c) => association(c, other));
	await context(other, (c) => adopt(c, b, other));
	const before = await snapshot(a);
	expect(
		(
			await context(other, (c) =>
				c.query("select id from attachment_migration where id=$1", [b]),
			)
		).rowCount,
	).toBe(1);
	expect(
		(
			await context(other, (c) =>
				c.query("select id from attachment_migration where id=$1", [a]),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await context(other, (c) =>
				c.query("update attachment_migration set revision=1 where id=$1", [a]),
			)
		).rowCount,
	).toBe(0);
	expect(
		(
			await context(other, (c) =>
				c.query(
					"select id from attachment_migration_attempt where association_id=$1",
					[b],
				),
			)
		).rowCount,
	).toBe(1);
	expect(
		(
			await context(other, (c) =>
				c.query(
					"select id from attachment_migration_attempt where association_id=$1",
					[a],
				),
			)
		).rowCount,
	).toBe(0);
	await refused(() => context(other, (c) => association(c, owner)), "42501");
	await refused(
		() => context(other, (c) => association(c, other, workspace(owner))),
		"42501",
	);
	expect(await snapshot(a)).toEqual(before);
});
test("ordinary state update atomically acknowledges exact bytes and rolls back mismatches", async () => {
	const id = await context(owner, (c) => association(c));
	const a = await context(owner, async (c) => {
		const a = await adopt(c, id);
		await attachment(c, a.target);
		return a;
	});
	const before = await snapshot(id);
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment_migration set committed_attempt_id=current_attempt_id,committed_at=clock_timestamp() where id=$1",
					[id],
				),
			),
		"23514",
	);
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment set state='committed',observed_bytes=49,ciphertext_sha256=$2,committed_at=clock_timestamp() where id=$1",
					[a.target, digest],
				),
			),
		"23514",
	);
	expect(await snapshot(id)).toEqual(before);
	expect(
		(
			await admin.query(
				"select state,observed_bytes,committed_at from attachment where id=$1",
				[a.target],
			)
		).rows[0],
	).toEqual({ state: "reserved", observed_bytes: null, committed_at: null });
	await context(owner, (c) =>
		c.query(
			"update attachment set state='committed',observed_bytes=50,ciphertext_sha256=$2,committed_at=clock_timestamp() where id=$1",
			[a.target, digest],
		),
	);
	const ack = await snapshot(id);
	expect(ack.committed_attempt_id).toBe(a.aid);
	expect(ack.committed_at).toEqual(
		(
			await admin.query("select committed_at from attachment where id=$1", [
				a.target,
			])
		).rows[0].committed_at,
	);
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment_migration set committed_at=committed_at+interval '1 second' where id=$1",
					[id],
				),
			),
		"23514",
	);
});
test("missing and stale migration prefix attempts cannot commit ordinary attachments", async () => {
	const missing = `migration_${randomUUID()}`;
	await context(owner, (c) => attachment(c, missing));
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment set state='committed',observed_bytes=50,ciphertext_sha256=$2,committed_at=clock_timestamp() where id=$1",
					[missing, digest],
				),
			),
		"23514",
	);
	const id = await context(owner, (c) => association(c));
	const old = await context(owner, async (c) => {
		const a = await adopt(c, id);
		await attachment(c, a.target);
		await c.query("update attachment set state='aborted' where id=$1", [
			a.target,
		]);
		return a;
	});
	await context(owner, async (c) => {
		const next = await attempt(c, id, owner, 2);
		await c.query(
			"update attachment_migration set revision=2,current_attempt_id=$2 where id=$1",
			[id, next.aid],
		);
	});
	await refused(
		() =>
			context(owner, (c) =>
				c.query(
					"update attachment set state='committed',observed_bytes=50,ciphertext_sha256=$2,committed_at=clock_timestamp() where id=$1",
					[old.target, digest],
				),
			),
		"23514",
	);
	expect(
		(
			await admin.query(
				"select state from attachment where id=any($1::text[]) order by id",
				[[missing, old.target]],
			)
		).rows
			.map((row) => row.state)
			.sort(),
	).toEqual(["aborted", "reserved"]);
});
test("ledger survives ordinary target/source/job/parent deletion and owner deletion cascades both tables", async () => {
	const id = await context(owner, (c) => association(c));
	const a = await context(owner, async (c) => {
		const a = await adopt(c, id);
		await attachment(c, a.target);
		await c.query(
			"update attachment set state='committed',observed_bytes=50,ciphertext_sha256=$2,committed_at=clock_timestamp() where id=$1",
			[a.target, digest],
		);
		return a;
	});
	const before = await snapshot(id);
	const attempts = (
		await admin.query(
			"select * from attachment_migration_attempt where id=$1",
			[a.aid],
		)
	).rows;
	await admin.query("delete from attachment where workspace_id=$1", [
		workspace(owner),
	]);
	await admin.query("delete from list where id=$1", [list(owner)]);
	await admin.query(
		"delete from import_source where id=$1 and owner_user_id=$2",
		[source(owner), owner],
	);
	await admin.query("delete from membership where workspace_id=$1", [
		workspace(owner),
	]);
	await admin.query("delete from workspace where id=$1 and owner_id=$2", [
		workspace(owner),
		owner,
	]);
	expect(await snapshot(id)).toEqual(before);
	expect(
		(
			await admin.query(
				"select * from attachment_migration_attempt where id=$1",
				[a.aid],
			)
		).rows,
	).toEqual(attempts);
	expect(
		(
			await admin.query("select count(*)::int n from import_job where id=$1", [
				job(owner),
			])
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await context(owner, (c) =>
				c.query("select id from attachment_migration where id=$1", [id]),
			)
		).rowCount,
	).toBe(1);
	const otherBefore = (
		await admin.query(
			"select count(*)::int n from attachment_migration where owner_user_id=$1",
			[other],
		)
	).rows[0].n;
	expect(otherBefore).toBeGreaterThan(0);
	await admin.query('delete from "user" where id=$1', [owner]);
	for (const table of ["attachment_migration", "attachment_migration_attempt"])
		expect(
			(
				await admin.query(
					`select count(*)::int n from ${table} where owner_user_id=$1`,
					[owner],
				)
			).rows[0].n,
		).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration where owner_user_id=$1",
				[other],
			)
		).rows[0].n,
	).toBe(otherBefore);
});
afterAll(async () => {
	const errors: unknown[] = [];
	async function check(body: () => Promise<unknown>) {
		try {
			await body();
		} catch (error) {
			errors.push(error);
		}
	}
	await check(async () => runtime?.end());
	if (guarded)
		await check(async () => {
			const actual = (await admin.query('select id from "user"')).rows;
			expect(actual.every((row) => users.includes(row.id))).toBe(true);
			const spaces = (await admin.query("select id,owner_id from workspace"))
				.rows;
			expect(
				spaces.every(
					(row) =>
						users.includes(row.owner_id) && row.id === workspace(row.owner_id),
				),
			).toBe(true);
			await admin.query(
				"delete from attachment where workspace_id=any($1::text[])",
				[users.map(workspace)],
			);
			await admin.query("delete from list where id=any($1::text[])", [
				users.map(list),
			]);
			await admin.query(
				"delete from import_source where owner_user_id=any($1::text[])",
				[users],
			);
			await admin.query(
				"delete from membership where workspace_id=any($1::text[])",
				[users.map(workspace)],
			);
			await admin.query(
				"delete from workspace where id=any($1::text[]) and owner_id=any($2::text[])",
				[users.map(workspace), users],
			);
			await admin.query('delete from "user" where id=any($1::text[])', [users]);
			for (const table of [
				"attachment_migration",
				"attachment_migration_attempt",
			])
				expect(
					(await admin.query(`select count(*)::int n from ${table}`)).rows[0].n,
				).toBe(0);
		});
	if (roleCreated)
		await check(async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where usename=$1",
						[role],
					)
				).rows[0].n,
			).toBe(0);
			expect(
				(
					await admin.query(
						"select (select count(*)::int from pg_class where relowner=r.oid) owned,(select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid) memberships from pg_roles r where rolname=$1",
						[role],
					)
				).rows[0],
			).toEqual({ owned: 0, memberships: 0 });
			await admin.query(
				`revoke select,insert,update,delete on all tables in schema public from ${role}`,
			);
			await admin.query(`revoke usage on schema public from ${role}`);
			await admin.query(`drop role ${role}`);
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_roles where rolname=$1",
						[role],
					)
				).rows[0].n,
			).toBe(0);
			roleDropped = true;
		});
	await check(() => admin.end());
	await check(() => allocation.end());
	await check(async () => recordAllocation("final-retained", errors.length));
	if (errors.length)
		throw new AggregateError(errors, "ledger fixture cleanup failed");
});
