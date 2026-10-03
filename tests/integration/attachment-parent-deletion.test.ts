import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { attachmentQuotaWouldExceed } from "../../src/server/attachments/quota.ts";
import { attachmentRoutes } from "../../src/server/attachments/routes.ts";
import { attachmentSweep } from "../../src/server/attachments/sweep.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import { FsBlobStore } from "../../src/server/storage/fs-store.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({
	connectionString: databaseURL,
	options: "-c role=ditero_attachment_parent_test",
	application_name: "ditero-attachment-parent-proof",
});
const zdb = zeroNodePg(schema, runtime);
let directory: string;
let store: FsBlobStore;
const guards: Guards = {
	foreignOrigin: () => false,
	guardedPost:
		(handler) =>
		async ({ request }) =>
			handler(request, {
				user: { id: request.headers.get("x-test-user") ?? "member" },
			} as unknown as Session),
	guardedGet:
		(handler) =>
		async ({ request }) =>
			handler(request, {
				user: { id: request.headers.get("x-test-user") ?? "member" },
			} as unknown as Session),
};

beforeAll(async () => {
	await admin.query(`do $$ begin
	 if not exists (select from pg_roles where rolname='ditero_attachment_parent_test') then
	 create role ditero_attachment_parent_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
	 end if; end $$`);
	await admin.query(
		"grant usage on schema public to ditero_attachment_parent_test",
	);
	await admin.query(
		"grant select,insert,update,delete on all tables in schema public to ditero_attachment_parent_test",
	);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	directory = await mkdtemp(join(tmpdir(), "ditero-parent-deletion-"));
	store = new FsBlobStore(directory);
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	process.env.DITERO_E2E_ENABLED = "true";
	await admin.query(`insert into "user" (id,name,email,email_verified) values
	 ('owner','Owner','owner@example.test',true),('member','Member','member@example.test',true)`);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('ws','Shared','owner','shared')",
	);
	await admin.query(`insert into membership(id,user_id,workspace_id,role) values
	 ('owner-seat','owner','ws','owner'),('member-seat','member','ws','member')`);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values('list','ws','owner','Tasks','tasks','a0')",
	);
	await admin.query(`insert into task(id,list_id,title,sort_key,parent_id) values
	 ('parent','list','Parent','a0',null),('child','list','Child','a1','parent'),('sibling','list','Sibling','a2',null)`);
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values('child-comment','child','owner','Comment')",
	);
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values('key','ws',1,'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','owner')",
	);
	await admin.query(
		"insert into membership_key(id,membership_id,user_id,workspace_id,key_version,enc,ciphertext,recipient_public_key,granted_by) values('member-key','member-seat','member','ws',1,'enc','cipher','pk','owner')",
	);
});

afterAll(async () => {
	try {
		await resetAuthFixture(admin);
	} finally {
		await runtime.end();
		await admin.end();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

async function seedAttachment(
	id: string,
	parentKind: "task" | "comment",
	parentId: string,
) {
	const contentKey = `ws/${id}/content`;
	const thumbnailKey = `ws/${id}/thumbnail`;
	const content = new Uint8Array([1, 2, 3, 4]);
	const thumbnail = new Uint8Array([5, 6]);
	const put = (key: string, bytes: Uint8Array) =>
		store.put(
			key,
			(async function* () {
				yield bytes;
			})(),
		);
	const observed = await put(contentKey, content);
	const thumb = await put(thumbnailKey, thumbnail);
	await admin.query(
		`insert into attachment
	 (id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,
	 dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,thumbnail_declared_bytes,
	 thumbnail_observed_bytes,thumbnail_ciphertext_sha256,thumbnail_storage_key,uploaded_by,committed_at)
	 values($1,'ws',$2,$3,1,'committed','name','type','dek',4,4,$4,$5,2,2,$6,$7,'owner',now())`,
		[
			id,
			parentKind,
			parentId,
			observed.sha256,
			contentKey,
			thumb.sha256,
			thumbnailKey,
		],
	);
	return { contentKey, thumbnailKey };
}

function download(id: string, thumbnail = false, userId = "member") {
	const app = new Elysia().use(attachmentRoutes(runtime, guards, store));
	return app.handle(
		new Request(
			`http://localhost/api/attachments/${id}/${thumbnail ? "thumbnail" : "download"}`,
			{ headers: { "x-test-user": userId } },
		),
	);
}

async function deleteTask(id: string) {
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "member", () =>
			mutators.task.delete.fn({ tx, ctx: { id: "member" }, args: { id } }),
		),
	);
}

test("a failed parent deletion rolls back attachment retirement with the task", async () => {
	await seedAttachment("rollback-file", "task", "parent");
	await expect(
		zdb.transaction((tx) =>
			withZeroUserContext(tx, "member", async () => {
				await mutators.task.delete.fn({
					tx,
					ctx: { id: "member" },
					args: { id: "parent" },
				});
				throw new Error("receipt failure");
			}),
		),
	).rejects.toThrow("receipt failure");
	expect(
		(
			await admin.query(
				"select id from task where id in ('parent','child') order by id",
			)
		).rows,
	).toEqual([{ id: "child" }, { id: "parent" }]);
	expect(
		(
			await admin.query(
				"select state,deleted_at from attachment where id='rollback-file'",
			)
		).rows[0],
	).toEqual({ state: "committed", deleted_at: null });
	expect((await download("rollback-file")).status).toBe(200);
});

test("a viewer cannot retire task files", async () => {
	await seedAttachment("viewer-file", "task", "parent");
	await admin.query(
		"update membership set role='viewer' where id='member-seat'",
	);
	await expect(deleteTask("parent")).rejects.toThrow(/access denied/);
	expect((await download("viewer-file")).status).toBe(200);
	expect(
		(await admin.query("select state from attachment where id='viewer-file'"))
			.rows[0].state,
	).toBe("committed");
	expect(
		(await admin.query("select id from task where id='parent'")).rowCount,
	).toBe(1);
});

test.each([
	"pending",
	"blocked",
] as const)("%s import activation still permits authorized comment deletion", async (status) => {
	await seedAttachment("pending-comment-file", "comment", "child-comment");
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values('child',$1,1)",
		[status],
	);
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.comment.delete.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: "child-comment" },
			}),
		),
	);
	expect(
		(await admin.query("select id from comment where id='child-comment'"))
			.rowCount,
	).toBe(0);
	expect((await download("pending-comment-file")).status).toBe(404);
	expect(
		(
			await admin.query(
				"select status from task_notification_activation where task_id='child'",
			)
		).rows[0].status,
	).toBe(status);
});

