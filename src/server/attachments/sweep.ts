import { Cron } from "croner";
import type { Pool, PoolClient } from "pg";
import {
	attachmentSweepConfig,
	DEFAULT_ATTACHMENT_RETENTION_MS,
	DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE,
	MAX_ATTACHMENT_SWEEP_BATCH_SIZE,
} from "../../config/attachment-sweep.ts";
import { withLeaderLock } from "../notifications/scheduler.ts";
import type { BlobStore } from "../storage/blob-store.ts";
import type { AttachmentState } from "./state.ts";

type SweepRow = {
	id: string;
	state: AttachmentState;
	storageKey: string;
	thumbnailStorageKey: string | null;
	reservationExpiresAt: Date | null;
	deletedAt: Date | null;
};

export type AttachmentSweepOptions = {
	now?: Date;
	retentionMs?: number;
	batchSize?: number;
	onAfterBlobDelete?: (row: SweepRow) => void | Promise<void>;
	onError?: (error: unknown, row: SweepRow) => void;
};

export type AttachmentSweepSummary = {
	deleted: number;
	failed: number;
};

export const ATTACHMENT_SWEEP_LOCK_KEY = 918_277;

function validateOptions(
	options: AttachmentSweepOptions,
): Required<Pick<AttachmentSweepOptions, "now" | "retentionMs" | "batchSize">> {
	const now = options.now ?? new Date();
	const retentionMs = options.retentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS;
	const batchSize = options.batchSize ?? DEFAULT_ATTACHMENT_SWEEP_BATCH_SIZE;
	if (Number.isNaN(now.getTime()))
		throw new Error("attachment sweep now is invalid");
	if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
		throw new Error(
			"attachment sweep retention must be a positive safe integer",
		);
	}
	if (
		!Number.isSafeInteger(batchSize) ||
		batchSize <= 0 ||
		batchSize > MAX_ATTACHMENT_SWEEP_BATCH_SIZE
	) {
		throw new Error(
			`attachment sweep batch size must be between 1 and ${MAX_ATTACHMENT_SWEEP_BATCH_SIZE}`,
		);
	}
	return { now, retentionMs, batchSize };
}

function eligible(row: SweepRow, now: Date, deletingBefore: Date): boolean {
	if (row.state === "deleting") {
		return row.deletedAt !== null && row.deletedAt <= deletingBefore;
	}
	return (
		(row.state === "reserved" ||
			row.state === "uploading" ||
			row.state === "aborted") &&
		row.reservationExpiresAt !== null &&
		row.reservationExpiresAt <= now
	);
}

function toSweepRow(row: {
	id: string;
	state: AttachmentState;
	storage_key: string;
	thumbnail_storage_key: string | null;
	reservation_expires_at: Date | null;
	deleted_at: Date | null;
}): SweepRow {
	return {
		id: row.id,
		state: row.state,
		storageKey: row.storage_key,
		thumbnailStorageKey: row.thumbnail_storage_key,
		reservationExpiresAt: row.reservation_expires_at,
		deletedAt: row.deleted_at,
	};
}

async function lockedRow(
	client: PoolClient,
	id: string,
): Promise<SweepRow | null> {
	const result = await client.query<{
		id: string;
		state: AttachmentState;
		storage_key: string;
		thumbnail_storage_key: string | null;
		reservation_expires_at: Date | null;
		deleted_at: Date | null;
	}>(
		`select id, state, storage_key, thumbnail_storage_key,
		 reservation_expires_at, deleted_at
		 from attachment where id = $1 for update`,
		[id],
	);
	return result.rows[0] ? toSweepRow(result.rows[0]) : null;
}

async function deleteBlobs(store: BlobStore, row: SweepRow): Promise<void> {
	await store.delete(row.storageKey);
	if (row.thumbnailStorageKey) await store.delete(row.thumbnailStorageKey);
}

export async function attachmentSweep(
	pool: Pool,
	store: BlobStore,
	options: AttachmentSweepOptions = {},
): Promise<AttachmentSweepSummary> {
	const { now, retentionMs, batchSize } = validateOptions(options);
	const deletingBefore = new Date(now.getTime() - retentionMs);
	if (Number.isNaN(deletingBefore.getTime())) {
		throw new Error("attachment sweep retention produces an invalid cutoff");
	}
	const candidates = await pool.query<{ id: string }>(
		`select id from attachment
		 where (state = any($1::attachment_state[])
		        and reservation_expires_at <= $2)
		    or (state = 'deleting' and deleted_at <= $3)
		 order by id limit $4`,
		[["reserved", "uploading", "aborted"], now, deletingBefore, batchSize],
	);
	const summary: AttachmentSweepSummary = { deleted: 0, failed: 0 };

	for (const candidate of candidates.rows) {
		const client = await pool.connect();
		try {
			await client.query("begin");
			const row = await lockedRow(client, candidate.id);
			if (!row || !eligible(row, now, deletingBefore)) {
				await client.query("commit");
				continue;
			}

			try {
				await deleteBlobs(store, row);
			} catch (error) {
				await client.query("rollback");
				summary.failed++;
				(
					options.onError ??
					((failure) =>
						console.error(
							`attachments: failed to delete blob for ${row.id}:`,
							failure,
						))
				)(error, row);
				continue;
			}

			await options.onAfterBlobDelete?.(row);
			await client.query("delete from attachment where id = $1", [row.id]);
			await client.query(
				`delete from workspace w
				 using "user" owner_user
				 where w.owner_id = owner_user.id
				   and w.kind = 'personal'
				   and owner_user.deleted_at is not null
				   and not exists (
				     select 1 from attachment remaining
				     where remaining.workspace_id = w.id
				   )`,
			);
			await client.query("commit");
			summary.deleted++;
		} catch (error) {
			await client.query("rollback").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	return summary;
}

export async function runAttachmentSweepLeader(
	pool: Pool,
	store: BlobStore,
	options: AttachmentSweepOptions = {},
): Promise<AttachmentSweepSummary | null> {
	return await withLeaderLock(pool, ATTACHMENT_SWEEP_LOCK_KEY, () =>
		attachmentSweep(pool, store, options),
	);
}

export function startAttachmentSweep(
	pool: Pool,
	store: BlobStore,
	env: NodeJS.ProcessEnv = process.env,
): Cron {
	const config = attachmentSweepConfig(env);
	const seconds = Math.max(1, Math.round(config.intervalMs / 1000));
	return new Cron(
		"* * * * * *",
		{
			interval: seconds,
			protect: () =>
				console.warn(
					"attachments: previous garbage-collection sweep still running, skipping",
				),
		},
		async () => {
			try {
				await runAttachmentSweepLeader(pool, store, config);
			} catch (error) {
				console.error("attachments: garbage-collection sweep failed:", error);
			}
		},
	);
}
