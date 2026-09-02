import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { validateAttachmentWrite } from "../../src/server/attachments/quota.ts";
import { attachmentRoutes } from "../../src/server/attachments/routes.ts";
import {
	assertAttachmentTransition,
	expireAttachmentReservations,
} from "../../src/server/attachments/state.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import {
	BlobNotFoundError,
	type BlobStore,
} from "../../src/server/storage/blob-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

type Bytes = Uint8Array;

type Deferred = ReturnType<typeof Promise.withResolvers<void>>;

class MemoryBlobStore implements BlobStore {
	readonly objects = new Map<string, Uint8Array>();
	#pause: {
		started: Deferred;
		release: Deferred;
	} | null = null;

	clear(): void {
		this.objects.clear();
		this.#pause = null;
	}

	pauseNextPut() {
		const pause = {
			started: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		};
		this.#pause = pause;
		return pause;
	}

	async put(key: string, body: AsyncIterable<Bytes>) {
		const chunks: Bytes[] = [];
		let length = 0;
		for await (const chunk of body) {
			chunks.push(chunk);
			length += chunk.byteLength;
		}
		const value = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			value.set(chunk, offset);
			offset += chunk.byteLength;
		}

		const pause = this.#pause;
		this.#pause = null;
		if (pause) {
			pause.started.resolve();
			await pause.release.promise;
		}
		this.objects.set(key, value);
		return {
			bytes: value.byteLength,
			sha256: createHash("sha256").update(value).digest("hex"),
		};
	}

	async get(key: string): Promise<AsyncIterable<Bytes>> {
		const value = this.objects.get(key);
		if (!value) throw new BlobNotFoundError(key);
		return (async function* () {
			yield value;
		})();
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key);
	}
}

const pool = new Pool({ connectionString: databaseURL });
const store = new MemoryBlobStore();
const NOW = new Date("2026-09-02T12:00:00.000Z");
let currentNow = NOW;
const WORKSPACE = "upload-w";
const FOREIGN_WORKSPACE = "upload-foreign-w";
const TASK = "upload-task";
const FOREIGN_TASK = "upload-foreign-task";

const guards: Guards = {
	foreignOrigin: () => false,
	guardedPost:
		(handler) =>
		async ({ request }) => {
			const userId = request.headers.get("x-test-user");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			return await handler(request, {
				user: { id: userId },
			} as unknown as Session);
		},
	guardedGet:
		(handler) =>
		async ({ request }) => {
			const userId = request.headers.get("x-test-user");
			if (!userId) return new Response("Unauthorized", { status: 401 });
			return await handler(request, {
				user: { id: userId },
			} as unknown as Session);
		},
};

const app = new Elysia().use(
	attachmentRoutes(pool, guards, store, {
		quotaBytes: 20,
		maxFileBytes: 19,
		reservationTtlMs: 10 * 60_000,
		now: () => new Date(currentNow),
	}),
);

function reserveBody(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		workspaceId: WORKSPACE,
		parentKind: "task",
		parentId: TASK,
		keyVersion: 1,
		filenameCiphertext: "encrypted-filename",
		contentTypeCiphertext: "encrypted-content-type",
		dekWrapped: "wrapped-dek",
		declaredBytes: 10,
		...overrides,
	};
}

function postJson(path: string, body: unknown, userId = "upload-owner") {
	return app.handle(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-test-user": userId,
			},
			body: JSON.stringify(body),
		}),
	);
}

function upload(id: string, body: Uint8Array, userId = "upload-owner") {
	const copy = new Uint8Array(body.byteLength);
	copy.set(body);
	return app.handle(
		new Request(`http://localhost/api/attachments/${id}/upload`, {
			method: "POST",
			headers: {
				"content-type": "application/octet-stream",
				"x-test-user": userId,
			},
			body: copy.buffer,
		}),
	);
}

function uploadThumbnail(
	id: string,
	body: Uint8Array,
	userId = "upload-owner",
) {
	const copy = new Uint8Array(body.byteLength);
	copy.set(body);
	return app.handle(
		new Request(`http://localhost/api/attachments/${id}/thumbnail`, {
			method: "POST",
			headers: {
				"content-type": "application/octet-stream",
				"x-test-user": userId,
			},
			body: copy.buffer,
		}),
	);
}

