// Grant lifecycle for the native sign-in handoff. PostgreSQL is the only
// clock. Lock order is user, grant, session everywhere, matching account
// deletion's user-first order; only the claim step locks the grant.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	GRANT_TTL_MINUTES,
	type SessionHandle,
	type Sessions,
	s256Challenge,
} from "./contracts.ts";

export type { SessionHandle, Sessions } from "./contracts.ts";

// Load shedding only: exchanges hold no pooled connection while sessions mint.
export const MAX_CONCURRENT_EXCHANGES = 2;
export const PRUNE_BATCH = 1000;

export type ExchangeResult =
	| {
			kind: "ok";
			token: string;
			sessionId: string;
			userId: string;
			deviceId: string;
			expiresAt: Date;
	  }
	| { kind: "invalid" }
	| { kind: "pending" }
	| { kind: "busy" };

// Thrown when an exchange failed after a session may exist. Carries no token.
export class NativeExchangeError extends Error {
	constructor(
		readonly cleanupFailed: boolean,
		cause: unknown,
	) {
		super("Native exchange failed", { cause });
		this.name = "NativeExchangeError";
	}
}

type GrantRow = {
	challenge: string;
	device_label: string;
	approved_user_id: string | null;
	approved_session_id: string | null;
	consumed: boolean;
	expired: boolean;
};

type Claim = {
	kind: "claimed";
	userId: string;
	approverSession: string;
	deviceLabel: string;
	expiresAt: Date;
};

function lockBusy(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "55P03"
	);
}

const GRANT = `select challenge, device_label, approved_user_id, approved_session_id,
	consumed_at is not null as consumed, expires_at <= statement_timestamp() as expired
	from native_auth_grant where id = $1`;

async function grant(
	client: PoolClient,
	id: string,
	lock: boolean,
): Promise<GrantRow | undefined> {
	const result = await client.query<GrantRow>(
		lock ? `${GRANT} for update nowait` : GRANT,
		[id],
	);
	return result.rows[0];
}

async function lockUser(client: PoolClient, userId: string): Promise<boolean> {
	const result = await client.query(
		'select id from "user" where id = $1 and deleted_at is null for share nowait',
		[userId],
	);
	return result.rowCount === 1;
}

async function lockSession(
	client: PoolClient,
	sessionId: string,
	userId: string,
): Promise<boolean> {
	const result = await client.query(
		`select id from session where id = $1 and user_id = $2
		 and expires_at > statement_timestamp()
		 and not exists (select 1 from native_session_link where session_id = session.id)
		 for share nowait`,
		[sessionId, userId],
	);
	return result.rowCount === 1;
}

function challengeMatches(stored: string, challenge: string): boolean {
	const a = Buffer.from(stored);
	const b = Buffer.from(challenge);
	return a.length === b.length && timingSafeEqual(a, b);
}

export class NativeGrantStore {
	private active = 0;

	constructor(
		private readonly pool: Pool,
		private readonly sessions: Sessions,
	) {}

	async create(
		challenge: string,
		deviceLabel: string,
	): Promise<{ grantId: string; expiresAt: Date }> {
		const grantId = randomBytes(32).toString("base64url");
		const result = await this.pool.query<{ expires_at: Date }>(
			`insert into native_auth_grant (id, challenge, device_label, expires_at)
			values ($1, $2, $3, now() + make_interval(mins => $4))
			returning expires_at`,
			[grantId, challenge, deviceLabel, GRANT_TTL_MINUTES],
		);
		return { grantId, expiresAt: result.rows[0].expires_at };
	}

	async preview(grantId: string, userId: string, sessionId: string) {
		const result = await this.pool.query<{
			device_label: string;
			expires_at: Date;
			approved: boolean;
		}>(
			`select g.device_label, g.expires_at, g.approved_at is not null as approved
			from native_auth_grant g
			where g.id = $1 and g.expires_at > statement_timestamp()
				and g.consumed_at is null
				and (g.approved_user_id is null or g.approved_user_id = $2)
				and exists (
					select 1 from session s join "user" u on u.id = s.user_id
					where s.id = $3 and s.user_id = $2
						and s.expires_at > statement_timestamp() and u.deleted_at is null
						and not exists (select 1 from native_session_link l where l.session_id = s.id)
				)
				and (g.approved_at is null or exists (
					select 1 from session a where a.id = g.approved_session_id
						and a.user_id = $2 and a.expires_at > statement_timestamp()
				))`,
			[grantId, userId, sessionId],
		);
		const row = result.rows[0];
		return row
			? {
					deviceLabel: row.device_label,
					expiresAt: row.expires_at,
					state: row.approved ? ("approved" as const) : ("pending" as const),
				}
			: null;
	}

	// Bounded so unauthenticated creation cannot leave unlimited rows behind.
	async prune(batch: number = PRUNE_BATCH): Promise<number> {
		const result = await this.pool.query(
			`delete from native_auth_grant where ctid in (
				select ctid from native_auth_grant
				where expires_at < now()
					or consumed_at < now() - interval '1 hour'
				limit $1
				for update skip locked
			)`,
			[batch],
		);
		return result.rowCount ?? 0;
	}

	async approve(
		grantId: string,
		userId: string,
		sessionId: string,
	): Promise<"approved" | "invalid" | "busy"> {
		const client = await this.pool.connect();
		let discard = false;
		try {
			await client.query("begin");
			if (!(await lockUser(client, userId))) {
				await client.query("rollback");
				return "invalid";
			}
			const row = await grant(client, grantId, true);
			if (
				!row ||
				row.consumed ||
				row.expired ||
				row.approved_user_id !== null ||
				!(await lockSession(client, sessionId, userId))
			) {
				await client.query("rollback");
				return "invalid";
			}
			await client.query(
				`update native_auth_grant
				set approved_user_id = $2, approved_session_id = $3, approved_at = now()
				where id = $1`,
				[grantId, userId, sessionId],
			);
			await client.query("commit");
			return "approved";
		} catch (error) {
			try {
				await client.query("rollback");
			} catch {
				discard = true;
			}
			if (lockBusy(error)) return "busy";
			throw error;
		} finally {
			client.release(discard || undefined);
		}
	}

