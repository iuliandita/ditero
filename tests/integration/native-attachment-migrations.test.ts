import { randomBytes, randomUUID } from "node:crypto";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { auth } from "../../src/auth/auth.ts";
import type { PortableExportV1 } from "../../src/domain/portability/v1.ts";
import { s256Challenge } from "../../src/server/native-auth/contracts.ts";
import { nativePortabilityRoutes } from "../../src/server/native-auth/portability-routes.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import { exportPortableJson } from "../../src/server/portability/export.ts";
import { applyImportBatch } from "../../src/server/portability/import-apply-store.ts";
import { saveImportPlan } from "../../src/server/portability/import-plan-store.ts";

const url = process.env.DATABASE_URL;
const database =
	process.env.DITERO_NATIVE_MIGRATION_TEST_DATABASE ?? "ditero_e2e";
if (
	!url ||
	process.env.NODE_ENV !== "test" ||
	!/^[-a-zA-Z0-9_]{1,63}$/.test(database) ||
	new URL(url).pathname !== `/${database}`
)
	throw new Error("Exact test database and NODE_ENV=test are required");
const admin = new Pool({ connectionString: url });
const scope = randomBytes(10).toString("hex");
const role = `native_migrations_${scope}`;
const runtimeURL = new URL(url);
runtimeURL.username = role;
runtimeURL.password = randomBytes(32).toString("hex");
const runtime = new Pool({ connectionString: runtimeURL.toString(), max: 6 });
const users: string[] = [];
let created = false;
let routes: ReturnType<typeof nativePortabilityRoutes>;
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password ${escapeLiteral(runtimeURL.password)}`,
	);
	created = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	routes = nativePortabilityRoutes({
		pool: runtime,
		rateLimit: async () => true,
		exporter: async () => new Response("unused", { status: 500 }),
	});
});
afterAll(async () => {
	const failures: unknown[] = [];
	for (const cleanup of [
		async () => {
			if (!users.length) return;
			await admin.query(
				"delete from import_source where owner_user_id=any($1::text[])",
				[users],
			);
			const workspaces = (
				await admin.query<{ id: string }>(
					"select id from workspace where owner_id=any($1::text[])",
					[users],
				)
			).rows.map((row) => row.id);
			await admin.query(
				"delete from attachment where workspace_id=any($1::text[])",
				[workspaces],
			);
			await admin.query(
				"delete from membership_key where workspace_id=any($1::text[])",
				[workspaces],
			);
			await admin.query(
				"delete from workspace_key where workspace_id=any($1::text[])",
				[workspaces],
			);
			await admin.query(
				"delete from task where list_id in(select id from list where workspace_id=any($1::text[]))",
				[workspaces],
			);
			await admin.query("delete from list where workspace_id=any($1::text[])", [
				workspaces,
			]);
			await admin.query(
				"delete from membership where workspace_id=any($1::text[])",
				[workspaces],
			);
			await admin.query("delete from workspace where id=any($1::text[])", [
				workspaces,
			]);
			await admin.query(
				"delete from native_auth_grant where approved_user_id=any($1::text[])",
				[users],
			);
			await admin.query(
				"delete from native_session_link where user_id=any($1::text[])",
				[users],
			);
			await admin.query("delete from session where user_id=any($1::text[])", [
				users,
			]);
			await admin.query(
				"delete from user_device where user_id=any($1::text[])",
				[users],
			);
			await admin.query('delete from "user" where id=any($1::text[])', [users]);
		},
		async () => runtime.end(),
		async () => {
			if (created) {
				await admin.query(`drop owned by "${role}"`);
				await admin.query(`drop role "${role}"`);
			}
		},
		async () => admin.end(),
	]) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length)
		throw new AggregateError(
			failures,
			"Native migration fixture cleanup failed",
		);
});
async function actor() {
	const id = `migration-user-${randomUUID()}`;
	users.push(id);
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
		[id, `${id}@example.test`],
	);
	const adapter = (await auth.$context).internalAdapter;
	const sessions = {
		createSession: (userId: string) => adapter.createSession(userId, false),
		deleteSession: (token: string) => adapter.deleteSession(token),
	};
	const browser = await sessions.createSession(id);
	const grants = new NativeGrantStore(runtime, sessions);
	const verifier = "c".repeat(43);
	const grant = await grants.create(
		s256Challenge(verifier),
		"Migration test device",
	);
	expect(await grants.approve(grant.grantId, id, browser.id)).toBe("approved");
	const native = await grants.exchange(grant.grantId, verifier);
	if (native.kind !== "ok") throw new Error("Native exchange refused");
	return { id, browser, ...native };
}
function request(
	path: string,
	token: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return routes.handle(
		new Request(`http://localhost/api/native/portability/import/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
