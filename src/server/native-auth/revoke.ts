import type { Pool } from "pg";
import {
	UserContextError,
	withLiveUserContext,
} from "../../db/user-context.ts";
import type { NativeSession } from "./session.ts";

export async function revokeNativeSession(
	pool: Pool,
	session: NativeSession,
): Promise<boolean> {
	try {
		return await withLiveUserContext(pool, session.userId, async (client) => {
			// Account first, then the exact live native authority. Recheck after
			// authentication so concurrent expiry or revocation cannot succeed.
			const live = await client.query(
				`select s.id from session s
				join native_session_link l on l.session_id = s.id and l.user_id = s.user_id
				join user_device d on d.id = l.device_id and d.user_id = s.user_id
				where s.id = $1 and s.user_id = $2 and d.id = $3
					and s.expires_at > clock_timestamp() and d.revoked_at is null
				for update of s, l, d`,
				[session.sessionId, session.userId, session.deviceId],
			);
			if (live.rowCount !== 1) return false;
			await client.query(
				"update user_device set revoked_at = clock_timestamp() where id = $1 and user_id = $2",
				[session.deviceId, session.userId],
			);
			// Deleting the session also cascades its native link. Existing Zero
			// JWTs lose their database authority immediately after commit.
			await client.query("delete from session where id = $1 and user_id = $2", [
				session.sessionId,
				session.userId,
			]);
			return true;
		});
	} catch (error) {
		if (error instanceof UserContextError) return false;
		throw error;
	}
}
