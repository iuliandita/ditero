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
import {
	DESKTOP_MAILBOX_LIMIT,
	parseDesktopRegistration,
} from "../native-push/desktop-contracts.ts";
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
					provider: string;
				}>(sql`
     select r.id,r.user_id,r.session_id,r.device_id,r.config_ciphertext,r.provider
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
				if (
					decoded &&
					typeof decoded === "object" &&
					!Array.isArray(decoded) &&
					parseDesktopRegistration(decoded as Record<string, unknown>)
				) {
					if (target.provider !== "desktop")
						return permanent("native push target config invalid");
					const source = await tx.execute<{
						expires_at: Date;
						live: boolean;
					}>(sql`
						select created_at+interval '24 hours' as expires_at, created_at+interval '24 hours'>clock_timestamp() as live
						from notification_outbox where id=${row.id} and recipient_user_id=${row.recipientUserId}
						and native_registration_id=${target.id} and channel_kind='nativepush' for share
					`);
					if (!source.rows[0]?.live)
						return permanent("native desktop notification expired");
					const duplicate = await tx.execute(
						sql`select notification_id from native_desktop_mailbox where notification_id=${row.id} and registration_id=${target.id} and user_id=${row.recipientUserId}`,
					);
					if (duplicate.rows.length) return { ok: true as const, status: 202 };
					const unread = await tx.execute<{ count: string }>(sql`
						select count(*) as count from native_desktop_mailbox where registration_id=${target.id}
						and user_id=${row.recipientUserId} and received_at is null and expires_at>clock_timestamp()
					`);
					if (Number(unread.rows[0]?.count) >= DESKTOP_MAILBOX_LIMIT)
						return {
							ok: false as const,
							status: 429,
							error: "native desktop mailbox full",
						};
					await tx.execute(sql`
						insert into native_desktop_mailbox(notification_id,registration_id,user_id,expires_at)
						values(${row.id},${target.id},${row.recipientUserId},${source.rows[0].expires_at}) on conflict(notification_id) do nothing
					`);
					return { ok: true as const, status: 202 };
				}

				const registration =
					decoded && typeof decoded === "object" && !Array.isArray(decoded)
						? parseRegistration(decoded as Record<string, unknown>)
						: null;
				if (!registration || registration.provider !== target.provider)
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
