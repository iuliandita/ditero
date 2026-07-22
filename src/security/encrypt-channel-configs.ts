// Backfill for notification_channel.config rows written before at-rest
// encryption landed (M3a Task 15). Idempotent: an already-enveloped secret is
// left alone, so this is safe to run on every deploy. Also re-envelopes under
// the write key when DITERO_ENCRYPTION_KEY_NEXT is set, matching
// rotate-auth-secrets.
import { Pool } from "pg";
import type { ChannelKind } from "../domain/notification-channel.ts";
import { channelKeyRing, encryptChannelConfig } from "./channel-config.ts";

async function main(): Promise<void> {
	const ring = channelKeyRing();
	if (!ring) throw new Error("DITERO_ENCRYPTION_KEY is required");
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) throw new Error("DATABASE_URL is required");

	const pool = new Pool({ connectionString });
	let changed = 0;
	try {
		const { rows } = await pool.query<{
			id: string;
			kind: ChannelKind;
			config: Record<string, unknown>;
		}>("select id, kind, config from notification_channel");
		for (const row of rows) {
			const next = encryptChannelConfig(row.kind, row.config, ring);
			if (JSON.stringify(next) === JSON.stringify(row.config)) continue;
			await pool.query(
				"update notification_channel set config = $1 where id = $2",
				[next, row.id],
			);
			changed++;
		}
	} finally {
		await pool.end();
	}
	console.log(`encrypt-channel-configs: rewrote ${changed} row(s)`);
}

await main();