function downloadThumbnail(id: string, userId = "upload-owner") {
	return app.handle(
		new Request(`http://localhost/api/attachments/${id}/thumbnail`, {
			headers: { "x-test-user": userId },
		}),
	);
}

function attachmentConfig(userId = "upload-owner") {
	return app.handle(
		new Request("http://localhost/api/attachments/config", {
			headers: { "x-test-user": userId },
		}),
	);
}

const reserve = (
	id: string,
	overrides?: Record<string, unknown>,
	userId?: string,
) => postJson("/api/attachments/reserve", reserveBody(id, overrides), userId);

const finalize = (id: string, userId?: string) =>
	postJson("/api/attachments/finalize", { id }, userId);

const abort = (id: string, userId?: string) =>
	postJson("/api/attachments/abort", { id }, userId);

const remove = (id: string, userId?: string) =>
	postJson("/api/attachments/delete", { id }, userId);

async function row(id: string) {
	return (
		await pool.query<{
			state: string;
			declared_bytes: string;
			observed_bytes: string | null;
			ciphertext_sha256: string | null;
			storage_key: string;
			thumbnail_declared_bytes: string | null;
			thumbnail_observed_bytes: string | null;
			thumbnail_ciphertext_sha256: string | null;
			thumbnail_storage_key: string | null;
			reservation_expires_at: Date | null;
			committed_at: Date | null;
			deleted_at: Date | null;
		}>(
			`select state, declared_bytes, observed_bytes, ciphertext_sha256,
			 storage_key, thumbnail_declared_bytes, thumbnail_observed_bytes,
			 thumbnail_ciphertext_sha256, thumbnail_storage_key,
				 reservation_expires_at, committed_at, deleted_at
			 from attachment where id = $1`,
			[id],
		)
	).rows[0];
}

async function seedUsage(
	id: string,
	state: "reserved" | "committed",
	bytes: number,
	thumbnailBytes = 0,
) {
	await pool.query(
		`insert into attachment (id, workspace_id, parent_kind, parent_id,
		 key_version, state, filename_ciphertext, content_type_ciphertext,
		 dek_wrapped, declared_bytes, observed_bytes, ciphertext_sha256,
		 storage_key, thumbnail_declared_bytes, thumbnail_observed_bytes,
		 thumbnail_storage_key, uploaded_by, reservation_expires_at, committed_at)
		 values ($1, $2, 'task', $3, 1, $4::attachment_state, 'name', 'type', 'dek', $5::bigint,
		 case when $4::attachment_state = 'committed' then $5::bigint else null end,
		 case when $4::attachment_state = 'committed' then repeat('a', 64) else null end,
		 $6, nullif($7::bigint, 0),
		 case when $4::attachment_state = 'committed' then nullif($7::bigint, 0) else null end,
		 case when $7::bigint > 0 then $6 || '.thumbnail' else null end,
		 'upload-owner',
		 case when $4::attachment_state = 'reserved' then $8::timestamptz else null end,
		 case when $4::attachment_state = 'committed' then $9::timestamptz else null end)`,
		[
			id,
			WORKSPACE,
			TASK,
			state,
			bytes,
			`upload-w/00/${id}`,
			thumbnailBytes,
			new Date(NOW.getTime() + 600_000),
			NOW,
		],
	);
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	store.clear();
	currentNow = NOW;
	process.env.DITERO_E2E_ENABLED = "true";
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values
		 ('upload-owner', 'Owner', 'upload-owner@test.invalid', true, now(), now()),
		 ('upload-member', 'Member', 'upload-member@test.invalid', true, now(), now()),
		 ('upload-viewer', 'Viewer', 'upload-viewer@test.invalid', true, now(), now()),
		 ('upload-outsider', 'Outsider', 'upload-outsider@test.invalid', true, now(), now())`,
	);
	await pool.query(
		`insert into workspace (id, name, owner_id, kind) values
		 ($1, 'Upload', 'upload-owner', 'shared'),
		 ($2, 'Foreign', 'upload-outsider', 'shared')`,
		[WORKSPACE, FOREIGN_WORKSPACE],
	);
	await pool.query(
		`insert into membership (id, user_id, workspace_id, role) values
		 ('upload-m-owner', 'upload-owner', $1, 'owner'),
		 ('upload-m-member', 'upload-member', $1, 'member'),
		 ('upload-m-viewer', 'upload-viewer', $1, 'viewer'),
		 ('upload-m-outsider', 'upload-outsider', $2, 'owner')`,
		[WORKSPACE, FOREIGN_WORKSPACE],
	);
	await pool.query(
		`insert into list (id, workspace_id, owner_id, title, kind, sort_key) values
		 ('upload-list', $1, 'upload-owner', 'Upload', 'tasks', 'a'),
		 ('upload-foreign-list', $2, 'upload-outsider', 'Foreign', 'tasks', 'a')`,
		[WORKSPACE, FOREIGN_WORKSPACE],
	);
	await pool.query(
		`insert into task (id, list_id, title, sort_key) values
		 ($1, 'upload-list', 'Upload task', 'a'),
		 ($2, 'upload-foreign-list', 'Foreign task', 'a')`,
		[TASK, FOREIGN_TASK],
	);
	await pool.query(
		`insert into comment (id, task_id, author_id, body)
		 values ('upload-comment', $1, 'upload-owner', 'Upload comment')`,
		[TASK],
	);
	await pool.query(
		`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
		 values ('upload-key', $1, 1, 'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'upload-owner')`,
		[WORKSPACE],
	);
	await pool.query(
		`insert into membership_key (id, membership_id, user_id, workspace_id,
		 key_version, enc, ciphertext, recipient_public_key, granted_by) values
		 ('upload-mk-owner', 'upload-m-owner', 'upload-owner', $1, 1, 'enc', 'cipher', 'pk', 'upload-owner'),
		 ('upload-mk-member', 'upload-m-member', 'upload-member', $1, 1, 'enc', 'cipher', 'pk', 'upload-owner')`,
		[WORKSPACE],
	);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		process.env.DITERO_E2E_ENABLED = undefined;
		await pool.end();
	}
});

