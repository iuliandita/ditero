import { LIMITS } from "./contracts.ts";
import type { Store } from "./store.ts";
export async function prune(store: Store): Promise<void> {
	await store.transaction(async (client) => {
		await client.query("SELECT pg_advisory_xact_lock(492002)");
		let remaining: number = LIMITS.prune;
		const installations = await client.query<{ id: string }>(
			"SELECT i.id FROM relay_installation i WHERE (i.created_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM relay_target t WHERE t.installation_id=i.id)) OR EXISTS(SELECT 1 FROM relay_target t WHERE t.installation_id=i.id AND ((t.state='issued' AND t.offer_expires<now()) OR (t.state='retired' AND t.retired_at<now()-interval '7 days') OR t.pending_expires<now() OR EXISTS(SELECT 1 FROM relay_operation o WHERE o.target_id=t.id AND o.created_at<now()-interval '7 days'))) ORDER BY i.id LIMIT $1 FOR UPDATE SKIP LOCKED",
			[LIMITS.prune],
		);
		for (const installation of installations.rows) {
			if (remaining <= 0) break;
			const targets = await client.query<{
				id: string;
				state: string;
				offer_expires: Date;
				retired_at: Date | null;
				pending_expires: Date | null;
			}>(
				"SELECT id,state,offer_expires,retired_at,pending_expires FROM relay_target WHERE installation_id=$1 ORDER BY id FOR UPDATE",
				[installation.id],
			);
			for (const target of targets.rows) {
				if (remaining <= 0) break;
				const deleted = await client.query(
					"DELETE FROM relay_operation WHERE id IN(SELECT id FROM relay_operation WHERE target_id=$1 AND created_at<now()-interval '7 days' LIMIT $2)",
					[target.id, remaining],
				);
				remaining -= deleted.rowCount ?? 0;
				if (remaining <= 0) break;
				if (
					target.state === "issued" &&
					target.offer_expires.getTime() < Date.now()
				) {
					await client.query(
						"UPDATE relay_target SET state='retired',retired_at=offer_expires,challenge_encrypted=NULL WHERE id=$1",
						[target.id],
					);
					remaining--;
				} else if (
					target.pending_expires &&
					target.pending_expires.getTime() < Date.now()
				) {
					await client.query(
						"UPDATE relay_target SET pending_fid=NULL,pending_management_hash=NULL,pending_challenge=NULL,pending_expires=NULL,pending_operation_id=NULL WHERE id=$1",
						[target.id],
					);
					remaining--;
				}
				if (remaining <= 0) break;
				const expired =
					(target.state === "retired" &&
						target.retired_at &&
						target.retired_at.getTime() <
							Date.now() - LIMITS.retention * 1000) ||
					(target.state === "issued" &&
						target.offer_expires.getTime() <
							Date.now() - LIMITS.retention * 1000);
				if (expired) {
					const count = Number(
						(
							await client.query<{ count: string }>(
								"SELECT count(*) FROM relay_operation WHERE target_id=$1",
								[target.id],
							)
						).rows[0].count,
					);
					if (count + 1 <= remaining) {
						await client.query(
							"DELETE FROM relay_operation WHERE target_id=$1",
							[target.id],
						);
						await client.query("DELETE FROM relay_target WHERE id=$1", [
							target.id,
						]);
						remaining -= count + 1;
					}
				}
			}
			if (remaining > 0) {
				const removed = await client.query(
					"DELETE FROM relay_installation WHERE id=$1 AND created_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM relay_target WHERE installation_id=$1)",
					[installation.id],
				);
				remaining -= removed.rowCount ?? 0;
			}
		}
		if (remaining > 0) {
			const removed = await client.query(
				"DELETE FROM relay_nonce WHERE (key_thumbprint,nonce) IN(SELECT key_thumbprint,nonce FROM relay_nonce WHERE expires_at<now() LIMIT $1)",
				[remaining],
			);
			remaining -= removed.rowCount ?? 0;
		}
		if (remaining > 0)
			await client.query(
				"DELETE FROM relay_quota WHERE key IN(SELECT key FROM relay_quota WHERE window_start<now()-interval '1 day' LIMIT $1)",
				[remaining],
			);
	});
}
