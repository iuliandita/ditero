import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import { getAttachmentMigrationParents } from "../../src/server/portability/attachment-migration-parents.ts";
import {
	exportPortableJson,
	exportPortableJsonV2,
} from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import {
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";

const url = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_ATTACHMENT_PARENT_TEST_DATABASE ?? "ditero_e2e";
if (
	!url ||
	process.env.NODE_ENV !== "test" ||
	!/^[-a-zA-Z0-9_]{1,63}$/.test(expectedDatabase) ||
	new URL(url).pathname !== `/${expectedDatabase}`
)
	throw new Error("Exact test database and NODE_ENV=test are required");
const scope = randomUUID().replaceAll("-", "");
const childDatabase = `ditero_attachment_parents_${scope}`;
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
let receiptPath = process.env.DITERO_ATTACHMENT_PARENT_TEST_RECEIPT;
let receiptCreated = false;
function recordAllocation(state: string, cleanupFailures = 0) {
	if (!receiptPath) {
		const directory = mkdtempSync(join(tmpdir(), "ditero-attachment-parents-"));
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
				retainedLedger: [...retainedLedger.values()],
				cleanupFailures,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, flag: receiptCreated ? "w" : "wx" },
	);
	receiptCreated = true;
}
const role = `ditero_parent_test_${scope}`;
const owner = `parent-owner-${scope}`;
const outsider = `parent-outsider-${scope}`;
const sourceWorkspace = `parent-source-${scope}`;
const targetWorkspace = `parent-target-${scope}`;
const sourceSeat = `parent-source-seat-${scope}`;
const targetSeat = `parent-target-seat-${scope}`;
const list = `parent-list-${scope}`;
const task = `parent-task-${scope}`;
const comment = `parent-comment-${scope}`;
const users = [owner, outsider];
const workspaces = [sourceWorkspace, targetWorkspace];
const sources = new Set<string>();
const jobs = new Set<string>();
const retainedLedger = new Map<string, Record<string, unknown>>();
let guarded = false;
let roleCreated = false;
function restricted() {
	if (!runtime) throw new Error("restricted pool not initialized");
	return runtime;
}

