import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { maxQueuedPerUser } from "../../config/worker.ts";
import type * as tables from "../../db/schema.ts";
import { enqueueOutbox } from "../notifications/outbox.ts";
import {
	DEFAULT_PREF,
	decideQuietHours,
	loadChannels,
	loadPrefs,
} from "../notifications/recipients.ts";
import { activeRecipientKeyGuard } from "./identity-rotation.ts";

export type PendingGrant = {
	requestId: string;
	workspaceId: string;
	keyVersion: number;
	recipientUserId: string;
	// Null when the recipient has not enrolled. The request is still listed
	// (design 8.3, first case): a granter must be able to see that someone is
	// waiting on THEM to enroll, named as unenrolled rather than as pending.
	recipientPublicKey: string | null;
	requestedAt: string;
};

export type OwnWorkspaceKey = {
	membershipKeyId: string;
	workspaceId: string;
	keyVersion: number;
	enc: string;
	ciphertext: string;
	recipientPublicKey: string;
	commitment: string;
	active: boolean;
	requestId: string | null;
};

/**
 * Every WDK wrap addressed to the caller's current or retained identity.
 *
 * This is an explicit server read rather than a Zero query: key tables are
 * deliberately absent from the synced schema, and the client only requests
 * ciphertext after its in-memory private key is ready to open it. Retired
 * workspace versions stay listed because old attachments remain encrypted to
 * the version that created them.
 */
export async function myWorkspaceKeys(
	client: PoolClient,
	userId: string,
): Promise<OwnWorkspaceKey[]> {
	const rows = await client.query<{
		id: string;
		workspace_id: string;
		key_version: number;
		enc: string;
		ciphertext: string;
		recipient_public_key: string;
		commitment: string;
		active: boolean;
		request_id: string | null;
	}>(
		`select mk.id, mk.workspace_id, mk.key_version, mk.enc, mk.ciphertext,
		        mk.recipient_public_key, wk.commitment, wk.active,
		        (select r.id from key_grant_request r
		         where r.membership_id = mk.membership_id
		           and r.requested_version = mk.key_version
		         order by r.requested_at desc, r.id desc limit 1) as request_id
		 from membership_key mk
		 join workspace_key wk
		   on wk.workspace_id = mk.workspace_id and wk.version = mk.key_version
		 where mk.user_id = $1
		 order by mk.workspace_id, mk.key_version`,
		[userId],
	);
	return rows.rows.map((row) => ({
		membershipKeyId: row.id,
		workspaceId: row.workspace_id,
		keyVersion: row.key_version,
		enc: row.enc,
		ciphertext: row.ciphertext,
		recipientPublicKey: row.recipient_public_key,
		commitment: row.commitment,
		active: row.active,
		requestId: row.request_id,
	}));
}

/**
 * Requests this caller could actually fulfil.
 *
 * "Could fulfil" is the join, not a role check: a granter needs the WDK, and
 * the only evidence they hold it is their own `membership_key` row for that
 * version. A member who is not themselves ready has nothing to wrap, so their
 * attempt would be a bug rather than a permission problem, and listing the
 * request for them would invite one.
 */
export async function pendingGrants(
	client: PoolClient,
	granterId: string,
): Promise<PendingGrant[]> {
	const rows = await client.query<{
		id: string;
		workspace_id: string;
		requested_version: number;
		user_id: string;
		public_key: string | null;
		requested_at: Date;
	}>(
		`select r.id, r.workspace_id, r.requested_version, r.user_id,
		        uk.public_key, r.requested_at
		 from key_grant_request r
		 join membership gm
		   on gm.workspace_id = r.workspace_id and gm.user_id = $1
		 join membership_key gk
		   on gk.membership_id = gm.id and gk.key_version = r.requested_version
		 join workspace_key wk
		   on wk.workspace_id = r.workspace_id
		  and wk.version = r.requested_version and wk.active
		 left join user_key uk
		   on uk.user_id = r.user_id and uk.retired_at is null
		  and uk.state = 'ready'
		 where r.state = 'key_pending'
		 order by r.requested_at, r.id`,
		[granterId],
	);
	return rows.rows.map((row) => ({
		requestId: row.id,
		workspaceId: row.workspace_id,
		keyVersion: row.requested_version,
		recipientUserId: row.user_id,
		recipientPublicKey: row.public_key,
		requestedAt: row.requested_at.toISOString(),
	}));
}

