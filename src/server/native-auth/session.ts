// Native bearer authentication. One join is the whole authority: a token
// counts only while its session is unexpired, linked as native, tied to a
// matching device that is not revoked, and owned by a user that is not deleted.
// Browser and orphan tokens match no row.
import type { Pool } from "pg";
import { withUserContext } from "../../db/user-context.ts";
import { parseBearer } from "./contracts.ts";

export type NativeSession = {
	sessionId: string;
	userId: string;
	deviceId: string;
	deviceLabel: string;
	expiresAt: Date;
	firstSeenAt: Date;
	lastSeenAt: Date;
};

type Row = {
	session_id: string;
	user_id: string;
	device_id: string;
	label: string;
	expires_at: Date;
	first_seen_at: Date;
	last_seen_at: Date;
};

export async function lookupNativeSession(
	pool: Pool,
	token: string,
): Promise<NativeSession | null> {
	const session = await pool.query<{ user_id: string }>(
		"select user_id from session where token = $1 and expires_at > now()",
		[token],
	);
	const userId = session.rows[0]?.user_id;
	if (!userId) return null;
	// Scope device RLS from the database; the complete join still authorizes.
	const result = await withUserContext(pool, userId, (client) =>
		client.query<Row>(
			`select s.id as session_id, s.user_id, s.expires_at,
			d.id as device_id, d.label, d.first_seen_at, d.last_seen_at
		from session s
		join native_session_link l on l.session_id = s.id and l.user_id = s.user_id
		join user_device d on d.id = l.device_id and d.user_id = s.user_id
		join "user" u on u.id = s.user_id
		where s.token = $1
			and s.expires_at > now()
			and u.deleted_at is null
			and d.revoked_at is null`,
			[token],
		),
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		sessionId: row.session_id,
		userId: row.user_id,
		deviceId: row.device_id,
		deviceLabel: row.label,
		expiresAt: row.expires_at,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
	};
}

// Bearer only. A cookie or Origin beside it means a browser is involved, and a
// missing cookie is never treated as authentication, so mixed credentials are
// refused rather than resolved.
export async function authenticateNative(
	pool: Pool,
	headers: Headers,
): Promise<NativeSession | null> {
	if (headers.has("origin") || headers.has("cookie")) return null;
	const token = parseBearer(headers);
	return token === null ? null : lookupNativeSession(pool, token);
}