describe("attachment reserve", () => {
	test("publishes the effective per-file ciphertext limit", async () => {
		const response = await attachmentConfig();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ maxFileBytes: 19 });
	});

	test("distinguishes a file over the effective limit from exhausted quota", async () => {
		const tooLarge = await reserve("att-too-large", {
			declaredBytes: 16,
			thumbnailDeclaredBytes: 4,
		});
		expect(tooLarge.status).toBe(413);
		expect(await tooLarge.text()).toBe("file-too-large");
		expect(await row("att-too-large")).toBeUndefined();

		await seedUsage("att-nearly-full", "committed", 15);
		const quotaFull = await reserve("att-quota-full", { declaredBytes: 6 });
		expect(quotaFull.status).toBe(409);
		expect(await quotaFull.text()).toBe("quota-exceeded");
	});

	test("stays hidden while end-to-end encryption is disabled", async () => {
		process.env.DITERO_E2E_ENABLED = "false";

		expect((await reserve("att-disabled")).status).toBe(404);
		expect(await row("att-disabled")).toBeUndefined();
	});

	test("writes an expiring reservation and returns its upload target", async () => {
		const response = await reserve("att-reserve");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "att-reserve",
			uploadUrl: "/api/attachments/att-reserve/upload",
			thumbnailUploadUrl: null,
		});
		expect(await row("att-reserve")).toMatchObject({
			state: "reserved",
			declared_bytes: "10",
			reservation_expires_at: new Date(NOW.getTime() + 600_000),
		});
	});

	test("reserves thumbnail bytes and returns a separate upload target", async () => {
		const response = await reserve("att-thumbnail-reserve", {
			declaredBytes: 10,
			thumbnailDeclaredBytes: 5,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "att-thumbnail-reserve",
			uploadUrl: "/api/attachments/att-thumbnail-reserve/upload",
			thumbnailUploadUrl: "/api/attachments/att-thumbnail-reserve/thumbnail",
		});
		expect(await row("att-thumbnail-reserve")).toMatchObject({
			thumbnail_declared_bytes: "5",
			thumbnail_storage_key: expect.stringMatching(/\.thumbnail$/),
		});
	});

	test("counts incoming and existing thumbnail bytes against quota", async () => {
		expect(
			(
				await reserve("att-thumbnail-over", {
					declaredBytes: 15,
					thumbnailDeclaredBytes: 6,
				})
			).status,
		).toBe(413);

		await seedUsage("att-thumbnail-used", "committed", 10, 6);
		expect(
			(await reserve("att-thumbnail-existing", { declaredBytes: 5 })).status,
		).toBe(409);
	});

	test("counts both reserved and committed bytes against quota", async () => {
		await seedUsage("att-used-reserved", "reserved", 5);
		await seedUsage("att-used-committed", "committed", 10);

		expect((await reserve("att-over", { declaredBytes: 6 })).status).toBe(409);
		expect(await row("att-over")).toBeUndefined();
	});

	test("serializes concurrent reservations at the workspace quota row", async () => {
		const locker = await pool.connect();
		await locker.query("begin");
		await locker.query("select id from workspace where id = $1 for update", [
			WORKSPACE,
		]);
		try {
			const first = reserve("att-race-a", { declaredBytes: 11 });
			const second = reserve("att-race-b", { declaredBytes: 11 });
			await new Promise((resolve) => setTimeout(resolve, 100));
			await locker.query("commit");
			const statuses = (await Promise.all([first, second]))
				.map((response) => response.status)
				.sort();
			expect(statuses).toEqual([200, 409]);
		} finally {
			await locker.query("rollback").catch(() => undefined);
			locker.release();
		}
	});

	test("retains final context locks through the transition commit", async () => {
		const holder = await pool.connect();
		const remover = await pool.connect();
		try {
			await holder.query("begin");
			expect(
				await validateAttachmentWrite(
					holder,
					"upload-member",
					{
						workspaceId: WORKSPACE,
						parentKind: "task",
						parentId: TASK,
						keyVersion: 1,
					},
					{ lockContext: true },
				),
			).toBeNull();

			await remover.query("begin");
			await remover.query("set local lock_timeout = '100ms'");
			await expect(
				remover.query("delete from membership where id = 'upload-m-member'"),
			).rejects.toMatchObject({ code: "55P03" });
			await remover.query("rollback");
			await holder.query("commit");

			expect(
				(
					await pool.query(
						"delete from membership where id = 'upload-m-member'",
					)
				).rowCount,
			).toBe(1);
		} finally {
			await remover.query("rollback").catch(() => undefined);
			await holder.query("rollback").catch(() => undefined);
			remover.release();
			holder.release();
		}
	});

	test("refuses a non-member", async () => {
		expect((await reserve("att-outsider", {}, "upload-outsider")).status).toBe(
			403,
		);
	});

	test("refuses a viewer", async () => {
		expect((await reserve("att-viewer", {}, "upload-viewer")).status).toBe(403);
	});

	test("refuses a parent outside the declared workspace", async () => {
		expect(
			(
				await reserve("att-parent", {
					parentId: FOREIGN_TASK,
				})
			).status,
		).toBe(403);
	});

	test("accepts list and comment parents in the declared workspace", async () => {
		expect(
			(
				await reserve("att-list", {
					parentKind: "list",
					parentId: "upload-list",
				})
			).status,
		).toBe(200);
		expect(
			(
				await reserve("att-comment", {
					parentKind: "comment",
					parentId: "upload-comment",
				})
			).status,
		).toBe(200);
	});

	test("refuses a key version the caller cannot unwrap", async () => {
		const response = await reserve("att-key-missing", { keyVersion: 2 });
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("key-unavailable");
	});

	test("refuses while workspace-key rotation is required", async () => {
		await pool.query(
			"update workspace set rotation_required = true where id = $1",
			[WORKSPACE],
		);

		const response = await reserve("att-rotation");
		expect(response.status).toBe(409);
		expect(await response.text()).toBe("rotation-required");
	});
});