test("a comment creator cannot delete another creator's replacement between discovery and the row lock", async () => {
	await admin.query(
		"update comment set author_id='member' where id='child-comment'",
	);
	const discovered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const deleting = zdb.transaction((tx) =>
		withZeroUserContext(tx, "member", async () => {
			const original = tx.dbTransaction.query.bind(tx.dbTransaction);
			let paused = false;
			const spy = vi
				.spyOn(tx.dbTransaction, "query")
				.mockImplementation(async (...args) => {
					if (
						!paused &&
						(args[0] ===
							'select id, deleted_at from "user" where id = $1 for update' ||
							args[0] ===
								"select id from comment where id = $1 and task_id = $2 for update")
					) {
						paused = true;
						discovered.resolve();
						await resume.promise;
					}
					return original(...args);
				});
			try {
				await mutators.comment.delete.fn({
					tx,
					ctx: { id: "member" },
					args: { id: "child-comment" },
				});
			} finally {
				spy.mockRestore();
			}
		}),
	);
	// Attach the refusal expectation before releasing the other transaction.
	const refusal = expect(deleting).rejects.toThrow(
		/access denied|comment.*changed/,
	);
	try {
		await discovered.promise;
		await zdb.transaction((tx) =>
			withZeroUserContext(tx, "owner", async () => {
				await mutators.comment.delete.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "child-comment" },
				});
				await mutators.comment.add.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "child-comment", taskId: "child", body: "Replacement" },
				});
			}),
		);
		await seedAttachment("replacement-file", "comment", "child-comment");
		resume.resolve();
		await refusal;
		expect(
			(
				await admin.query(
					"select author_id,body from comment where id='child-comment'",
				)
			).rows,
		).toEqual([{ author_id: "owner", body: "Replacement" }]);
		expect(
			(
				await admin.query(
					"select state from attachment where id='replacement-file'",
				)
			).rows[0].state,
		).toBe("committed");
	} finally {
		resume.resolve();
		await Promise.allSettled([deleting, refusal]);
	}
});

