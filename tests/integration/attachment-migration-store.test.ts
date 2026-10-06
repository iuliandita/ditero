import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Elysia } from "elysia";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { storageKeyFor } from "../../src/domain/attachment.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import type { PortableExportV2 } from "../../src/domain/portability/v2.ts";
import {
	type AttachmentGuards,
	attachmentRoutes,
} from "../../src/server/attachments/routes.ts";
import { getAttachmentMigrationParents } from "../../src/server/portability/attachment-migration-parents.ts";
import {
	getAttachmentMigrationStatus,
	reserveAttachmentMigration,
} from "../../src/server/portability/attachment-migration-store.ts";
import {
	exportPortableJson,
	exportPortableJsonV2,
} from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import {
	type ImportPlanStatus,
	saveImportPlan,
} from "../../src/server/portability/import-plan-store.ts";
import {
	BlobNotFoundError,
	type BlobStore,
} from "../../src/server/storage/blob-store.ts";

const originalE2e = process.env.DITERO_E2E_ENABLED;
const url = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_ATTACHMENT_STORE_TEST_DATABASE ?? "ditero_e2e";
if (
	!url ||
	process.env.NODE_ENV !== "test" ||
	!/^[-a-zA-Z0-9_]{1,63}$/.test(expectedDatabase) ||
	new URL(url).pathname !== `/${expectedDatabase}`
)
	throw new Error("Exact test database and NODE_ENV=test are required");
const scope = randomUUID().replaceAll("-", "");
const childDatabase = `ditero_attachment_store_${scope}`;
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
let receiptPath = process.env.DITERO_ATTACHMENT_STORE_TEST_RECEIPT;
let receiptCreated = false;
function recordAllocation(state: string, cleanupFailures = 0) {
	if (!receiptPath) {
		const directory = mkdtempSync(join(tmpdir(), "ditero-attachment-store-"));
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
const role = `ditero_store_test_${scope}`;
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
			"delete from attachment where workspace_id=any($1::text[])",
			[workspaces],
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
	process.env.DITERO_E2E_ENABLED = "true";
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
			expect(retainedLedger.size).toBe(0);
			expect(
				(await admin.query("select * from import_history_ledger order by id"))
					.rows,
			).toEqual([...retainedLedger.values()]);
		}
	});
	await attempt(() => admin.end());
	await attempt(() => allocation.end());
	await attempt(async () => recordAllocation("final-retained", errors.length));
	if (originalE2e === undefined) delete process.env.DITERO_E2E_ENABLED;
	else process.env.DITERO_E2E_ENABLED = originalE2e;
	if (errors.length)
		throw new AggregateError(errors, "store fixture final checks failed");
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
async function discover(job: ImportPlanStatus) {
	await roleProof();
	return getAttachmentMigrationParents(restricted(), owner, job.id);
}