test("native migration uses real session ownership, completed-job evidence and RLS through recovery", async () => {
	const owner = await actor();
	const outsider = await actor();
	const source = `migration-source-${scope}`;
	const target = `migration-target-${scope}`;
	const list = `migration-list-${scope}`;
	const seat = `migration-seat-${scope}`;
	for (const [workspace, membership] of [
		[source, `migration-source-seat-${scope}`],
		[target, seat],
	]) {
		await admin.query(
			"insert into workspace(id,name,owner_id,kind) values($1,$1,$2,'shared')",
			[workspace, owner.id],
		);
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
			[membership, owner.id, workspace],
		);
	}
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Native migration source','a0')",
		[list, source, owner.id],
	);
	const document = JSON.parse(
		await exportPortableJson(admin, owner.id),
	) as PortableExportV1;
	document.data.attachments = [
		{
			id: `source-file-${scope}`,
			workspaceId: source,
			parentKind: "list",
			parentId: list,
			keyVersion: 1,
			declaredBytes: 50,
			observedBytes: 50,
			ciphertextSha256: "a".repeat(64),
			thumbnailDeclaredBytes: null,
			thumbnailObservedBytes: null,
			thumbnailCiphertextSha256: null,
			uploadedBy: owner.id,
			createdAt: "2026-10-05T00:00:00.000Z",
			committedAt: "2026-10-05T00:00:00.000Z",
		},
	];
	const mapping = {
		workspaces: Object.fromEntries(
			document.data.workspaces.map((row) => [
				row.id,
				row.id === source ? target : row.id,
			]),
		),
		principals: Object.fromEntries(
			document.data.principals.map((row) => [
				row.id,
				row.id === owner.id ? owner.id : null,
			]),
		),
	};
	const job = await saveImportPlan(
		runtime,
		owner.id,
		{ mode: "new", id: randomUUID(), label: "Migration fixture" },
		document,
		mapping,
		{ plannerVersion: 4 },
	);
	expect((await (await request("jobs", owner.token)).json()).items).toEqual([]);
	const confirmation = {
		planDigest: job.planDigest,
		counts: job.report.counts,
	};
	let run = await applyImportBatch(runtime, owner.id, job.id, confirmation);
	for (let n = 0; run.state === "running" && n < 10; n++)
		run = await applyImportBatch(runtime, owner.id, job.id, confirmation);
	expect(run.state).toBe("completed");
	const page = await (await request("jobs?limit=1", owner.token)).json();
	expect(page.items).toEqual([
		{
			ownerId: owner.id,
			jobId: job.id,
			sourceId: job.sourceId,
			documentDigest: job.documentDigest,
			mappingDigest: job.mappingDigest,
			planDigest: job.planDigest,
			label: "Migration fixture",
		},
	]);
	expect(
		(
			await (
				await request(`jobs?afterJobId=${job.id}&limit=1`, owner.token)
			).json()
		).items,
	).toEqual([]);
	expect((await (await request("jobs", outsider.token)).json()).items).toEqual(
		[],
	);
	const parentsResponse = await request(
		`plans/${job.id}/attachment-parents`,
		owner.token,
	);
	expect(parentsResponse.status).toBe(200);
	const parents = await parentsResponse.json();
	const parent = parents.items.find(
		(row: { sourceAttachmentId: string }) =>
			row.sourceAttachmentId === `source-file-${scope}`,
	);
	expect(parent.destinationParent).not.toBeNull();
	expect(parent.blockedReason).toBeNull();
	expect(
		(await request(`plans/${job.id}/attachment-parents`, outsider.token))
			.status,
	).toBe(404);
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values($1,$2,1,'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',$3)",
		[`migration-key-${scope}`, target, owner.id],
	);
	await admin.query(
		"insert into membership_key(id,membership_id,user_id,workspace_id,key_version,enc,ciphertext,recipient_public_key,granted_by) values($1,$2,$3,$4,1,'enc','cipher','pk',$3)",
		[`migration-wrap-${scope}`, seat, owner.id, target],
	);
	const body = {
		ordinal: parent.ordinal,
		sourceFingerprint: parent.sourceAttachmentFingerprint,
		expectedRevision: 0,
		prepared: {
			id: `migration_${randomUUID()}`,
			keyVersion: 1,
			filenameCiphertext: "name",
			contentTypeCiphertext: "type",
			dekWrapped: "wrapped",
			declaredBytes: 50,
			ciphertextSha256: "b".repeat(64),
		},
	};
	const path = `plans/${job.id}`;
	expect(
		(await request(`${path}/attachment-reservations`, outsider.token, body))
			.status,
	).toBe(404);
	const reservedResponse = await request(
		`${path}/attachment-reservations`,
		owner.token,
		body,
	);
	expect(reservedResponse.status).toBe(200);
	const reserved = await reservedResponse.json();
	expect(reserved.targetAttachmentId).toBe(body.prepared.id);
	expect(reserved.revision).toBe(1);
	expect(
		await (
			await request(`${path}/attachment-reservations`, owner.token, body)
		).json(),
	).toEqual(reserved);
	expect(
		await (
			await request(
				`${path}/attachment-reservations?ordinal=${parent.ordinal}`,
				owner.token,
			)
		).json(),
	).toEqual(reserved);
	const inspection = await (
		await request(
			`${path}/attachment-migrations?ordinal=${parent.ordinal}`,
			owner.token,
		)
	).json();
	expect(inspection.ownerId).toBe(owner.id);
	expect(inspection.jobId).toBe(job.id);
	const recovery = {
		ordinal: body.ordinal,
		sourceFingerprint: body.sourceFingerprint,
		previous: {
			associationId: reserved.associationId,
			attemptId: reserved.attemptId,
			targetAttachmentId: reserved.targetAttachmentId,
			revision: 1,
		},
		prepared: { ...body.prepared, id: `migration_${randomUUID()}` },
		retireLive: true,
	};
	const recoveredResponse = await request(
		`${path}/attachment-recoveries`,
		owner.token,
		recovery,
	);
	expect(recoveredResponse.status).toBe(200);
	const recovered = await recoveredResponse.json();
	expect(recovered.outcome).toBe("reserved");
	expect(recovered.status.revision).toBe(2);
	expect(
		await (
			await request(`${path}/attachment-recoveries`, owner.token, recovery)
		).json(),
	).toEqual(recovered);
	expect(
		(await request(`${path}/attachment-reservations`, owner.token, body))
			.status,
	).toBe(409);
	const secondJob = await saveImportPlan(
		runtime,
		owner.id,
		{ mode: "new", id: randomUUID(), label: "Second migration fixture" },
		document,
		mapping,
		{ plannerVersion: 4 },
	);
	const secondConfirmation = {
		planDigest: secondJob.planDigest,
		counts: secondJob.report.counts,
	};
	let secondRun = await applyImportBatch(
		runtime,
		owner.id,
		secondJob.id,
		secondConfirmation,
	);
	for (let n = 0; secondRun.state === "running" && n < 10; n++)
		secondRun = await applyImportBatch(
			runtime,
			owner.id,
			secondJob.id,
			secondConfirmation,
		);
	expect(secondRun.state).toBe("completed");
	const expectedJobs = [job.id, secondJob.id].sort();
	const firstPage = await (await request("jobs?limit=1", owner.token)).json();
	expect(firstPage.items.map((row: { jobId: string }) => row.jobId)).toEqual([
		expectedJobs[0],
	]);
	expect(firstPage.nextAfterJobId).toBe(expectedJobs[0]);
	const lastPage = await (
		await request(
			`jobs?afterJobId=${firstPage.nextAfterJobId}&limit=1`,
			owner.token,
		)
	).json();
	expect(lastPage.items.map((row: { jobId: string }) => row.jobId)).toEqual([
		expectedJobs[1],
	]);
	expect(lastPage.nextAfterJobId).toBeNull();
	expect((await request("jobs", owner.browser.token)).status).toBe(401);
	expect(
		(await request("jobs", owner.token, undefined, { cookie: "" })).status,
	).toBe(400);
	await admin.query("update user_device set revoked_at=now() where id=$1", [
		owner.deviceId,
	]);
	expect((await request("jobs", owner.token)).status).toBe(401);
}, 60_000);
