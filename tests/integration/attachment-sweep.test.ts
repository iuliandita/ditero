import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	ATTACHMENT_SWEEP_LOCK_KEY,
	attachmentSweep,
	runAttachmentSweepLeader,
} from "../../src/server/attachments/sweep.ts";
import {
	SCHEDULER_LOCK_KEY,
	withLeaderLock,
} from "../../src/server/notifications/scheduler.ts";
import {
	BlobNotFoundError,
	type BlobStore,
} from "../../src/server/storage/blob-store.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

class MemoryBlobStore implements BlobStore {
	readonly objects = new Map<string, Uint8Array>();
	readonly deleteFailures = new Set<string>();
	readonly deleted: string[] = [];
	#deletePause: {
		started: ReturnType<typeof Promise.withResolvers<void>>;
		release: ReturnType<typeof Promise.withResolvers<void>>;
	} | null = null;

	reset(): void {
		this.objects.clear();
		this.deleteFailures.clear();
		this.deleted.length = 0;
		this.#deletePause = null;
	}

	pauseNextDelete() {
		const pause = {
			started: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
		};
		this.#deletePause = pause;
		return pause;
	}

	async put(key: string, body: AsyncIterable<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of body) {
			chunks.push(chunk);
			bytes += chunk.byteLength;
		}
		const value = new Uint8Array(bytes);
		let offset = 0;
		for (const chunk of chunks) {
			value.set(chunk, offset);
			offset += chunk.byteLength;
		}
		this.objects.set(key, value);
		return {
			bytes,
			sha256: createHash("sha256").update(value).digest("hex"),
		};
	}

	async get(key: string): Promise<AsyncIterable<Uint8Array>> {
		const value = this.objects.get(key);
		if (!value) throw new BlobNotFoundError(key);
		return (async function* () {
			yield value;
		})();
	}

	async delete(key: string): Promise<void> {
		if (this.deleteFailures.has(key)) throw new Error(`delete failed: ${key}`);
		const pause = this.#deletePause;
		this.#deletePause = null;
		if (pause) {
			pause.started.resolve();
			await pause.release.promise;
		}
		this.deleted.push(key);
		this.objects.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.objects.has(key);
	}
}

const pool = new Pool({ connectionString: databaseURL, max: 8 });
const store = new MemoryBlobStore();
const NOW = new Date("2026-09-02T12:00:00.000Z");
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const WORKSPACE = "sweep-w";

type State = "reserved" | "uploading" | "committed" | "aborted" | "deleting";

async function seedAttachment(
	id: string,
	state: State,
	options: {
		reservationExpiresAt?: Date | null;
		deletedAt?: Date | null;
		thumbnail?: boolean;
	} = {},
): Promise<{ storageKey: string; thumbnailKey: string | null }> {
	const storageKey = `sweep-w/00/${id}`;
	const thumbnailKey = options.thumbnail ? `${storageKey}.thumb` : null;
	await pool.query(
		`insert into attachment (id, workspace_id, parent_kind, parent_id,
		 key_version, state, filename_ciphertext, content_type_ciphertext,
		 dek_wrapped, declared_bytes, observed_bytes, ciphertext_sha256,
		 storage_key, thumbnail_storage_key, uploaded_by,
		 reservation_expires_at, committed_at, deleted_at)
		 values ($1, $2, 'task', 'sweep-parent', 1, $3::attachment_state,
		 'name', 'type', 'dek', 4, 4, repeat('a', 64), $4, $5,
		 'sweep-owner', $6, case when $3::attachment_state in ('committed', 'deleting')
		 then $8::timestamptz else null end, $7)`,
		[
			id,
			WORKSPACE,
			state,
			storageKey,
			thumbnailKey,
			options.reservationExpiresAt ?? null,
			options.deletedAt ?? null,
			NOW,
		],
	);
	store.objects.set(storageKey, new Uint8Array([1, 2, 3, 4]));
	if (thumbnailKey) store.objects.set(thumbnailKey, new Uint8Array([5, 6]));
	return { storageKey, thumbnailKey };
}