async function roleProof() {
	const row = (
		await restricted().query(`select session_user,current_user,r.rolsuper,r.rolbypassrls,r.rolinherit,r.rolcanlogin,
 (select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid) memberships,
 (select count(*)::int from pg_class where relowner=r.oid) owned from pg_roles r where r.rolname=current_user`)
	).rows[0];
	expect(row).toEqual({
		session_user: role,
		current_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolinherit: false,
		rolcanlogin: true,
		memberships: 0,
		owned: 0,
	});
}
async function cleanupRows() {
	if (!guarded) return;
	const client = await admin.connect();
	let discard = false;
	try {
		await client.query("begin");
		const rows = (
			await client.query(
				"select id,owner_id from workspace where id=any($1::text[]) for update",
				[workspaces],
			)
		).rows;
		expect(
			rows.every(
				(row) => workspaces.includes(row.id) && row.owner_id === owner,
			),
		).toBe(true);
		const seats = (
			await client.query(
				"select id,user_id,workspace_id from membership where workspace_id=any($1::text[]) or user_id=any($2::text[])",
				[workspaces, users],
			)
		).rows;
		expect(
			seats.every(
				(row) =>
					row.user_id === owner &&
					((row.id === sourceSeat && row.workspace_id === sourceWorkspace) ||
						(row.id === targetSeat && row.workspace_id === targetWorkspace)),
			),
		).toBe(true);
		const actualSources = (
			await client.query(
				"select id,owner_user_id from import_source where owner_user_id=any($1::text[])",
				[users],
			)
		).rows;
		expect(
			actualSources.every(
				(row) => row.owner_user_id === owner && sources.has(row.id),
			),
		).toBe(true);
		// Tombstones have no parent/account FK. Only this job's generated historical
		// target and external source tuple identify our rows; never truncate them.
		const ledger = (
			await client.query(
				`select h.* from import_history_ledger h join import_item i on i.target_id=h.target_id and i.collection=h.collection::text
   join import_job j on j.id=i.job_id where j.owner_user_id=$1 and j.id=any($2::text[]) and h.collection='comments'
   and h.target_parent_id in (select t.id from task t join list l on l.id=t.list_id where l.workspace_id=$3)`,
				[owner, [...jobs], targetWorkspace],
			)
		).rows;
		for (const row of ledger) {
			const previous = retainedLedger.get(row.id);
			if (previous) expect(row).toEqual(previous);
			else retainedLedger.set(row.id, row);
		}
		// Immutable ledger tombstones intentionally survive this purpose fixture.
		// Register their exact generated tuples, then require no foreign residual.
		expect(
			(await client.query("select * from import_history_ledger order by id"))
				.rows,
		).toEqual(
			[...retainedLedger.values()].sort((a, b) =>
				String(a.id).localeCompare(String(b.id)),
			),
		);
		await client.query(
			"delete from import_source where owner_user_id=$1 and id=any($2::text[])",
			[owner, [...sources]],
		);
		await client.query(
			"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
			[workspaces],
		);
		await client.query("delete from list where workspace_id=any($1::text[])", [
			workspaces,
		]);
		await client.query(
			"delete from membership where id=any($1::text[]) and user_id=$2 and workspace_id=any($3::text[])",
			[[sourceSeat, targetSeat], owner, workspaces],
		);
		await client.query(
			"delete from workspace where id=any($1::text[]) and owner_id=$2",
			[workspaces, owner],
		);
		await client.query('delete from "user" where id=any($1::text[])', [users]);
		await client.query("commit");
	} catch (error) {
		try {
			await client.query("rollback");
		} catch (rollback) {
			discard = true;
			throw new AggregateError([error, rollback], "fixture cleanup failed", {
				cause: error,
			});
		}
		throw error;
	} finally {
		client.release(discard);
	}
	expect(
		(
			await admin.query(
				`select (select count(*)::int from "user" where id=any($1::text[])) users,
  (select count(*)::int from workspace where id=any($2::text[])) workspaces,
  (select count(*)::int from import_source where owner_user_id=any($1::text[])) sources`,
				[users, workspaces],
			)
		).rows[0],
	).toEqual({ users: 0, workspaces: 0, sources: 0 });
	sources.clear();
	jobs.clear();
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
		// Require pristine identities, never adopt an existing role or fixture.
		expect(
			(
				await admin.query(
					"select count(*)::int n from pg_roles where rolname=$1",
					[role],
				)
			).rows[0].n,
		).toBe(0);
		expect(
			(
				await admin.query(
					'select count(*)::int n from "user" where id=any($1::text[])',
					[users],
				)
			).rows[0].n,
		).toBe(0);
		expect(
			(await admin.query("select count(*)::int n from import_history_ledger"))
				.rows[0].n,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int n from import_history_redaction",
				)
			).rows[0].n,
		).toBe(0);
		guarded = true;
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
			application_name: `attachment-parent-${scope}`,
		});
		await roleProof();
		const policies = (
			await admin.query(
				"select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname",
				[
					[
						"import_source",
						"import_job",
						"import_item",
						"import_run",
						"import_source_map",
						"import_workspace_map",
						"import_history_ledger",
					],
				],
			)
		).rows;
		expect(policies).toHaveLength(7);
		expect(policies.every((row) => row.relrowsecurity === true)).toBe(true);
		setupPhase = "ready";
		setupOutcome = "passed";
		recordAllocation(setupPhase);
	} catch (error) {
		setupOutcome = "failed";
		try {
			recordAllocation("setup-failed");
		} catch (receiptError) {
			throw new AggregateError(
				[error, receiptError],
				"fixture setup and receipt failed",
				{ cause: error },
			);
		}
		throw error;
	}
}, 60_000);
beforeEach(async () => {
	await cleanupRows();
	for (const id of users)
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$1,$2,false)',
			[id, `${id}@example.invalid`],
		);
	for (const id of workspaces)
		await admin.query(
			"insert into workspace(id,name,owner_id,kind) values($1,$1,$2,'shared')",
			[id, owner],
		);
	for (const [id, workspace] of [
		[sourceSeat, sourceWorkspace],
		[targetSeat, targetWorkspace],
	])
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
			[id, owner, workspace],
		);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Source list','a0')",
		[list, sourceWorkspace, owner],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Source task','a0')",
		[task, list],
	);
	await admin.query(
		"insert into comment(id,task_id,author_id,body,created_at) values($1,$2,$3,'Original history','2020-01-02T03:04:05Z')",
		[comment, task, owner],
	);
});
afterAll(async () => {
	const errors: unknown[] = [];
	async function attempt(operation: () => Promise<unknown>) {
		try {
			await operation();
		} catch (error) {
			errors.push(error);
		}
	}
	await attempt(async () => runtime?.end());
	await attempt(cleanupRows);
	if (roleCreated)
		await attempt(async () => {
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
	await attempt(async () => {
		if (guarded) {
			expect(retainedLedger.size).toBe(1);
			expect(
				(await admin.query("select * from import_history_ledger order by id"))
					.rows,
			).toEqual([...retainedLedger.values()]);
		}
	});
	await attempt(() => admin.end());
	await attempt(() => allocation.end());
	await attempt(async () => recordAllocation("final-retained", errors.length));
	if (errors.length)
		throw new AggregateError(errors, "parent fixture final checks failed");
});

function attachment(
	id: string,
	parentKind: "list" | "task" | "comment",
	parentId: string,
): PortableExportV1["data"]["attachments"][number] {
	return {
		id,
		workspaceId: sourceWorkspace,
		parentKind,
		parentId,
		keyVersion: 1,
		declaredBytes: 50,
		observedBytes: 50,
		ciphertextSha256: "a".repeat(64),
		thumbnailDeclaredBytes: null,
		thumbnailObservedBytes: null,
		thumbnailCiphertextSha256: null,
		uploadedBy: owner,
		createdAt: "2026-10-05T00:00:00.000Z",
		committedAt: "2026-10-05T00:00:00.000Z",
	};
}
async function save(history = false) {
	const document: PortableExportV1 | PortableExportV2 = history
		? JSON.parse(await exportPortableJsonV2(admin, owner))
		: JSON.parse(await exportPortableJson(admin, owner));
	// Attachment metadata is intentionally ignored by normal apply. Real planner
	// hashing/freezing must create its evidence; no manually forged import_item.
	document.data.attachments = [
		attachment(`list-file-${scope}`, "list", list),
		attachment(`task-file-${scope}`, "task", task),
	];
	let archiveComment: string | null = null;
	if (document.schemaVersion === 2) {
		const original = document.data.comments[0];
		if (!original) throw new Error("source comment missing");
		archiveComment = `archive-comment-${scope}`;
		expect(original.sourceRef.id).toBe(comment);
		document.data.comments = [{ ...original, id: archiveComment }];
		document.data.attachments.push(
			attachment(`comment-file-${scope}`, "comment", archiveComment),
		);
	}
	const source = {
		mode: "new" as const,
		id: randomUUID(),
		label: "Parent discovery fixture",
	};
	sources.add(source.id);
	const mappings = {
		workspaces: Object.fromEntries(
			document.data.workspaces.map((row) => [
				row.id,
				row.id === sourceWorkspace ? targetWorkspace : row.id,
			]),
		),
		principals: Object.fromEntries(
			document.data.principals.map((row) => [
				row.id,
				row.id === owner ? owner : null,
			]),
		),
	};
	const job = await saveImportPlan(
		restricted(),
		owner,
		source,
		document,
		mappings,
		{ plannerVersion: 4, historyApply: history },
	);
	jobs.add(job.id);
	return { job, source, document, archiveComment };
}
async function finish(job: ImportPlanStatus) {
	const confirmation = {
		planDigest: job.planDigest,
		counts: job.report.counts,
	};
	let run = await applyImportBatch(restricted(), owner, job.id, confirmation);
	for (let batch = 0; run.state === "running" && batch < 10; batch++)
		run = await applyImportBatch(restricted(), owner, job.id, confirmation);
	expect(run.state).toBe("completed");
	return run;
}
async function mapped(
	sourceId: string,
	collection: string,
	sourceRowId: string,
) {
	const rows = (
		await admin.query(
			"select target_id from import_source_map where source_id=$1 and owner_user_id=$2 and collection=$3 and source_row_id=$4",
			[sourceId, owner, collection, sourceRowId],
		)
	).rows;
	expect(rows).toHaveLength(1);
	return rows[0].target_id as string;
}
async function discover(job: ImportPlanStatus) {
	await roleProof();
	return getAttachmentMigrationParents(restricted(), owner, job.id);
}

test("restricted runtime resolves real completed applied list/task parents and keyset pages", async () => {
	const f = await save();
	await expect(
		getAttachmentMigrationParents(restricted(), owner, f.job.id),
	).rejects.toMatchObject({ code: "plan-not-found", status: 404 });
	await finish(f.job);
	const first = await getAttachmentMigrationParents(
		restricted(),
		owner,
		f.job.id,
		{ limit: 1 },
	);
	expect(first.items).toHaveLength(1);
	expect(first.nextAfterOrdinal).not.toBeNull();
	const second = await getAttachmentMigrationParents(
		restricted(),
		owner,
		f.job.id,
		{ limit: 1, afterOrdinal: first.nextAfterOrdinal ?? -1 },
	);
	expect(second.items).toHaveLength(1);
	expect(second.nextAfterOrdinal).toBeNull();
	const result = await discover(f.job);
	expect([...first.items, ...second.items]).toEqual(result.items);
	expect(result).toMatchObject({
		ownerId: owner,
		jobId: f.job.id,
		sourceId: f.source.id,
		planDigest: f.job.planDigest,
		documentDigest: f.job.documentDigest,
		mappingDigest: f.job.mappingDigest,
	});
	expect(result.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				sourceAttachmentId: `list-file-${scope}`,
				blockedReason: null,
				destinationParent: {
					kind: "list",
					id: await mapped(f.source.id, "lists", list),
					workspaceId: targetWorkspace,
				},
			}),
			expect.objectContaining({
				sourceAttachmentId: `task-file-${scope}`,
				blockedReason: null,
				destinationParent: {
					kind: "task",
					id: await mapped(f.source.id, "tasks", task),
					workspaceId: targetWorkspace,
				},
			}),
		]),
	);
	expect(
		result.items.every((item) =>
			/^[a-f0-9]{64}$/.test(item.sourceAttachmentFingerprint),
		),
	).toBe(true);
});
test("crossowner cannot enumerate a real job under forced request-local RLS", async () => {
	const f = await save();
	await finish(f.job);
	expect((await discover(f.job)).items).toHaveLength(2);
	const own = await withUserContext(restricted(), owner, (client) =>
		client.query("select id from import_job where id=$1", [f.job.id]),
	);
	expect(own.rows).toHaveLength(1);
	const foreign = await withUserContext(restricted(), outsider, (client) =>
		client.query("select id from import_job where id=$1", [f.job.id]),
	);
	expect(foreign.rows).toHaveLength(0);
	await expect(
		getAttachmentMigrationParents(restricted(), outsider, f.job.id),
	).rejects.toMatchObject({ code: "plan-not-found", status: 404 });
});
test("Viewer and removed membership refuse after a real positive discovery", async () => {
	const f = await save();
	await finish(f.job);
	expect(
		(await discover(f.job)).items.every((item) => item.blockedReason === null),
	).toBe(true);
	await admin.query(
		"update membership set role='viewer' where id=$1 and user_id=$2 and workspace_id=$3",
		[targetSeat, owner, targetWorkspace],
	);
	expect(
		(await discover(f.job)).items.every(
			(item) =>
				item.blockedReason === "not-permitted" &&
				item.destinationParent === null,
		),
	).toBe(true);
	await admin.query(
		"delete from membership where id=$1 and user_id=$2 and workspace_id=$3",
		[targetSeat, owner, targetWorkspace],
	);
	expect(
		(await discover(f.job)).items.every(
			(item) =>
				item.blockedReason === "not-permitted" &&
				item.destinationParent === null,
		),
	).toBe(true);
});
test("changed and deleted applied task parents refuse without inventing a replacement", async () => {
	const f = await save();
	await finish(f.job);
	const target = await mapped(f.source.id, "tasks", task);
	expect(
		(await discover(f.job)).items.find(
			(item) => item.sourceAttachmentId === `task-file-${scope}`,
		)?.blockedReason,
	).toBeNull();
	await admin.query(
		"update task set title='Edited after apply' where id=$1 and list_id in(select id from list where workspace_id=$2)",
		[target, targetWorkspace],
	);
	expect(
		(await discover(f.job)).items.find(
			(item) => item.sourceAttachmentId === `task-file-${scope}`,
		),
	).toMatchObject({ destinationParent: null, blockedReason: "parent-changed" });
	await admin.query(
		"delete from task where id=$1 and list_id in(select id from list where workspace_id=$2)",
		[target, targetWorkspace],
	);
	expect(
		(await discover(f.job)).items.find(
			(item) => item.sourceAttachmentId === `task-file-${scope}`,
		),
	).toMatchObject({
		destinationParent: null,
		blockedReason: "parent-unavailable",
	});
});
test("immutable source-map identity refuses remap and preserves proven discovery", async () => {
	const f = await save();
	await finish(f.job);
	const originalTarget = await mapped(f.source.id, "tasks", task);
	const before = await discover(f.job);
	expect(before.items.every((item) => item.blockedReason === null)).toBe(true);
	await expect(
		admin.query(
			"update import_source_map set target_id=$1 where source_id=$2 and owner_user_id=$3 and collection='tasks' and source_row_id=$4",
			[`unproven-target-${scope}`, f.source.id, owner, task],
		),
	).rejects.toMatchObject({ code: "23514" });
	expect(await mapped(f.source.id, "tasks", task)).toBe(originalTarget);
	expect(await discover(f.job)).toEqual(before);
});
test("historical comment archive identity resolves through its distinct external sourceRef ledger", async () => {
	const f = await save(true);
	expect(f.job.report).toMatchObject({
		plannerVersion: 5,
		applySupported: true,
	});
	await finish(f.job);
	const result = await discover(f.job);
	expect(result.items).toHaveLength(3);
	const item = result.items.find(
		(row) => row.sourceAttachmentId === `comment-file-${scope}`,
	);
	expect(item?.blockedReason).toBeNull();
	expect(item?.destinationParent?.kind).toBe("comment");
	const target = item?.destinationParent?.id;
	if (!target) throw new Error("historical target missing");
	const ledger = (
		await admin.query(
			"select collection,target_id,source_row_id,source_namespace from import_history_ledger where target_id=$1",
			[target],
		)
	).rows;
	expect(ledger).toHaveLength(1);
	expect(ledger[0].source_row_id).toBe(comment);
	expect(ledger[0].source_row_id).not.toBe(f.archiveComment);
	expect(ledger[0].source_namespace).toBe(
		(f.document as PortableExportV2).data.comments[0]?.sourceRef.namespace,
	);
	const fullLedger = (
		await admin.query(
			"select * from import_history_ledger where target_id=$1 and collection='comments' and source_row_id=$2",
			[target, comment],
		)
	).rows;
	expect(fullLedger).toHaveLength(1);
	retainedLedger.set(fullLedger[0].id, fullLedger[0]);
	await admin.query(
		"delete from comment where id=$1 and task_id in (select t.id from task t join list l on l.id=t.list_id where l.workspace_id=$2)",
		[target, targetWorkspace],
	);
	expect(
		(await discover(f.job)).items.find(
			(row) => row.sourceAttachmentId === `comment-file-${scope}`,
		),
	).toMatchObject({
		destinationParent: null,
		blockedReason: "parent-unavailable",
	});
});