const content = new Uint8Array(50).fill(1);
const targetHash = createHash("sha256").update(content).digest("hex");
async function ready() {
	const f = await save();
	await finish(f.job);
	const discovery = await discover(f.job);
	const row = discovery.items.find(
		(item) => item.sourceAttachmentId === `list-file-${scope}`,
	);
	if (!row?.destinationParent || row.blockedReason)
		throw new Error("Positive mapped parent missing");
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values($1,$2,1,'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',$3)",
		[`key-${randomUUID()}`, targetWorkspace, owner],
	);
	await admin.query(
		"insert into membership_key(id,membership_id,user_id,workspace_id,key_version,enc,ciphertext,recipient_public_key,granted_by) values($1,$2,$3,$4,1,'enc','cipher','pk',$3)",
		[`wrap-${randomUUID()}`, targetSeat, owner, targetWorkspace],
	);
	const request = {
		ownerId: owner,
		jobId: f.job.id,
		ordinal: row.ordinal,
		sourceFingerprint: row.sourceAttachmentFingerprint,
		expectedRevision: 0,
		prepared: {
			id: `migration_${randomUUID()}`,
			keyVersion: 1,
			filenameCiphertext: "encrypted-name",
			contentTypeCiphertext: "encrypted-type",
			dekWrapped: "wrapped",
			declaredBytes: 50,
			ciphertextSha256: targetHash,
		},
	};
	return { ...f, row, request };
}
async function exactCounts(id: string) {
	return (
		await admin.query(
			`select (select count(*)::int from attachment_migration where id=$1) associations,(select count(*)::int from attachment_migration_attempt where association_id=$1) attempts,(select count(*)::int from attachment where id=$2) attachments`,
			[
				id,
				(
					await admin.query(
						"select a.target_attachment_id from attachment_migration_attempt a where a.association_id=$1",
						[id],
					)
				).rows[0]?.target_attachment_id ?? "absent",
			],
		)
	).rows[0];
}
async function assertNoReservation(
	target: string,
	jobId: string,
	ordinal: number,
) {
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration where owner_user_id=$1 and origin_job_id=$2 and origin_item_ordinal=$3",
				[owner, jobId, ordinal],
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query("select count(*)::int n from attachment where id=$1", [
				target,
			])
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration_attempt where target_attachment_id=$1",
				[target],
			)
		).rows[0].n,
	).toBe(0);
}
function memoryStore(): BlobStore {
	const objects = new Map<string, Uint8Array>();
	return {
		async put(key, body) {
			const chunks: Uint8Array[] = [];
			let length = 0;
			for await (const chunk of body) {
				chunks.push(chunk);
				length += chunk.length;
			}
			const data = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				data.set(chunk, offset);
				offset += chunk.length;
			}
			objects.set(key, data);
			return {
				bytes: length,
				sha256: createHash("sha256").update(data).digest("hex"),
			};
		},
		async get(key) {
			const value = objects.get(key);
			if (!value) throw new BlobNotFoundError(key);
			return (async function* () {
				yield value;
			})();
		},
		async delete(key) {
			objects.delete(key);
		},
		async exists(key) {
			return objects.has(key);
		},
	};
}
function ordinaryApp() {
	const guards: AttachmentGuards = {
		guardedGet:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: owner } }),
		guardedPost:
			(handler) =>
			async ({ request }) =>
				handler(request, { user: { id: owner } }),
	};
	return new Elysia().use(
		attachmentRoutes(restricted(), guards, memoryStore()),
	);
}
async function ordinaryCommit(target: string) {
	const app = ordinaryApp();
	const upload = await app.handle(
		new Request(`http://localhost/api/attachments/${target}/upload`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: content.slice().buffer,
		}),
	);
	expect(upload.status).toBe(200);
	const finalize = await app.handle(
		new Request("http://localhost/api/attachments/finalize", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: target }),
		}),
	);
	expect(finalize.status).toBe(200);
}