describe("attachment delete", () => {
	async function committed(id: string, uploadedBy = "upload-owner") {
		await reserve(id, { declaredBytes: 4 }, uploadedBy);
		await upload(id, new Uint8Array(4), uploadedBy);
		await finalize(id, uploadedBy);
		return (await row(id))?.storage_key ?? "";
	}

	test("soft-deletes a committed file and leaves its blob for the retention sweep", async () => {
		const storageKey = await committed("att-delete");

		const response = await remove("att-delete", "upload-member");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "att-delete",
			state: "deleting",
		});
		expect(await row("att-delete")).toMatchObject({
			state: "deleting",
			deleted_at: NOW,
		});
		expect(await store.exists(storageKey)).toBe(true);
	});

	test("is idempotent while the row awaits its retention sweep", async () => {
		await committed("att-delete-twice");

		expect((await remove("att-delete-twice")).status).toBe(200);
		expect((await remove("att-delete-twice")).status).toBe(200);
	});

	test("re-derives the current write role without revealing rows to outsiders", async () => {
		await committed("att-delete-role");

		expect((await remove("att-delete-role", "upload-viewer")).status).toBe(404);
		expect((await remove("att-delete-role", "upload-outsider")).status).toBe(
			404,
		);
		expect(await row("att-delete-role")).toMatchObject({ state: "committed" });
	});

	test("refuses deleting a reservation through the committed-file endpoint", async () => {
		await reserve("att-delete-reserved");

		expect((await remove("att-delete-reserved")).status).toBe(409);
		expect(await row("att-delete-reserved")).toMatchObject({
			state: "reserved",
		});
	});
});