export type MyGrantState = "pending" | "unrecoverable" | "failed" | "ready";

export type MyGrant = {
	requestId: string;
	workspaceId: string;
	keyVersion: number;
	state: MyGrantState;
	failureReason: string | null;
};

export async function requestWorkspaceKey(
	client: PoolClient,
	userId: string,
	workspaceId: string,
): Promise<{
	requestId: string;
	keyVersion: number;
	state: "pending" | "ready";
} | null> {
	await client.query(
		`insert into key_grant_request (id, membership_id, user_id, workspace_id,
		 requested_version)
		 select $1, m.id, $2, $3, wk.version
		 from membership m
		 join workspace_key wk on wk.workspace_id = $3 and wk.active
		 where m.workspace_id = $3 and m.user_id = $2
		   and not exists (
			select 1 from membership_key mk
			where mk.membership_id = m.id and mk.key_version = wk.version)
		 on conflict do nothing`,
		[`kgr_${crypto.randomUUID()}`, userId, workspaceId],
	);
	const found = await client.query<{
		id: string;
		requested_version: number;
		state: "key_pending" | "ready";
	}>(
		`select r.id, r.requested_version, r.state
		 from key_grant_request r
		 join workspace_key wk
		   on wk.workspace_id = r.workspace_id
		  and wk.version = r.requested_version and wk.active
		 where r.user_id = $1 and r.workspace_id = $2
		   and r.state in ('key_pending', 'ready')
		 order by r.requested_at desc, r.id desc limit 1`,
		[userId, workspaceId],
	);
	const row = found.rows[0];
	return row
		? {
				requestId: row.id,
				keyVersion: row.requested_version,
				state: row.state === "key_pending" ? "pending" : "ready",
			}
		: null;
}

/**
 * The recipient's own view of what they are waiting for.
 *
 * `unrecoverable` is DERIVED here rather than written by a hook on member
 * removal (design 8.3, second case). A hook would have to fire from a Zero
 * mutator, which cannot reach this table at all, and any state it did write
 * would go stale the moment someone re-enrolled. Derived, the answer is always
 * current and there is no path that leaves a spinner running forever: a request
 * whose workspace has no living key holder says so.
 */
export async function myGrants(
	client: PoolClient,
	userId: string,
): Promise<MyGrant[]> {
	const rows = await client.query<{
		id: string;
		workspace_id: string;
		requested_version: number;
		state: string;
		failure_reason: string | null;
		holders: string;
	}>(
		`select r.id, r.workspace_id, r.requested_version, r.state,
		        r.failure_reason,
		        (select count(*) from membership_key mk
		         join membership m on m.id = mk.membership_id
		         join user_key uk on uk.user_id = m.user_id
		          and uk.retired_at is null and uk.state = 'ready'
		         where mk.workspace_id = r.workspace_id
		           and mk.key_version = r.requested_version) as holders
		 from key_grant_request r
		 where r.user_id = $1
		 order by r.requested_at, r.id`,
		[userId],
	);
	return rows.rows.map((row) => ({
		requestId: row.id,
		workspaceId: row.workspace_id,
		keyVersion: row.requested_version,
		// key_pending is the column's name for it; the API says "pending", and
		// the translation lives here so no caller has to know both.
		state:
			row.state !== "key_pending"
				? (row.state as MyGrantState)
				: Number(row.holders) === 0
					? "unrecoverable"
					: "pending",
		failureReason: row.failure_reason,
	}));
}

export type GrantInput = {
	requestId: string;
	recipientPublicKey: string;
	enc: string;
	ciphertext: string;
};

export type GrantFailure =
	| "no-request"
	| "not-ready"
	| "inactive-version"
	| "stale recipient key"
	| "conflict";

export type GrantResult =
	| { ok: true; requestId: string; outcome: "granted" | "already" }
	| { ok: false; reason: GrantFailure };

