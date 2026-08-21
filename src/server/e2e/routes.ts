import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { e2eEnabled } from "../../config/e2e.ts";
import { withUserContext } from "../../db/user-context.ts";
import type { Guards } from "../guards.ts";

// Wrapped blobs and salts are opaque to the server, so the only checks it can
// make are shape and size. 64 KiB is far above any real envelope and far below
// anything that would let a caller use enrollment as storage.
const MAX_BLOB = 64 * 1024;
const blob = z.string().min(1).max(MAX_BLOB);

// An X25519 public key is exactly 32 bytes. Checking the decoded length rather
// than the string length is what rejects a 43-character string that happens to
// be valid base64url of the wrong size.
const publicKey = z
	.string()
	.max(64)
	.refine((value) => {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
		try {
			return Buffer.from(value, "base64url").length === 32;
		} catch {
			return false;
		}
	}, "publicKey must be 32 bytes base64url");

const enrollBody = z.object({
	publicKey,
	passphraseWrapped: blob,
	recoveryWrapped: blob,
	passphraseSalt: blob,
	recoverySalt: blob,
});

export function e2eRoutes(pool: Pool, guards: Guards) {
	return new Elysia().post(
		"/api/e2e/enroll",
		guards.guardedPost(async (request, session) => {
			// Read per request, not at mount time: the flag decides whether the
			// feature EXISTS, and a disabled deployment must answer 404 rather
			// than 403 -- a 403 tells an unauthenticated prober that the feature
			// is there and merely closed to them.
			if (!e2eEnabled()) return new Response("Not Found", { status: 404 });

			let parsed: z.infer<typeof enrollBody>;
			try {
				parsed = enrollBody.parse(await request.json());
			} catch {
				return new Response("Bad Request", { status: 400 });
			}

			const userId = session.user.id;
			return await withUserContext(pool, userId, async (client) => {
				// Insert-then-read, not read-then-insert: two concurrent first
				// enrollments both reach the insert, one wins, and both then read
				// the same winning row. The read-first order would let both decide
				// they are the first and race on the write.
				await client.query(
					`insert into user_key (id, user_id, public_key, passphrase_wrapped,
					 recovery_wrapped, passphrase_salt, recovery_salt, state)
					 values ($1, $2, $3, $4, $5, $6, $7, 'ready')
					 on conflict (user_id) do nothing`,
					[
						`uk_${crypto.randomUUID()}`,
						userId,
						parsed.publicKey,
						parsed.passphraseWrapped,
						parsed.recoveryWrapped,
						parsed.passphraseSalt,
						parsed.recoverySalt,
					],
				);

				const stored = await client.query<{
					public_key: string;
					state: string;
				}>("select public_key, state from user_key where user_id = $1", [
					userId,
				]);
				const row = stored.rows[0];
				if (!row) return new Response("Conflict", { status: 409 });

				// An enrolled identity is immutable. Replacing one is identity
				// rotation, which has preconditions this endpoint does not check.
				if (row.public_key !== parsed.publicKey) {
					return new Response("Conflict", { status: 409 });
				}
				// Never echo a wrapped blob or a salt: the response is the state,
				// not the material.
				return { publicKey: row.public_key, state: row.state };
			});
		}),
	);
}