describe("attachment upload and finalize", () => {
	test("records observed bytes and hash, then moves to uploading", async () => {
		const payload = new TextEncoder().encode("ciphertext");
		expect(
			(await reserve("att-upload", { declaredBytes: payload.length })).status,
		).toBe(200);

		expect((await upload("att-upload", payload)).status).toBe(200);

		expect(await row("att-upload")).toMatchObject({
			state: "uploading",
			observed_bytes: String(payload.length),
			ciphertext_sha256: createHash("sha256").update(payload).digest("hex"),
		});
	});

	test("uploads a separately encrypted thumbnail and includes it in finalize", async () => {
		const content = new TextEncoder().encode("ciphertext");
		const thumbnail = new TextEncoder().encode("thumbnail");
		await reserve("att-thumbnail", {
			declaredBytes: content.length,
			thumbnailDeclaredBytes: thumbnail.length,
		});
		await upload("att-thumbnail", content);

		expect((await uploadThumbnail("att-thumbnail", thumbnail)).status).toBe(
			200,
		);
		expect(await row("att-thumbnail")).toMatchObject({
			state: "uploading",
			thumbnail_observed_bytes: String(thumbnail.length),
			thumbnail_ciphertext_sha256: createHash("sha256")
				.update(thumbnail)
				.digest("hex"),
		});
		expect((await finalize("att-thumbnail")).status).toBe(200);
		expect(await row("att-thumbnail")).toMatchObject({ state: "committed" });
	});

	test("aborts finalize when a declared thumbnail was not uploaded", async () => {
		const content = new TextEncoder().encode("ciphertext");
		await reserve("att-thumbnail-missing", {
			declaredBytes: content.length,
			thumbnailDeclaredBytes: 4,
		});
		await upload("att-thumbnail-missing", content);
		const contentKey = (await row("att-thumbnail-missing"))?.storage_key ?? "";

		expect((await finalize("att-thumbnail-missing")).status).toBe(409);
		expect(await row("att-thumbnail-missing")).toMatchObject({
			state: "aborted",
		});
		expect(await store.exists(contentKey)).toBe(false);
	});

	test("aborts an oversized thumbnail and removes both blobs", async () => {
		await reserve("att-thumbnail-large", {
			declaredBytes: 4,
			thumbnailDeclaredBytes: 4,
		});
		await upload("att-thumbnail-large", new Uint8Array(4));
		const keys = await row("att-thumbnail-large");

		expect(
			(await uploadThumbnail("att-thumbnail-large", new Uint8Array(5))).status,
		).toBe(413);
		expect(await row("att-thumbnail-large")).toMatchObject({
			state: "aborted",
		});
		expect(await store.exists(keys?.storage_key ?? "")).toBe(false);
		expect(await store.exists(keys?.thumbnail_storage_key ?? "")).toBe(false);
	});

	test("client abort is uploader-scoped, idempotent, and removes both blobs", async () => {
		await reserve("att-client-abort", {
			declaredBytes: 4,
			thumbnailDeclaredBytes: 4,
		});
		await upload("att-client-abort", new Uint8Array(4));
		await uploadThumbnail("att-client-abort", new Uint8Array(4));
		const keys = await row("att-client-abort");

		expect((await abort("att-client-abort", "upload-member")).status).toBe(404);
		expect((await abort("att-client-abort")).status).toBe(200);
		expect((await abort("att-client-abort")).status).toBe(200);
		expect(await row("att-client-abort")).toMatchObject({ state: "aborted" });
		expect(await store.exists(keys?.storage_key ?? "")).toBe(false);
		expect(await store.exists(keys?.thumbnail_storage_key ?? "")).toBe(false);
	});

	test("serves only committed thumbnails to current members with forced headers", async () => {
		const content = new Uint8Array(4);
		const thumbnail = new TextEncoder().encode("thumb");
		await reserve("att-thumbnail-download", {
			declaredBytes: content.length,
			thumbnailDeclaredBytes: thumbnail.length,
		});
		await upload("att-thumbnail-download", content);
		await uploadThumbnail("att-thumbnail-download", thumbnail);
		expect((await downloadThumbnail("att-thumbnail-download")).status).toBe(
			404,
		);
		await finalize("att-thumbnail-download");

		const response = await downloadThumbnail(
			"att-thumbnail-download",
			"upload-member",
		);
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(thumbnail);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-length")).toBe(
			String(thumbnail.length),
		);
		expect(
			(await downloadThumbnail("att-thumbnail-download", "upload-outsider"))
				.status,
		).toBe(403);
	});

	test("membership removal during thumbnail upload aborts and removes both blobs", async () => {
		await reserve(
			"att-thumbnail-member-gone",
			{ declaredBytes: 4, thumbnailDeclaredBytes: 4 },
			"upload-member",
		);
		await upload(
			"att-thumbnail-member-gone",
			new Uint8Array(4),
			"upload-member",
		);
		const keys = await row("att-thumbnail-member-gone");
		const pause = store.pauseNextPut();
		const response = uploadThumbnail(
			"att-thumbnail-member-gone",
			new Uint8Array(4),
			"upload-member",
		);
		await pause.started.promise;
		await pool.query("delete from membership where id = 'upload-m-member'");
		pause.release.resolve();

		expect((await response).status).toBe(403);
		expect(await row("att-thumbnail-member-gone")).toMatchObject({
			state: "aborted",
		});
		expect(await store.exists(keys?.storage_key ?? "")).toBe(false);
		expect(await store.exists(keys?.thumbnail_storage_key ?? "")).toBe(false);
	});

	test("does not reveal another uploader's reservation", async () => {
		expect((await reserve("att-private", { declaredBytes: 4 })).status).toBe(
			200,
		);

		expect(
			(await upload("att-private", new Uint8Array(4), "upload-member")).status,
		).toBe(404);
		expect((await finalize("att-private", "upload-member")).status).toBe(404);
		expect(await row("att-private")).toMatchObject({ state: "reserved" });
	});

	test("aborts an upload that exceeds its declared length", async () => {
		expect((await reserve("att-oversized", { declaredBytes: 4 })).status).toBe(
			200,
		);
		const storageKey = (await row("att-oversized"))?.storage_key ?? "";

		expect((await upload("att-oversized", new Uint8Array(5))).status).toBe(413);
		expect(await row("att-oversized")).toMatchObject({ state: "aborted" });
		expect(await store.exists(storageKey)).toBe(false);
	});

	test("aborts a finalize whose observed length differs from the declaration", async () => {
		const payload = new TextEncoder().encode("short");
		await reserve("att-mismatch", { declaredBytes: payload.length + 1 });
		await upload("att-mismatch", payload);

		expect((await finalize("att-mismatch")).status).toBe(409);
		expect(await row("att-mismatch")).toMatchObject({ state: "aborted" });
		expect(
			await store.exists((await row("att-mismatch"))?.storage_key ?? ""),
		).toBe(false);
	});

	test("finalize is idempotent", async () => {
		const payload = new TextEncoder().encode("final");
		await reserve("att-final", { declaredBytes: payload.length });
		await upload("att-final", payload);

		const first = await finalize("att-final");
		const firstBody = await first.json();
		const second = await finalize("att-final");

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(firstBody);
		expect(await row("att-final")).toMatchObject({ state: "committed" });
	});

	test("finalize stays idempotent after a later rotation starts", async () => {
		const payload = new TextEncoder().encode("final");
		await reserve("att-final-rotated", { declaredBytes: payload.length });
		await upload("att-final-rotated", payload);
		const first = await finalize("att-final-rotated");
		await pool.query(
			"update workspace set rotation_required = true where id = $1",
			[WORKSPACE],
		);

		const second = await finalize("att-final-rotated");

		expect(second.status).toBe(200);
		expect(await second.json()).toEqual(await first.json());
	});

	test("expires a reservation that was never finalized", async () => {
		await reserve("att-expired");
		await pool.query(
			"update attachment set reservation_expires_at = $2 where id = $1",
			["att-expired", new Date(NOW.getTime() - 1)],
		);

		expect(await expireAttachmentReservations(pool, NOW)).toBe(1);
		expect(await row("att-expired")).toMatchObject({ state: "aborted" });
	});

	test("refuses finalize after the reservation expires", async () => {
		const payload = new TextEncoder().encode("late");
		await reserve("att-finalize-expired", { declaredBytes: payload.length });
		await upload("att-finalize-expired", payload);
		const storageKey = (await row("att-finalize-expired"))?.storage_key ?? "";
		currentNow = new Date(NOW.getTime() + 600_001);

		expect((await finalize("att-finalize-expired")).status).toBe(410);
		expect(await row("att-finalize-expired")).toMatchObject({
			state: "aborted",
		});
		expect(await store.exists(storageKey)).toBe(false);
	});

	test("leaves an uploaded, unfinalized row discoverable by the sweep index", async () => {
		const payload = new TextEncoder().encode("waiting");
		await reserve("att-waiting", { declaredBytes: payload.length });
		await upload("att-waiting", payload);

		const found = await pool.query<{ id: string }>(
			`select id from attachment
			 where state = 'uploading' and reservation_expires_at < $1`,
			[new Date(NOW.getTime() + 600_001)],
		);
		expect(found.rows).toEqual([{ id: "att-waiting" }]);
	});

	test("parent deletion during upload aborts the reservation", async () => {
		expect(
			(await reserve("att-parent-gone", { declaredBytes: 4 })).status,
		).toBe(200);
		const pause = store.pauseNextPut();
		const response = upload("att-parent-gone", new Uint8Array(4));
		await pause.started.promise;
		await pool.query("delete from task where id = $1", [TASK]);
		pause.release.resolve();

		expect((await response).status).toBe(409);
		expect(await row("att-parent-gone")).toMatchObject({ state: "aborted" });
	});

	test("membership removal during upload aborts the reservation", async () => {
		expect(
			(await reserve("att-member-gone", { declaredBytes: 4 }, "upload-member"))
				.status,
		).toBe(200);
		const pause = store.pauseNextPut();
		const response = upload(
			"att-member-gone",
			new Uint8Array(4),
			"upload-member",
		);
		await pause.started.promise;
		await pool.query("delete from membership where id = 'upload-m-member'");
		pause.release.resolve();

		expect((await response).status).toBe(403);
		expect(await row("att-member-gone")).toMatchObject({ state: "aborted" });
	});

	test("key rotation during upload aborts the reservation", async () => {
		expect(
			(await reserve("att-key-rotated", { declaredBytes: 4 })).status,
		).toBe(200);
		const pause = store.pauseNextPut();
		const response = upload("att-key-rotated", new Uint8Array(4));
		await pause.started.promise;
		await pool.query(
			"update workspace_key set active = false where workspace_id = $1",
			[WORKSPACE],
		);
		pause.release.resolve();

		expect((await response).status).toBe(409);
		expect(await row("att-key-rotated")).toMatchObject({ state: "aborted" });
	});

	test("the state machine refuses reserved -> committed", () => {
		expect(() => assertAttachmentTransition("reserved", "committed")).toThrow(
			/reserved -> committed/,
		);
	});
});
