import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	UserContextError,
	withLiveUserContext,
} from "../../db/user-context.ts";
import {
	decryptField,
	encryptField,
	type FieldKeyRing,
} from "../../security/field-encryption.ts";
import type { NativeSession } from "../native-auth/session.ts";
import type {
	PushOpenInput,
	PushOpenTarget,
	PushRegistration,
} from "./contracts.ts";
import {
	DESKTOP_POLL_LIMIT,
	type DesktopPushMessage,
	type DesktopPushRegistration,
} from "./desktop-contracts.ts";

type StoredPushRegistration = PushRegistration | DesktopPushRegistration;

// Authority is checked and locked at retrieval, not assumed from enqueue time.
const desktopAuthority = `(
 (jsonb_typeof(o.payload->'taskId')='string' and o.payload->>'taskId'<>'' and exists (
  select 1 from task t join list l on l.id=t.list_id join workspace w on w.id=l.workspace_id
  join membership m on m.workspace_id=w.id and m.user_id=$2
  where t.id=o.payload->>'taskId' for share of t,l,w,m
 )) or (not (o.payload ? 'taskId') and o.payload->>'kind'='key_grant'
 and jsonb_typeof(o.payload->'workspaceId')='string' and exists (
  select 1 from workspace w join membership m on m.workspace_id=w.id and m.user_id=$2
  where w.id=o.payload->>'workspaceId' for share of w,m
 ))
)`;
export class PushAuthorityError extends Error {}
export function nativePushConfigContext(
	id: string,
	owner: Pick<NativeSession, "userId" | "sessionId" | "deviceId">,
): string {
	return `native-push:${id}:${owner.userId}:${owner.sessionId}:${owner.deviceId}`;
}
export class NativePushStore {
	constructor(
		private pool: Pool,
		private ring: FieldKeyRing | null,
	) {}
	protected async owned<T>(
		owner: NativeSession,
		run: (client: PoolClient) => Promise<T>,
		lockUser = false,
	): Promise<T> {
		try {
			return await withLiveUserContext(
				this.pool,
				owner.userId,
				async (client) => {
					if (lockUser) {
						// Keep account, then session/device, then registration lock order.
						const user = await client.query(
							'select id from "user" where id=$1 and deleted_at is null for share',
							[owner.userId],
						);
						if (user.rowCount !== 1) throw new PushAuthorityError();
					}
					const live = await client.query(
						`select s.id from session s join native_session_link l on l.session_id=s.id and l.user_id=s.user_id join user_device d on d.id=l.device_id and d.user_id=s.user_id where s.id=$1 and s.user_id=$2 and d.id=$3 and s.expires_at>clock_timestamp() and d.revoked_at is null for update of s,l,d`,
						[owner.sessionId, owner.userId, owner.deviceId],
					);
					if (live.rowCount !== 1) throw new PushAuthorityError();
					return run(client);
				},
			);
		} catch (error) {
			if (error instanceof UserContextError) throw new PushAuthorityError();
			throw error;
		}
	}
	async open(
		owner: NativeSession,
		input: PushOpenInput,
	): Promise<PushOpenTarget | null> {
		return this.owned(
			owner,
			async (client) => {
				const registration = await client.query(
					"select id from native_push_registration where id=$1 and session_id=$2 and user_id=$3 and device_id=$4 for share",
					[input.registrationId, owner.sessionId, owner.userId, owner.deviceId],
				);
				if (registration.rowCount !== 1) return null;
				const notification = await client.query<{ payload: unknown }>(
					"select payload from notification_outbox where id=$1 and recipient_user_id=$2 and native_registration_id=$3 and channel_kind='nativepush' for share",
					[input.notificationId, owner.userId, input.registrationId],
				);
				const payload = notification.rows[0]?.payload;
				if (!payload || typeof payload !== "object" || Array.isArray(payload))
					return null;
				const raw = payload as Record<string, unknown>;
				if (typeof raw.taskId === "string" && raw.taskId) {
					const target = await client.query<{
						task_id: string;
						list_id: string;
						workspace_id: string;
					}>(
						`select t.id as task_id,l.id as list_id,w.id as workspace_id
					from task t join list l on l.id=t.list_id
					join workspace w on w.id=l.workspace_id
					join membership m on m.workspace_id=w.id and m.user_id=$2
					where t.id=$1 for share of t,l,w,m`,
						[raw.taskId, owner.userId],
					);
					const row = target.rows[0];
					return row
						? {
								kind: "task",
								workspaceId: row.workspace_id,
								listId: row.list_id,
								taskId: row.task_id,
							}
						: null;
				}
				if (
					Object.hasOwn(raw, "taskId") ||
					raw.kind !== "key_grant" ||
					typeof raw.workspaceId !== "string" ||
					!raw.workspaceId
				)
					return null;
				const target = await client.query<{ workspace_id: string }>(
					"select w.id as workspace_id from workspace w join membership m on m.workspace_id=w.id and m.user_id=$2 where w.id=$1 for share of w,m",
					[raw.workspaceId, owner.userId],
				);
				return target.rows[0]
					? { kind: "workspace", workspaceId: target.rows[0].workspace_id }
					: null;
			},
			true,
		);
	}

