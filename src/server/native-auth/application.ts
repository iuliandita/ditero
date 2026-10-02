// Native application operations: the minimum a signed-in native client needs
// before it can start syncing. Both take the live session that
// authenticateNative already verified and derive every identifier from it.
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { ensurePersonalWorkspaceInTransaction } from "../../auth/bootstrap.ts";
import * as schema from "../../db/schema.ts";
import {
	UserContextError,
	withLiveUserContext,
} from "../../db/user-context.ts";
import { readJsonObject } from "./contracts.ts";
import type { NativeSession } from "./session.ts";

export type NativeProfile = { id: string; name: string; email: string };

// A fresh read: the session join proved the user was live, but this lookup is
// what decides what is returned, so a user deleted in between yields null.
export async function readNativeProfile(
	pool: Pool,
	session: NativeSession,
): Promise<NativeProfile | null> {
	const result = await pool.query<NativeProfile>(
		'select id, name, email from "user" where id = $1 and deleted_at is null',
		[session.userId],
	);
	const row = result.rows[0];
	return row ? { id: row.id, name: row.name, email: row.email } : null;
}

// Delegates to the existing provisioning helper, which is idempotent and
// restores a missing owner membership. Returns null when the user is gone.
export async function bootstrapNativeWorkspace(
	pool: Pool,
	session: NativeSession,
): Promise<string | null> {
	try {
		return await withLiveUserContext(pool, session.userId, async (client) => {
			const result = await client.query<NativeProfile>(
				'select id, name, email from "user" where id = $1 and deleted_at is null',
				[session.userId],
			);
			const profile = result.rows[0];
			if (!profile) return null;
			return ensurePersonalWorkspaceInTransaction(
				profile,
				drizzle(client, { schema }),
			);
		});
	} catch (error) {
		if (error instanceof UserContextError) return null;
		throw error;
	}
}

export type BootstrapBody =
	| { ok: true }
	| { ok: false; status: 400 | 413 | 415 };

// Bootstrap takes no input. An absent body or an empty JSON object is accepted;
// anything else, including any key at all, is refused.
export async function readBootstrapBody(
	request: Request,
): Promise<BootstrapBody> {
	if (request.body === null) return { ok: true };
	if (!request.headers.has("content-type")) return { ok: false, status: 415 };
	const body = await readJsonObject(request);
	if (!body.ok) return body;
	return Object.keys(body.value).length === 0
		? { ok: true }
		: { ok: false, status: 400 };
}
