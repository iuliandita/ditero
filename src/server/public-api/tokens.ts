import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	UserContextError,
	withLiveUserContext,
	withUserContext,
} from "../../db/user-context.ts";
import { PublicApiError, tokenCreateSchema } from "../../domain/public-api.ts";
import { hashPAT } from "../../security/field-encryption.ts";

export type ApiActor = {
	userId: string;
	tokenId: string;
	access: "read" | "write";
};
const TOKEN_FIELDS = `id, name, hint, access, created_at as "createdAt", expires_at as "expiresAt", revoked_at as "revokedAt"`;
type TokenMetadata = {
	id: string;
	name: string;
	hint: string;
	access: "read" | "write";
	createdAt: Date;
	expiresAt: Date;
	revokedAt: Date | null;
};

export async function createPersonalAccessToken(
	pool: Pool,
	userId: string,
	input: unknown,
) {
	const parsed = tokenCreateSchema.safeParse(input);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-token-request",
			"Invalid token name, access or lifetime",
		);
	const token = `ditero_pat_${randomBytes(32).toString("base64url")}`;
	return withUserContext(pool, userId, async (client) => {
		const live = await client.query(
			'select id from "user" where id = $1 and deleted_at is null for update',
			[userId],
		);
		if (!live.rowCount) throw new UserContextError();
		const count = await client.query<{ count: number }>(
			`select count(*)::integer as count from personal_access_token
			where user_id = $1 and revoked_at is null and expires_at > statement_timestamp()`,
			[userId],
		);
		if (count.rows[0].count >= 20)
			throw new PublicApiError(
				409,
				"token-limit",
				"Revoke an active token before creating another",
			);
		const result = await client.query<TokenMetadata>(
			`insert into personal_access_token
			(id, user_id, name, token_hash, hint, access, created_at, expires_at)
			values ($1, $2, $3, $4, $5, $6, statement_timestamp(), statement_timestamp() + make_interval(days => $7)) returning ${TOKEN_FIELDS}`,
			[
				randomUUID(),
				userId,
				parsed.data.name,
				hashPAT(token),
				token.slice(-4),
				parsed.data.access,
				parsed.data.expiresInDays,
			],
		);
		return { ...result.rows[0], token };
	});
}

export async function listPersonalAccessTokens(pool: Pool, userId: string) {
	return withLiveUserContext(pool, userId, async (client) => {
		const rows = await client.query<TokenMetadata>(
			`select ${TOKEN_FIELDS} from personal_access_token
			where user_id = $1 order by (revoked_at is null and expires_at > statement_timestamp()) desc, created_at desc, id limit 100`,
			[userId],
		);
		return rows.rows;
	});
}

export async function revokePersonalAccessToken(
	pool: Pool,
	userId: string,
	id: string,
) {
	return withLiveUserContext(pool, userId, async (client) => {
		const result = await client.query(
			`update personal_access_token set revoked_at = coalesce(revoked_at, statement_timestamp())
			where id = $1 and user_id = $2 returning id`,
			[id, userId],
		);
		if (!result.rowCount)
			throw new PublicApiError(404, "not-found", "Token not found");
		return { id, revoked: true };
	});
}

export async function withPersonalAccessToken<T>(
	pool: Pool,
	token: string | null,
	access: "read" | "write",
	run: (client: PoolClient, actor: ApiActor) => Promise<T>,
): Promise<T> {
	const unauthorized = () =>
		new PublicApiError(
			401,
			"unauthorized",
			"A valid personal access token is required",
		);
	if (!token) throw unauthorized();
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query(
			"select set_config('statement_timeout', '5000', true), set_config('lock_timeout', '1000', true), set_config('ditero.pat_hash', $1, true)",
			[hashPAT(token)],
		);
		const initial = await client.query<{ id: string; user_id: string }>(
			`select id, user_id from personal_access_token
			where token_hash = $1 and revoked_at is null and expires_at > statement_timestamp()`,
			[hashPAT(token)],
		);
		const candidate = initial.rows[0];
		if (!candidate) throw unauthorized();
		// User-first order matches account deletion; recheck the token after locking.
		const live = await client.query(
			'select id from "user" where id = $1 and deleted_at is null for share',
			[candidate.user_id],
		);
		if (!live.rowCount) throw unauthorized();
		await client.query("select set_config('ditero.user_id', $1, true)", [
			candidate.user_id,
		]);
		const authenticated = await client.query<{ access: "read" | "write" }>(
			`select access from personal_access_token
			where id = $1 and token_hash = $2 and revoked_at is null and expires_at > statement_timestamp() for share`,
			[candidate.id, hashPAT(token)],
		);
		const row = authenticated.rows[0];
		if (!row) throw unauthorized();
		if (access === "write" && row.access !== "write")
			throw new PublicApiError(
				403,
				"insufficient-access",
				"A write token is required",
			);
		await client.query("select set_config('ditero.pat_hash', '', true)");
		const result = await run(client, {
			userId: candidate.user_id,
			tokenId: candidate.id,
			access: row.access,
		});
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		if (error instanceof UserContextError) throw unauthorized();
		throw error;
	} finally {
		client.release();
	}
}