async function attachmentExists(id: string): Promise<boolean> {
	return (
		(await pool.query("select 1 from attachment where id = $1", [id]))
			.rowCount === 1
	);
}

beforeEach(async () => {
	await resetAuthFixture(pool);
	store.reset();
	await pool.query(
		`insert into "user" (id, name, email, email_verified, created_at, updated_at)
		 values ('sweep-owner', 'Owner', 'sweep-owner@test.invalid', true, now(), now())`,
	);
	await pool.query(
		`insert into workspace (id, name, owner_id, kind)
		 values ($1, 'Sweep', 'sweep-owner', 'shared')`,
		[WORKSPACE],
	);
});

afterAll(async () => {
	try {
		await resetAuthFixture(pool);
	} finally {
		await pool.end();
	}
});

const sweep = (overrides: Parameters<typeof attachmentSweep>[2] = {}) =>
	attachmentSweep(pool, store, {
		now: NOW,
		retentionMs: RETENTION_MS,
		...overrides,
	});

describe("attachment garbage collection", () => {
	test("removes an expired reservation blob before its row", async () => {
		const { storageKey } = await seedAttachment("sweep-reserved", "reserved", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});

		expect(await sweep()).toEqual({ deleted: 1, failed: 0 });
		expect(store.deleted).toEqual([storageKey]);
		expect(await store.exists(storageKey)).toBe(false);
		expect(await attachmentExists("sweep-reserved")).toBe(false);
	});

	test("removes both blob and thumbnail from an old deleting row", async () => {
		const { storageKey, thumbnailKey } = await seedAttachment(
			"sweep-deleting",
			"deleting",
			{
				deletedAt: new Date(NOW.getTime() - RETENTION_MS - 1),
				thumbnail: true,
			},
		);

		expect(await sweep()).toEqual({ deleted: 1, failed: 0 });
		expect(store.deleted).toEqual([storageKey, thumbnailKey]);
		expect(store.objects.size).toBe(0);
		expect(await attachmentExists("sweep-deleting")).toBe(false);
	});

	test("a crash after blob deletion leaves a row that the next pass can sweep", async () => {
		const { storageKey, thumbnailKey } = await seedAttachment(
			"sweep-crash",
			"deleting",
			{
				deletedAt: new Date(NOW.getTime() - RETENTION_MS - 1),
				thumbnail: true,
			},
		);

		await expect(
			sweep({
				onAfterBlobDelete: () => {
					throw new Error("simulated process death");
				},
			}),
		).rejects.toThrow("simulated process death");
		expect(store.deleted).toEqual([storageKey, thumbnailKey]);
		expect(await attachmentExists("sweep-crash")).toBe(true);

		expect(await sweep()).toEqual({ deleted: 1, failed: 0 });
		expect(await attachmentExists("sweep-crash")).toBe(false);
	});

	test("never sweeps a committed row", async () => {
		const { storageKey } = await seedAttachment(
			"sweep-committed",
			"committed",
			{
				deletedAt: new Date(NOW.getTime() - RETENTION_MS - 1),
			},
		);

		expect(await sweep()).toEqual({ deleted: 0, failed: 0 });
		expect(await store.exists(storageKey)).toBe(true);
		expect(await attachmentExists("sweep-committed")).toBe(true);
	});

	test("keeps a deleting row inside the restore-safety window", async () => {
		const { storageKey } = await seedAttachment("sweep-retained", "deleting", {
			deletedAt: new Date(NOW.getTime() - RETENTION_MS + 1),
		});

		expect(await sweep()).toEqual({ deleted: 0, failed: 0 });
		expect(await store.exists(storageKey)).toBe(true);
		expect(await attachmentExists("sweep-retained")).toBe(true);
	});

	test("one driver failure leaves its row and continues with the batch", async () => {
		const failed = await seedAttachment("sweep-a-failed", "aborted", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		await seedAttachment("sweep-b-ok", "aborted", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		store.deleteFailures.add(failed.storageKey);
		const errors: unknown[] = [];

		expect(await sweep({ onError: (error) => errors.push(error) })).toEqual({
			deleted: 1,
			failed: 1,
		});
		expect(errors).toHaveLength(1);
		expect(await attachmentExists("sweep-a-failed")).toBe(true);
		expect(await attachmentExists("sweep-b-ok")).toBe(false);
	});

	test("bounds each pass to the configured batch size", async () => {
		await seedAttachment("sweep-batch-a", "aborted", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		await seedAttachment("sweep-batch-b", "aborted", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});

		expect(await sweep({ batchSize: 1 })).toEqual({ deleted: 1, failed: 0 });
		expect(await attachmentExists("sweep-batch-a")).toBe(false);
		expect(await attachmentExists("sweep-batch-b")).toBe(true);
	});

	test("holds the row lock across blob deletion and database removal", async () => {
		await seedAttachment("sweep-locked", "uploading", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		const pause = store.pauseNextDelete();
		const running = sweep();
		await pause.started.promise;

		const updater = await pool.connect();
		try {
			await updater.query("begin");
			await updater.query("set local lock_timeout = '100ms'");
			await expect(
				updater.query(
					"update attachment set state = 'committed' where id = 'sweep-locked'",
				),
			).rejects.toMatchObject({ code: "55P03" });
			await updater.query("rollback");
		} finally {
			await updater.query("rollback").catch(() => undefined);
			updater.release();
			pause.release.resolve();
		}

		expect(await running).toEqual({ deleted: 1, failed: 0 });
		expect(await attachmentExists("sweep-locked")).toBe(false);
	});

	test("two replicas run the sweep under one attachment leader lock", async () => {
		await seedAttachment("sweep-leader", "reserved", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let sweepRuns = 0;
		const leader = runAttachmentSweepLeader(pool, store, {
			now: NOW,
			retentionMs: RETENTION_MS,
			onAfterBlobDelete: async () => {
				sweepRuns++;
				entered.resolve();
				await release.promise;
			},
		});
		await entered.promise;

		const loser = await runAttachmentSweepLeader(pool, store, {
			now: NOW,
			retentionMs: RETENTION_MS,
			onAfterBlobDelete: () => {
				sweepRuns++;
			},
		});
		expect(loser).toBeNull();
		expect(sweepRuns).toBe(1);

		release.resolve();
		await leader;
		expect(await attachmentExists("sweep-leader")).toBe(false);
	});

	test("a held reminder lock does not block the attachment leader", async () => {
		expect(ATTACHMENT_SWEEP_LOCK_KEY).not.toBe(SCHEDULER_LOCK_KEY);
		await seedAttachment("sweep-independent", "reserved", {
			reservationExpiresAt: new Date(NOW.getTime() - 1),
		});
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reminderLeader = withLeaderLock(
			pool,
			SCHEDULER_LOCK_KEY,
			async () => {
				held.resolve();
				await release.promise;
			},
		);
		await held.promise;

		try {
			expect(
				await runAttachmentSweepLeader(pool, store, {
					now: NOW,
					retentionMs: RETENTION_MS,
				}),
			).toEqual({ deleted: 1, failed: 0 });
			expect(await attachmentExists("sweep-independent")).toBe(false);
		} finally {
			release.resolve();
			await reminderLeader;
		}
	});

	test("the deleting eligibility path has its timestamp index", async () => {
		const result = await pool.query<{ indexdef: string }>(
			`select indexdef from pg_indexes
			 where schemaname = 'public' and indexname = 'attachment_delete_sweep'`,
		);

		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.indexdef).toContain("(state, deleted_at)");
	});
});