/**
 * Fulfils one pending request: writes the recipient's `membership_key` and
 * moves the request to `ready`.
 *
 * The server cannot check that the ciphertext holds the right WDK -- it is
 * opaque, and HPKE base mode carries no sender authentication. That check is
 * the RECIPIENT's, against the workspace commitment (design 4.4), which is why
 * a substituted key is caught by `markGrantFailed` and not here.
 */
export async function submitGrant(
	client: PoolClient,
	granterId: string,
	input: GrantInput,
): Promise<GrantResult> {
	// The caller's membership is part of the lookup, not a check after it, so a
	// request the caller cannot fulfil is indistinguishable from one that does
	// not exist. Split into a find-then-forbid, this endpoint would enumerate
	// every other workspace's pending grants by status code.
	//
	// `ready` is accepted alongside `key_pending`: a granter whose response was
	// lost re-submits, and refusing that as "no such request" would report a
	// completed grant as a missing one. What that retry may do is bounded by
	// the identical-wrap comparison below.
	const found = await client.query<{
		membership_id: string;
		workspace_id: string;
		requested_version: number;
		user_id: string;
		granter_membership_id: string;
	}>(
		`select r.membership_id, r.workspace_id, r.requested_version, r.user_id,
		        gm.id as granter_membership_id
		 from key_grant_request r
		 join membership gm
		   on gm.workspace_id = r.workspace_id and gm.user_id = $2
		 where r.id = $1 and r.state in ('key_pending', 'ready')`,
		[input.requestId, granterId],
	);
	const request = found.rows[0];
	if (!request) return { ok: false, reason: "no-request" };

	// The granter's own wrap for this version IS the evidence they hold the WDK.
	// No role check: Owner and Admin mint versions, but any ready member can
	// pass on a key they already have, and a member who cannot open it has
	// nothing to wrap.
	const holds = await client.query(
		"select 1 from membership_key where membership_id = $1 and key_version = $2",
		[request.granter_membership_id, request.requested_version],
	);
	if (holds.rowCount !== 1) return { ok: false, reason: "not-ready" };

	const active = await client.query(
		`select 1 from workspace_key
		 where workspace_id = $1 and version = $2 and active`,
		[request.workspace_id, request.requested_version],
	);
	if (active.rowCount !== 1) return { ok: false, reason: "inactive-version" };

	const existing = await client.query<{ enc: string; ciphertext: string }>(
		"select enc, ciphertext from membership_key where membership_id = $1 and key_version = $2",
		[request.membership_id, request.requested_version],
	);
	const already = existing.rows[0];
	if (already) {
		// Re-submitting the identical wrap is a retry and must not be an error --
		// a granter whose response was lost has done nothing wrong. A DIFFERENT
		// wrap for the same slot is the fork: two members would hold two keys
		// under one version, so it is refused rather than allowed to overwrite.
		if (already.enc !== input.enc || already.ciphertext !== input.ciphertext) {
			return { ok: false, reason: "conflict" };
		}
		await markReady(client, input.requestId);
		return { ok: true, requestId: input.requestId, outcome: "already" };
	}

	// The recipient-key check rides INSIDE the write. A read-then-insert has
	// already decided by the time it inserts, so an identity rotation
	// committing in between delivers a wrap addressed to a key the recipient
	// has just revoked -- a row nobody can open and nothing later notices.
	const written = await client.query(
		`insert into membership_key (id, membership_id, user_id, workspace_id,
		 key_version, enc, ciphertext, recipient_public_key, granted_by)
		 select $1, $2, $3, $4, $5, $6, $7, $8, $9
		 where ${activeRecipientKeyGuard(3, 8)}`,
		[
			`mk_${crypto.randomUUID()}`,
			request.membership_id,
			request.user_id,
			request.workspace_id,
			request.requested_version,
			input.enc,
			input.ciphertext,
			input.recipientPublicKey,
			granterId,
		],
	);
	// The request stays key_pending, deliberately (design 8.3, fourth case): a
	// fresh grant to the recipient's new key will succeed, so this is a retry
	// condition and not a failure to record.
	if (written.rowCount !== 1) {
		return { ok: false, reason: "stale recipient key" };
	}

	await markReady(client, input.requestId);
	return { ok: true, requestId: input.requestId, outcome: "granted" };
}