test("same-workspace moves keep downloads and cross-workspace moves preserve encrypted storage without granting access", async () => {
	const file = await seedAttachment("move-file", "task", "parent");
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values('same-list','ws','owner','Same','tasks','a1')",
	);
	const move = (listId: string) =>
		zdb.transaction((tx) =>
			withZeroUserContext(tx, "member", () =>
				mutators.task.move.fn({
					tx,
					ctx: { id: "member" },
					args: { id: "parent", listId, sortKey: "a1" },
				}),
			),
		);
	await move("same-list");
	expect((await download("move-file")).status).toBe(200);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('target-ws','Target','owner','shared')",
	);
	await admin.query(
		"insert into \"user\"(id,name,email,email_verified) values('target-user','Target','target@example.test',true)",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('target-member','member','target-ws','member'),('target-user-seat','target-user','target-ws','member')",
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values('target-list','target-ws','owner','Target','tasks','a0')",
	);
	await move("target-list");
	expect(
		(
			await admin.query(
				"select list_id from task where id in ('parent','child')",
			)
		).rows,
	).toEqual([{ list_id: "target-list" }, { list_id: "target-list" }]);
	expect((await download("move-file")).status).toBe(404);
	expect((await download("move-file", false, "target-user")).status).toBe(403);
	expect(
		await attachmentSweep(runtime, store, {
			now: new Date(Date.now() + 60_000),
			retentionMs: 1,
		}),
	).toEqual({ deleted: 0, failed: 0 });
	expect(
		(
			await admin.query(
				"select workspace_id,state,deleted_at from attachment where id='move-file'",
			)
		).rows[0],
	).toEqual({ workspace_id: "ws", state: "committed", deleted_at: null });
	expect(await store.exists(file.contentKey)).toBe(true);
	expect(await store.exists(file.thumbnailKey)).toBe(true);
	const usage = await runtime.connect();
	try {
		expect(await attachmentQuotaWouldExceed(usage, "ws", 1, 6)).toBe(true);
	} finally {
		usage.release();
	}
});

test("opaque parent ID collisions in another kind and workspace are preserved", async () => {
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('other-ws','Other','owner','shared')",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('other-seat','member','other-ws','member')",
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values('parent','other-ws','owner','Other','tasks','a0')",
	);
	await seedAttachment("unrelated-file", "task", "parent");
	await admin.query(
		"update attachment set parent_kind='list',workspace_id='other-ws' where id='unrelated-file'",
	);
	expect((await download("unrelated-file")).status).toBe(200);
	await deleteTask("parent");
	expect((await download("unrelated-file")).status).toBe(200);
	expect(
		(
			await admin.query(
				"select state from attachment where id='unrelated-file'",
			)
		).rows[0].state,
	).toBe("committed");
	expect(
		await attachmentSweep(runtime, store, {
			now: new Date(Date.now() + 60_000),
			retentionMs: 1,
		}),
	).toEqual({ deleted: 0, failed: 0 });
});

test("list and direct comment deletion retire only their matching parents", async () => {
	await seedAttachment("list-file", "task", "parent");
	await seedAttachment("comment-file", "comment", "child-comment");
	await seedAttachment("comment-control", "task", "sibling");
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.comment.delete.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: "child-comment" },
			}),
		),
	);
	expect((await download("comment-file")).status).toBe(404);
	expect((await download("comment-control")).status).toBe(200);
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.list.delete.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: "list" },
			}),
		),
	);
	expect(
		(await admin.query("select distinct state from attachment")).rows,
	).toEqual([{ state: "deleting" }]);
});

test("old committed orphans stop downloading and enter retention before garbage collection", async () => {
	const orphan = await seedAttachment("orphan-file", "task", "missing-parent");
	const control = await seedAttachment("present-file", "task", "parent");
	expect((await download("orphan-file")).status).toBe(404);
	expect((await download("present-file")).status).toBe(200);
	const now = new Date();
	expect(
		await attachmentSweep(runtime, store, { now, retentionMs: 1000 }),
	).toEqual({ deleted: 0, failed: 0 });
	expect(
		(
			await admin.query(
				"select state,deleted_at from attachment where id='orphan-file'",
			)
		).rows[0],
	).toEqual({ state: "deleting", deleted_at: now });
	expect(await store.exists(orphan.contentKey)).toBe(true);
	expect(
		await attachmentSweep(runtime, store, {
			now: new Date(now.getTime() + 1001),
			retentionMs: 1000,
		}),
	).toEqual({ deleted: 1, failed: 0 });
	expect(await store.exists(orphan.contentKey)).toBe(false);
	expect(await store.exists(orphan.thumbnailKey)).toBe(false);
	expect(await store.exists(control.contentKey)).toBe(true);
	expect((await admin.query("select id,state from attachment")).rows).toEqual([
		{ id: "present-file", state: "committed" },
	]);
});

async function uploadingAttachment() {
	await seedAttachment("upload-file", "task", "parent");
	await admin.query(
		"update attachment set state='uploading',uploaded_by='member',committed_at=null,reservation_expires_at=now()+interval '1 hour' where id='upload-file'",
	);
}

function finalize() {
	const app = new Elysia().use(attachmentRoutes(runtime, guards, store));
	return app.handle(
		new Request("http://localhost/api/attachments/finalize", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "upload-file" }),
		}),
	);
}

async function awaitBlocked(count: number) {
	await vi.waitFor(
		async () => {
			expect(
				Number(
					(
						await admin.query(
							"select count(*) from pg_stat_activity where application_name='ditero-attachment-parent-proof' and wait_event_type='Lock'",
						)
					).rows[0].count,
				),
			).toBeGreaterThanOrEqual(count);
		},
		{ timeout: 3000, interval: 10 },
	);
}

