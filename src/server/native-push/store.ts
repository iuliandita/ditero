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
import type { PushRegistration } from "./contracts.ts";
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
		private ring: FieldKeyRing,
	) {}
	private async owned<T>(
		owner: NativeSession,
		run: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		try {
			return await withLiveUserContext(
				this.pool,
				owner.userId,
				async (client) => {
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
	async register(
		owner: NativeSession,
		input: PushRegistration,
	): Promise<{
		registrationId: string;
		provider: PushRegistration["provider"];
	}> {
		return this.owned(owner, async (client) => {
			const existing = await client.query<{
				id: string;
				config_ciphertext: string;
			}>(
				"select id,config_ciphertext from native_push_registration where session_id=$1",
				[owner.sessionId],
			);
			const serialized = JSON.stringify(input);
			const row = existing.rows[0];
			if (
				row &&
				decryptField(
					row.config_ciphertext,
					nativePushConfigContext(row.id, owner),
					this.ring,
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
				this.ring,
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
	async unregister(owner: NativeSession): Promise<void> {
		await this.owned(owner, async (client) => {
			await client.query(
				"delete from native_push_registration where session_id=$1",
				[owner.sessionId],
			);
		});
	}
}