async function markReady(client: PoolClient, requestId: string): Promise<void> {
	await client.query(
		`update key_grant_request set state = 'ready', granted_at = now()
		 where id = $1 and state = 'key_pending'`,
		[requestId],
	);
}

/**
 * The recipient's refusal. Called when the unwrapped WDK fails the workspace
 * commitment, which is a check only the recipient can make.
 *
 * Scoped to the caller's own row: a granter marking their own delivery failed
 * would let a buggy or hostile client bury the evidence of a substitution.
 */
export async function markGrantFailed(
	client: PoolClient,
	recipientId: string,
	requestId: string,
	reason: string,
): Promise<boolean> {
	const updated = await client.query(
		`update key_grant_request
		 set state = 'failed', failure_reason = $3
		 where id = $1 and user_id = $2 and state in ('key_pending', 'ready')`,
		[requestId, recipientId, reason],
	);
	return updated.rowCount === 1;
}

/**
 * Tells everyone who could clear this request that it exists.
 *
 * Design 8.1: the wait should end when a grant-capable member next opens a
 * client, not when one happens to look. Recipients are the members who hold
 * this version AND have a live identity -- holding the wrap is the only
 * evidence they can open the WDK, and an enrolled member without it has nothing
 * to pass on.
 *
 * The payload carries a workspace NAME and nothing else. No wrap, no
 * commitment, no public key: this row is rendered by five channel adapters and
 * ends up in ntfy servers, Telegram, Discord, Slack and mail spools.
 */
export async function notifyGrantCapable(
	database: NodePgDatabase<typeof tables>,
	requestId: string,
	now: Date = new Date(),
): Promise<number> {
	const found = await database.execute<{
		workspace_id: string;
		workspace_name: string;
		requested_version: number;
		recipient: string;
	}>(sql`
		select r.workspace_id, w.name as workspace_name, r.requested_version,
		       m.user_id as recipient
		from key_grant_request r
		join workspace w on w.id = r.workspace_id
		join membership_key mk
		  on mk.workspace_id = r.workspace_id
		 and mk.key_version = r.requested_version
		join membership m on m.id = mk.membership_id
		join user_key uk
		  on uk.user_id = m.user_id and uk.retired_at is null
		 and uk.state = 'ready'
		where r.id = ${requestId} and r.state = 'key_pending'
		  -- Unreachable today and kept anyway: a request only exists because the
		  -- member held no wrap for that version, and it leaves key_pending the
		  -- moment they get one. It stops being unreachable as soon as a second
		  -- path writes a membership_key without clearing the request -- the
		  -- invite fast path is exactly that shape -- and the failure it
		  -- prevents is telling someone they are waiting on themselves.
		  and m.user_id <> r.user_id`);
	const rows = found.rows ?? [];
	if (rows.length === 0) return 0;

	const recipients = [...new Set(rows.map((row) => row.recipient))];
	const prefs = await loadPrefs(database, recipients);
	const channels = await loadChannels(database, recipients);
	const cap = {
		maxQueuedPerUser: maxQueuedPerUser(process.env),
		refusedLogged: new Set<string>(),
	};

	let enqueued = 0;
	for (const row of rows) {
		const userChannels = channels.get(row.recipient) ?? [];
		const pref = prefs.get(row.recipient) ?? DEFAULT_PREF;
		const decision = decideQuietHours(pref, false, now, row.recipient);
		for (const channelKind of userChannels) {
			const outcome = await enqueueOutbox(
				database,
				{
					// No reminder_state row, like every other event notification:
					// nothing escalates this and dispatch mints no ack capability.
					reminderStateId: null,
					recipientUserId: row.recipient,
					channelKind,
					payload: {
						kind: "key_grant",
						workspaceName: row.workspace_name,
						locale: pref.locale,
					},
					// Keyed by the request, so re-running this after a retry does not
					// notify the same member twice for the same wait.
					idempotencyKey: `key_grant:${requestId}:${row.recipient}:${channelKind}`,
					nextAttemptAt: decision.kind === "defer" ? decision.until : now,
				},
				cap,
			);
			if (outcome === "inserted") enqueued++;
		}
	}
	return enqueued;
}
