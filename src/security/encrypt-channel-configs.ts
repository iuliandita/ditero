// Backfill for notification_channel.config rows written before at-rest
// encryption landed (M3a Task 15), and the rotation pass that moves already-
// enveloped secrets onto DITERO_ENCRYPTION_KEY_NEXT. Idempotent: a row already
// under the write key is left alone, so this is safe to run on every deploy.
//
// It is meant to run against a LIVE app, so each row is claimed with SELECT ...
// FOR UPDATE inside its own transaction: without that, a user saving a channel
// between the read and the write would have their new token silently reverted
// to the pre-backfill value.
import type { Pool } from "pg";
import type { ChannelKind } from "../domain/notification-channel.ts";
import { channelKeyRing, reencryptChannelConfig } from "./channel-config.ts";
import type { FieldKeyRing } from "./field-encryption.ts";

export type BackfillOptions = {
	// Test seam for the lost-update case: fires between the id scan and each
	// row's transaction, which is the window a stale captured value would be
	// written from. Inert unless passed.
	onBeforeRow?: (id: string) => Promise<void>;
};

export async function backfillChannelConfigs(
	pool: Pool,
	ring: FieldKeyRing,
	options: BackfillOptions = {},
): Promise<number> {
	// Ids only: the row itself is read again under the lock, so a value read
	// here could never go stale into a write.
	const { rows: ids } = await pool.query<{ id: string }>(
		"select id from notification_channel",
	);

	let changed = 0;
	for (const { id } of ids) {
		await options.onBeforeRow?.(id);
		const client = await pool.connect();
		try {
			await client.query("begin");
			const { rows } = await client.query<{
				kind: ChannelKind;
				config: Record<string, unknown>;
			}>(
				"select kind, config from notification_channel where id = $1 for update",
				[id],
			);
			// Deleted between the id scan and the lock.
			if (rows.length === 0) {
				await client.query("commit");
				continue;
			}
			const { kind, config } = rows[0];
			const next = reencryptChannelConfig(kind, config, ring);
			if (JSON.stringify(next) !== JSON.stringify(config)) {
				await client.query(
					"update notification_channel set config = $1 where id = $2",
					[next, id],
				);
				changed++;
			}
			await client.query("commit");
		} catch (error) {
			await client.query("rollback").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
	return changed;
}

async function main(): Promise<void> {
	const ring = channelKeyRing();
	if (!ring) throw new Error("DITERO_ENCRYPTION_KEY is required");
	// Matches rotate-auth-secrets: the migration role is the one that owns
	// rewrites, when the deployment separates it from the runtime role.
	const connectionString =
		process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required");

	const { Pool } = await import("pg");
	const pool = new Pool({ connectionString });
	try {
		const changed = await backfillChannelConfigs(pool, ring);
		console.log(`encrypt-channel-configs: rewrote ${changed} row(s)`);
	} finally {
		await pool.end();
	}
}

if (import.meta.main) await main();