	private async desktopOwned<T>(
		owner: NativeSession,
		registrationId: string,
		run: (client: PoolClient) => Promise<T>,
	): Promise<T | null> {
		return this.owned(
			owner,
			async (client) => {
				const registration = await client.query(
					"select id from native_push_registration where id=$1 and user_id=$2 and session_id=$3 and device_id=$4 and provider='desktop' for share",
					[registrationId, owner.userId, owner.sessionId, owner.deviceId],
				);
				return registration.rowCount === 1 ? run(client) : null;
			},
			true,
		);
	}
	async pollDesktop(
		owner: NativeSession,
		registrationId: string,
	): Promise<DesktopPushMessage[] | null> {
		return this.desktopOwned(owner, registrationId, async (client) => {
			const messages = await client.query<{ notification_id: string }>(
				`select b.notification_id from native_desktop_mailbox b join notification_outbox o on o.id=b.notification_id
				where b.registration_id=$1 and b.user_id=$2 and b.received_at is null and b.expires_at>clock_timestamp()
				and o.recipient_user_id=$2 and o.native_registration_id=$1 and o.channel_kind='nativepush'
				and ${desktopAuthority} order by b.notification_id limit $3 for share of b,o`,
				[registrationId, owner.userId, DESKTOP_POLL_LIMIT],
			);
			return messages.rows.map((row) => ({
				version: "1",
				notificationId: row.notification_id,
				registrationId,
			}));
		});
	}
	async receiptDesktop(
		owner: NativeSession,
		input: PushOpenInput,
	): Promise<boolean> {
		return (
			(await this.desktopOwned(owner, input.registrationId, async (client) => {
				const notification = await client.query<{ notification_id: string }>(
					`select b.notification_id from native_desktop_mailbox b join notification_outbox o on o.id=b.notification_id
				where b.registration_id=$1 and b.user_id=$2 and b.notification_id=$3 and b.expires_at>clock_timestamp()
				and o.recipient_user_id=$2 and o.native_registration_id=$1 and o.channel_kind='nativepush'
				and ${desktopAuthority} for update of b for share of o`,
					[input.registrationId, owner.userId, input.notificationId],
				);
				if (notification.rowCount !== 1) return false;
				await client.query(
					"update native_desktop_mailbox set received_at=coalesce(received_at,clock_timestamp()) where notification_id=$1",
					[input.notificationId],
				);
				return true;
			})) ?? false
		);
	}

	async register(
		owner: NativeSession,
		input: StoredPushRegistration,
	): Promise<{
		registrationId: string;
		provider: StoredPushRegistration["provider"];
	}> {
		const ring = this.ring;
		if (!ring) throw new Error("Native push encryption is unavailable");
		return this.owned(owner, async (client) => {
			const existing = await client.query<{
				id: string;
				config_ciphertext: string;
			}>(
				"select id,config_ciphertext from native_push_registration where session_id=$1",
				[owner.sessionId],
			);
			// A newer provider choice cancels every pending relay offer for this live session.
			await client.query(
				"update native_relay_authority set state='retiring',next_attempt=clock_timestamp() where session_id=$1 and user_id=$2 and device_id=$3 and state='issued'",
				[owner.sessionId, owner.userId, owner.deviceId],
			);
			const serialized = JSON.stringify(input);
			const row = existing.rows[0];
			if (
				row &&
				decryptField(
					row.config_ciphertext,
					nativePushConfigContext(row.id, owner),
					ring,
				).plaintext === serialized
			)
				return { registrationId: row.id, provider: input.provider };
			// Delete retires the old capability within the same locked transaction.
			await client.query(
				"delete from native_push_registration where session_id=$1",
				[owner.sessionId],
			);
			const id = randomUUID();
			const encrypted = encryptField(
				serialized,
				nativePushConfigContext(id, owner),
				ring,
			);
			await client.query(
				"insert into native_push_registration (id,session_id,user_id,device_id,provider,config_ciphertext) values ($1,$2,$3,$4,$5,$6)",
				[
					id,
					owner.sessionId,
					owner.userId,
					owner.deviceId,
					input.provider,
					encrypted,
				],
			);
			return { registrationId: id, provider: input.provider };
		});
	}
	async unregisterDesktop(
		owner: NativeSession,
		registrationId: string,
	): Promise<void> {
		await this.owned(
			owner,
			async (client) => {
				await client.query(
					"delete from native_push_registration where id=$1 and user_id=$2 and session_id=$3 and device_id=$4 and provider='desktop'",
					[registrationId, owner.userId, owner.sessionId, owner.deviceId],
				);
			},
			true,
		);
	}

	async unregister(owner: NativeSession): Promise<void> {
		await this.owned(owner, async (client) => {
			await client.query(
				"update native_relay_authority set state='retiring',next_attempt=clock_timestamp() where session_id=$1 and user_id=$2 and device_id=$3",
				[owner.sessionId, owner.userId, owner.deviceId],
			);
			await client.query(
				"delete from native_push_registration where session_id=$1",
				[owner.sessionId],
			);
		});
	}
}