	async exchange(grantId: string, verifier: string): Promise<ExchangeResult> {
		if (this.active >= MAX_CONCURRENT_EXCHANGES) return { kind: "busy" };
		this.active++;
		try {
			return await this.runExchange(grantId, s256Challenge(verifier));
		} finally {
			this.active--;
		}
	}

	// No pooled connection is held while BetterAuth mints the session, so the
	// adapter can never wait on a slot this exchange owns.
	private async runExchange(
		grantId: string,
		challenge: string,
	): Promise<ExchangeResult> {
		const claim = await this.claim(grantId, challenge);
		if (claim.kind !== "claimed") return claim;
		// A throw here leaves the grant burned and any orphan session unlinked.
		const created = await this.sessions.createSession(claim.userId);
		return this.bind(claim, created);
	}

	// Validates and consumes the grant in one short transaction. An uncertain
	// commit throws: the grant may be burned, and no session is minted.
	private async claim(
		grantId: string,
		challenge: string,
	): Promise<Claim | Exclude<ExchangeResult, { kind: "ok" }>> {
		const usable = (row: GrantRow | undefined): row is GrantRow =>
			row !== undefined &&
			!row.consumed &&
			!row.expired &&
			challengeMatches(row.challenge, challenge);

		const client = await this.pool.connect();
		let discard = false;
		let committing = false;
		try {
			await client.query("begin");
			const observed = await grant(client, grantId, false);
			if (!usable(observed)) {
				await client.query("rollback");
				return { kind: "invalid" };
			}
			// Only a verifier holder learns that approval is still outstanding.
			if (observed.approved_user_id === null) {
				await client.query("rollback");
				return { kind: "pending" };
			}
			const userId = observed.approved_user_id;
			if (!(await lockUser(client, userId))) {
				await client.query("rollback");
				return { kind: "invalid" };
			}
			const locked = await grant(client, grantId, true);
			if (
				!usable(locked) ||
				locked.approved_user_id !== userId ||
				locked.approved_session_id === null ||
				!(await lockSession(client, locked.approved_session_id, userId))
			) {
				await client.query("rollback");
				return { kind: "invalid" };
			}
			const consumed = await client.query<{ expires_at: Date }>(
				`update native_auth_grant set consumed_at = now()
				where id = $1 and consumed_at is null returning expires_at`,
				[grantId],
			);
			if (consumed.rowCount !== 1) throw new Error("Grant was not consumed");
			committing = true;
			await client.query("commit");
			return {
				kind: "claimed",
				userId,
				approverSession: locked.approved_session_id,
				deviceLabel: locked.device_label,
				expiresAt: consumed.rows[0].expires_at,
			};
		} catch (error) {
			discard = committing;
			try {
				await client.query("rollback");
			} catch {
				discard = true;
			}
			if (!committing && lockBusy(error)) return { kind: "busy" };
			throw error;
		} finally {
			client.release(discard || undefined);
		}
	}

	// Links the minted session to a new device. Any failure or invalid outcome
	// deletes the session before the result is reported.
	private async bind(
		claim: Claim,
		created: SessionHandle,
	): Promise<ExchangeResult> {
		let result: ExchangeResult | undefined;
		let failure: { error: unknown } | undefined;
		if (created.userId !== claim.userId) {
			failure = { error: new Error("Session user mismatch") };
		} else {
			try {
				result = await this.bindInTransaction(claim, created);
			} catch (error) {
				failure = { error };
			}
		}
		if (result?.kind === "ok") return result;
		let cleanupFailed = false;
		try {
			await this.sessions.deleteSession(created.token);
		} catch {
			cleanupFailed = true;
		}
		if (cleanupFailed) throw new NativeExchangeError(true, failure?.error);
		if (failure) {
			// The grant is already consumed, so a busy lock means start over.
			if (lockBusy(failure.error)) return { kind: "invalid" };
			throw failure.error;
		}
		return { kind: "invalid" };
	}

	private async bindInTransaction(
		claim: Claim,
		created: SessionHandle,
	): Promise<ExchangeResult> {
		const { userId } = claim;
		const client = await this.pool.connect();
		let discard = false;
		let committing = false;
		try {
			await client.query("begin");
			const live = await client.query<{ live: boolean }>(
				"select $1::timestamptz > statement_timestamp() as live",
				[claim.expiresAt],
			);
			if (
				!live.rows[0].live ||
				!(await lockUser(client, userId)) ||
				!(await lockSession(client, claim.approverSession, userId))
			) {
				await client.query("rollback");
				return { kind: "invalid" };
			}
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			const deviceId = randomUUID();
			await client.query(
				"insert into user_device (id, user_id, label) values ($1, $2, $3)",
				[deviceId, userId, claim.deviceLabel],
			);
			await client.query(
				"insert into native_session_link (session_id, user_id, device_id) values ($1, $2, $3)",
				[created.id, userId, deviceId],
			);
			committing = true;
			await client.query("commit");
			return {
				kind: "ok",
				token: created.token,
				sessionId: created.id,
				userId,
				deviceId,
				expiresAt: created.expiresAt,
			};
		} catch (error) {
			discard = committing;
			try {
				await client.query("rollback");
			} catch {
				discard = true;
			}
			throw error;
		} finally {
			client.release(discard || undefined);
		}
	}
}