test("finalize holding its parent key-share commits before deletion without a deadlock", async () => {
	await uploadingAttachment();
	const barrier = await admin.connect();
	await barrier.query("select pg_advisory_lock(550001)");
	await admin.query(`create function parent_proof_pause() returns trigger language plpgsql as $$ begin
	 if new.state='committed' then perform pg_advisory_xact_lock(550001); end if; return new; end $$`);
	await admin.query(
		"create trigger parent_proof_pause before update on attachment for each row execute function parent_proof_pause()",
	);
	let finalizing: ReturnType<typeof finalize> | undefined;
	let deleting: ReturnType<typeof deleteTask> | undefined;
	try {
		finalizing = finalize();
		await awaitBlocked(1);
		deleting = deleteTask("parent");
		await awaitBlocked(2);
		await barrier.query("select pg_advisory_unlock(550001)");
		expect((await finalizing).status).toBe(200);
		await deleting;
		expect(
			(await admin.query("select id from task where id='parent'")).rowCount,
		).toBe(0);
	} finally {
		await barrier.query("select pg_advisory_unlock(550001)");
		await Promise.allSettled([finalizing, deleting]);
		barrier.release();
		await admin.query(
			"drop trigger parent_proof_pause on attachment; drop function parent_proof_pause()",
		);
	}
});

test("deletion holding its parent update lock makes a concurrent finalize abort", async () => {
	await uploadingAttachment();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const deleting = zdb.transaction((tx) =>
		withZeroUserContext(tx, "member", async () => {
			await mutators.task.delete.fn({
				tx,
				ctx: { id: "member" },
				args: { id: "parent" },
			});
			started.resolve();
			await release.promise;
		}),
	);
	let finalizing: ReturnType<typeof finalize> | undefined;
	try {
		await started.promise;
		finalizing = finalize();
		await awaitBlocked(1);
		release.resolve();
		await deleting;
		expect((await finalizing).status).toBe(409);
		expect(
			(await admin.query("select state from attachment where id='upload-file'"))
				.rows[0].state,
		).toBe("aborted");
		expect(await store.exists("ws/upload-file/content")).toBe(false);
		expect(await store.exists("ws/upload-file/thumbnail")).toBe(false);
	} finally {
		release.resolve();
		await Promise.allSettled([deleting, finalizing]);
	}
});

test("parent deletion retires committed task, child and comment files while preserving a sibling", async () => {
	const doomed = [
		await seedAttachment("parent-file", "task", "parent"),
		await seedAttachment("child-file", "task", "child"),
		await seedAttachment("comment-file", "comment", "child-comment"),
	];
	const sibling = await seedAttachment("sibling-file", "task", "sibling");
	const usage = await runtime.connect();
	try {
		expect(await attachmentQuotaWouldExceed(usage, "ws", 0, 6)).toBe(true);
	} finally {
		usage.release();
	}
	expect((await download("parent-file")).status).toBe(200);
	expect([
		...new Uint8Array(await (await download("child-file")).arrayBuffer()),
	]).toEqual([1, 2, 3, 4]);
	expect((await download("comment-file", true)).status).toBe(200);
	await deleteTask("parent");
	expect((await admin.query("select id from task order by id")).rows).toEqual([
		{ id: "sibling" },
	]);
	for (const id of ["parent-file", "child-file", "comment-file"]) {
		expect((await download(id)).status).toBe(404);
		expect((await download(id, true)).status).toBe(404);
	}
	expect((await download("sibling-file")).status).toBe(200);
	const remainingUsage = await runtime.connect();
	try {
		expect(await attachmentQuotaWouldExceed(remainingUsage, "ws", 0, 6)).toBe(
			false,
		);
	} finally {
		remainingUsage.release();
	}
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values('parent','list','Replacement','a0')",
	);
	expect((await download("parent-file")).status).toBe(404);
	expect(
		(
			await admin.query(
				"select state,deleted_at from attachment where id='parent-file'",
			)
		).rows[0],
	).toMatchObject({ state: "deleting", deleted_at: expect.any(Date) });
	expect(
		await attachmentSweep(runtime, store, {
			now: new Date(Date.now() + 60_000),
			retentionMs: 1,
		}),
	).toEqual({ deleted: 3, failed: 0 });
	for (const file of doomed) {
		expect(await store.exists(file.contentKey)).toBe(false);
		expect(await store.exists(file.thumbnailKey)).toBe(false);
	}
	expect(await store.exists(sibling.contentKey)).toBe(true);
	expect(
		(await admin.query("select id from attachment order by id")).rows,
	).toEqual([{ id: "sibling-file" }]);
});
