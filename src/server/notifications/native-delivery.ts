import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";
import {
	decryptField,
	type FieldKeyRing,
} from "../../security/field-encryption.ts";
import {
	type PushConfiguration,
	parseRegistration,
} from "../native-push/contracts.ts";
import { nativePushConfigContext } from "../native-push/store.ts";
import { createNativePushSender } from "./adapters/native-push.ts";
import type { AdapterContext } from "./adapters/types.ts";
import { permanent } from "./adapters/types.ts";
import type { OutboxRow } from "./worker.ts";

type Database = NodePgDatabase<typeof tables>;
export function createNativeDelivery(
	database: Database,
	ring: FieldKeyRing | null,
	configuration: PushConfiguration,
) {
	const send = createNativePushSender(configuration);
	return async (row: OutboxRow, ctx: AdapterContext) => {
		if (!ring || !row.nativeRegistrationId)
			return permanent("native push target unavailable");
		try {
			return await database.transaction(async (tx) => {
				await tx.execute(
					sql`select set_config('ditero.user_id', ${row.recipientUserId}, true)`,
				);
				// Match registration-write lock order. Revoke/replacement cannot complete during an accepted send.
				await tx.execute(
					sql`select id from "user" where id=${row.recipientUserId} and deleted_at is null for share`,
				);
				const { rows } = await tx.execute<{
					id: string;
					user_id: string;
					session_id: string;
					device_id: string;
					config_ciphertext: string;
				}>(sql`
     select r.id,r.user_id,r.session_id,r.device_id,r.config_ciphertext
     from native_push_registration r
     join session s on s.id=r.session_id and s.user_id=r.user_id
     join native_session_link l on l.session_id=s.id and l.user_id=r.user_id and l.device_id=r.device_id
     join user_device d on d.id=r.device_id and d.user_id=r.user_id
     join "user" u on u.id=r.user_id
     where r.id=${row.nativeRegistrationId} and r.user_id=${row.recipientUserId}
     and s.expires_at>clock_timestamp() and d.revoked_at is null and u.deleted_at is null
     for update of s,l,d,r
    `);
				const target = rows[0];
				if (!target) return permanent("native push target retired");
				const raw = row.payload as {
					taskId?: unknown;
					kind?: unknown;
					urgent?: unknown;
					workspaceId?: unknown;
				};
				const taskId = typeof raw?.taskId === "string" ? raw.taskId : null;
				if (taskId) {
					const member = await tx.execute(sql`
      select m.id from task t join list l on l.id=t.list_id
      join membership m on m.workspace_id=l.workspace_id and m.user_id=${row.recipientUserId}
      where t.id=${taskId}
      for share of t,l,m
     `);
					if (member.rows.length === 0)
						return permanent("native push task authority retired");
				} else if (
					raw?.kind !== "key_grant" ||
					typeof raw.workspaceId !== "string"
				) {
					return permanent("native push notification authority unavailable");
				} else {
					const member = await tx.execute(
						sql`select id from membership where workspace_id=${raw.workspaceId} and user_id=${row.recipientUserId} for share`,
					);
					if (member.rows.length === 0)
						return permanent("native push workspace authority retired");
				}
				const decoded: unknown = JSON.parse(
					decryptField(
						target.config_ciphertext,
						nativePushConfigContext(target.id, {
							userId: target.user_id,
							sessionId: target.session_id,
							deviceId: target.device_id,
						}),
						ring,
					).plaintext,
				);
				const registration =
					decoded && typeof decoded === "object" && !Array.isArray(decoded)
						? parseRegistration(decoded as Record<string, unknown>)
						: null;
				if (!registration)
					return permanent("native push target config invalid");
				const outcome = await send(
					registration,
					{ version: "1", notificationId: row.id, registrationId: target.id },
					ctx,
					raw?.urgent === true,
				);
				if (outcome.expired)
					await tx.execute(
						sql`delete from native_push_registration where id=${target.id} and config_ciphertext=${target.config_ciphertext}`,
					);
				return outcome.result;
			});
		} catch {
			return { ok: false as const, error: "native push delivery failed" };
		}
	};
}