test("first reserve and identical lost-response replay have one immutable attempt; changed preparation refuses", async () => {
	const f = await ready();
	const first = await reserveAttachmentMigration(restricted(), f.request);
	const replay = await reserveAttachmentMigration(restricted(), f.request);
	expect(replay).toEqual(first);
	expect(await exactCounts(first.associationId)).toEqual({
		associations: 1,
		attempts: 1,
		attachments: 1,
	});
	await expect(
		reserveAttachmentMigration(restricted(), {
			...f.request,
			prepared: { ...f.request.prepared, filenameCiphertext: "different" },
		}),
	).rejects.toMatchObject({ code: "migration-preparation-conflict" });
	expect(await exactCounts(first.associationId)).toEqual({
		associations: 1,
		attempts: 1,
		attachments: 1,
	});
});
test("globally claimed attempt and ordinary attachment targets refuse without partial reservation", async () => {
	const f = await ready();
	const first = await reserveAttachmentMigration(restricted(), f.request);
	expect(await exactCounts(first.associationId)).toEqual({
		associations: 1,
		attempts: 1,
		attachments: 1,
	});
	const second = await save();
	await finish(second.job);
	const row = (await discover(second.job)).items.find(
		(item) => item.sourceAttachmentId === `list-file-${scope}`,
	);
	if (!row?.destinationParent || row.blockedReason)
		throw new Error("Distinct collision parent missing");
	expect(second.source.id).not.toBe(f.source.id);
	expect(second.job.id).not.toBe(f.job.id);
	const request = {
		...f.request,
		jobId: second.job.id,
		ordinal: row.ordinal,
		sourceFingerprint: row.sourceAttachmentFingerprint,
	};
	const snapshot = async () => ({
		associations: (
			await admin.query("select * from attachment_migration order by id")
		).rows,
		attempts: (
			await admin.query(
				"select * from attachment_migration_attempt order by id",
			)
		).rows,
		attachments: (await admin.query("select * from attachment order by id"))
			.rows,
	});
	const before = await snapshot();
	await expect(
		reserveAttachmentMigration(restricted(), request),
	).rejects.toMatchObject({ code: "migration-target-conflict", status: 409 });
	expect(await snapshot()).toEqual(before);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration where owner_user_id=$1 and origin_job_id=$2 and origin_item_ordinal=$3",
				[owner, second.job.id, row.ordinal],
			)
		).rows[0].n,
	).toBe(0);
	expect(await exactCounts(first.associationId)).toEqual({
		associations: 1,
		attempts: 1,
		attachments: 1,
	});

	// A separate synthetic ordinary row claims a target with no migration attempt.
	const ordinaryTarget = `migration_${randomUUID()}`;
	expect(
		(
			await admin.query("select count(*)::int n from attachment where id=$1", [
				ordinaryTarget,
			])
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				`insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,thumbnail_declared_bytes,storage_key,thumbnail_storage_key,uploaded_by,reservation_expires_at)
 select $1,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,thumbnail_declared_bytes,$2,thumbnail_storage_key,uploaded_by,reservation_expires_at
 from attachment where id=$3 and uploaded_by=$4 and workspace_id=$5 returning id`,
				[
					ordinaryTarget,
					storageKeyFor(targetWorkspace, ordinaryTarget),
					f.request.prepared.id,
					owner,
					targetWorkspace,
				],
			)
		).rows,
	).toEqual([{ id: ordinaryTarget }]);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration_attempt where target_attachment_id=$1",
				[ordinaryTarget],
			)
		).rows[0].n,
	).toBe(0);
	const beforeOrdinary = await snapshot();
	await expect(
		reserveAttachmentMigration(restricted(), {
			...request,
			prepared: { ...request.prepared, id: ordinaryTarget },
		}),
	).rejects.toMatchObject({ code: "migration-target-conflict", status: 409 });
	expect(await snapshot()).toEqual(beforeOrdinary);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration where owner_user_id=$1 and origin_job_id=$2 and origin_item_ordinal=$3",
				[owner, second.job.id, row.ordinal],
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int n from attachment_migration_attempt where target_attachment_id=$1",
				[ordinaryTarget],
			)
		).rows[0].n,
	).toBe(0);
});
test("ordinary upload/finalize atomically latches acknowledgment and retained replay survives target/source/job deletion", async () => {
	const f = await ready();
	const first = await reserveAttachmentMigration(restricted(), f.request);
	await ordinaryCommit(f.request.prepared.id);
	const status = await getAttachmentMigrationStatus(
		restricted(),
		owner,
		f.job.id,
		f.row.ordinal,
	);
	expect(status.committed).toBe(true);
	expect(status.attemptId).toBe(first.attemptId);
	const before = (
		await admin.query("select * from attachment_migration where id=$1", [
			first.associationId,
		])
	).rows;
	expect(status.committedAt).toEqual(
		(
			await admin.query("select committed_at from attachment where id=$1", [
				f.request.prepared.id,
			])
		).rows[0].committed_at,
	);
	await admin.query("delete from attachment where id=$1 and uploaded_by=$2", [
		f.request.prepared.id,
		owner,
	]);
	await admin.query(
		"delete from import_source where id=$1 and owner_user_id=$2",
		[f.source.id, owner],
	);
	expect(
		(
			await admin.query("select count(*)::int n from import_job where id=$1", [
				f.job.id,
			])
		).rows[0].n,
	).toBe(0);
	const replay = await reserveAttachmentMigration(restricted(), f.request);
	expect(replay).toMatchObject({
		associationId: first.associationId,
		attemptId: first.attemptId,
		committed: true,
		attachmentState: null,
	});
	expect(
		(
			await admin.query("select * from attachment_migration where id=$1", [
				first.associationId,
			])
		).rows,
	).toEqual(before);
	expect(
		(
			await admin.query("select count(*)::int n from attachment where id=$1", [
				f.request.prepared.id,
			])
		).rows[0].n,
	).toBe(0);
});
test("Viewer and foreign user refuse after owner positive reservation", async () => {
	const f = await ready();
	const first = await reserveAttachmentMigration(restricted(), f.request);
	expect(first.revision).toBe(1);
	await expect(
		reserveAttachmentMigration(restricted(), {
			...f.request,
			ownerId: outsider,
		}),
	).rejects.toMatchObject({ code: "plan-not-found" });
	await admin.query(
		"update membership set role='viewer' where id=$1 and user_id=$2",
		[targetSeat, owner],
	);
	await expect(
		reserveAttachmentMigration(restricted(), f.request),
	).rejects.toMatchObject({ code: "not-permitted" });
	expect(await exactCounts(first.associationId)).toEqual({
		associations: 1,
		attempts: 1,
		attachments: 1,
	});
});
test("quota and missing active key refuse without attachment or attempt insertion", async () => {
	const f = await ready();
	await expect(
		reserveAttachmentMigration(restricted(), f.request, { quotaBytes: 49 }),
	).rejects.toMatchObject({ code: "quota-exceeded" });
	await assertNoReservation(f.request.prepared.id, f.job.id, f.row.ordinal);
	await admin.query(
		"update workspace_key set active=false where workspace_id=$1 and version=1",
		[targetWorkspace],
	);
	await expect(
		reserveAttachmentMigration(restricted(), f.request),
	).rejects.toMatchObject({ code: "key-unavailable" });
	await assertNoReservation(f.request.prepared.id, f.job.id, f.row.ordinal);
});
test("source-map and parent mutations refuse after an independently visible valid discovery", async () => {
	const f = await ready();
	expect(f.row.blockedReason).toBe(null);
	await admin.query(
		"update import_source_map set last_plan_digest=$3 where source_id=$1 and target_id=$2",
		[f.source.id, f.row.destinationParent?.id, "b".repeat(64)],
	);
	await expect(
		reserveAttachmentMigration(restricted(), f.request),
	).rejects.toMatchObject({ code: "parent-unapplied" });
	await assertNoReservation(f.request.prepared.id, f.job.id, f.row.ordinal);
	await admin.query(
		"update import_source_map set last_plan_digest=$3 where source_id=$1 and target_id=$2",
		[f.source.id, f.row.destinationParent?.id, f.job.planDigest],
	);
	await admin.query(
		"update list set title=title||' changed' where id=$1 and workspace_id=$2",
		[f.row.destinationParent?.id, targetWorkspace],
	);
	await expect(
		reserveAttachmentMigration(restricted(), f.request),
	).rejects.toMatchObject({ code: "parent-changed" });
	await assertNoReservation(f.request.prepared.id, f.job.id, f.row.ordinal);
});
test("second connection workspace UPDATE yields bounded NOWAIT refusal without retry", async () => {
	const f = await ready(),
		blocker = await admin.connect();
	try {
		await blocker.query("begin");
		await blocker.query("select id from workspace where id=$1 for update", [
			targetWorkspace,
		]);
		await expect(
			reserveAttachmentMigration(restricted(), f.request),
		).rejects.toMatchObject({ code: "migration-workspace-busy" });
		await assertNoReservation(f.request.prepared.id, f.job.id, f.row.ordinal);
	} finally {
		await blocker.query("rollback");
		blocker.release();
	}
});
async function waitBlocked(pid: number, blocker: number) {
	const deadline = performance.now() + 5000;
	for (let n = 0; n < 250 && performance.now() < deadline; n++) {
		if (
			(
				await admin.query(
					"select $2::int=any(pg_blocking_pids($1::int)) blocked",
					[pid, blocker],
				)
			).rows[0].blocked
		)
			return;
	}
	throw new Error("Expected live lock wait not observed");
}
test("two connections same-owner absent reserve serialize to one exact attempt", async () => {
	const f = await ready(),
		atInsert = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>(),
		secondConnected = Promise.withResolvers<number>();
	let firstPid = 0,
		connections = 0;
	const racePool = new Proxy(restricted(), {
		get(target, key) {
			if (key !== "connect") return Reflect.get(target, key);
			return async () => {
				const client = await target.connect();
				const number = ++connections;
				const pid = (await client.query("select pg_backend_pid() pid")).rows[0]
					.pid as number;
				if (number === 1) firstPid = pid;
				else secondConnected.resolve(pid);
				return new Proxy(client, {
					get(raw, field) {
						if (field !== "query") return Reflect.get(raw, field);
						return async (sql: string, args?: unknown[]) => {
							if (
								number === 1 &&
								sql.startsWith("insert into attachment_migration(")
							) {
								atInsert.resolve();
								await release.promise;
							}
							return raw.query(sql, args);
						};
					},
				});
			};
		},
	}) as Pool;
	const first = reserveAttachmentMigration(racePool, f.request);
	let second: ReturnType<typeof reserveAttachmentMigration> | undefined;
	try {
		await Promise.race([
			atInsert.promise,
			first.then(() => {
				throw new Error("First reservation completed before insertion barrier");
			}),
		]);
		second = reserveAttachmentMigration(racePool, f.request);
		await waitBlocked(
			await Promise.race([
				secondConnected.promise,
				second.then(() => {
					throw new Error(
						"Second reservation completed before connection barrier",
					);
				}),
			]),
			firstPid,
		);
		release.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual(b);
		expect(await exactCounts(a.associationId)).toEqual({
			associations: 1,
			attempts: 1,
			attachments: 1,
		});
	} finally {
		release.resolve();
		await Promise.allSettled([first, ...(second ? [second] : [])]);
	}
}, 20000);
