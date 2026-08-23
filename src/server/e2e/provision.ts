import type { PoolClient } from "pg";

// Design 4.2: only Owner and Admin may mint a workspace key version. A Member
// holding the WDK is a recipient, not a minter, and a Viewer is neither.
const MINT_ROLES = new Set(["owner", "admin"]);

export type ProvisionInput = {
	workspaceId: string;
	commitment: string;
	enc: string;
	ciphertext: string;
};

export type ProvisionFailure = "not-permitted" | "not-enrolled";

export type ProvisionOutcome = "minted" | "already" | "repaired" | "exists";

export type ProvisionResult =
	| {
			ok: true;
			workspaceId: string;
			version: number;
			outcome: ProvisionOutcome;
	  }
	| { ok: false; reason: ProvisionFailure };

/** The only version provisioning ever writes. Later versions come from removal. */
const FIRST_VERSION = 1;

export type PendingWorkspace = {
	id: string;
	version: number;
	reason: "no-key" | "no-grant";
	commitment: string | null;
};

/**
 * Every workspace the caller may mint for that is not yet fully provisioned.
 *
 * Listed rather than derived one workspace at a time because an account that
 * predates E2E owns several, and provisioning the one in front of the user
 * leaves the rest permanently keyless -- a state nothing notices until a file
 * will not encrypt, long after the enrollment that was supposed to set it up.
 *
 * Workspaces the caller may not mint for are omitted rather than listed and
 * refused: a list the server hands out should not end in a 403 it could have
 * predicted.
 */
export async function pendingProvisions(
	client: PoolClient,
	userId: string,
): Promise<PendingWorkspace[]> {
	const rows = await client.query<{
		id: string;
		version: number | null;
		commitment: string | null;
	}>(
		`select w.id,
		        wk.version,
		        wk.commitment
		 from workspace w
		 join membership m on m.workspace_id = w.id and m.user_id = $1
		 left join workspace_key wk
		   on wk.workspace_id = w.id and wk.version = $2 and wk.active
		 left join membership_key mk
		   on mk.membership_id = m.id and mk.key_version = $2
		 where m.role = any($3)
		   and (wk.id is null or mk.id is null)
		 order by w.id`,
		[userId, FIRST_VERSION, [...MINT_ROLES]],
	);
	return rows.rows.map((row) => ({
		id: row.id,
		version: FIRST_VERSION,
		// The two reasons demand different client behaviour and must not be
		// collapsed: no-key means mint a fresh WDK, no-grant means resubmit the
		// commitment already published. A client that minted on no-grant would
		// fork the workspace.
		reason: row.version === null ? "no-key" : "no-grant",
		commitment: row.commitment,
	}));
}

/**
 * Mints workspace_key v1 and the caller's own grant, or repairs whichever half
 * is missing. Idempotent, and safe to race.
 *
 * The WDK never reaches here. The server sees a commitment (design 4.4) and an
 * opaque HPKE wrap, so the only fork it can prevent is the structural one: two
 * v1 rows. The unique constraint on (workspace_id, version) is the arbiter, and
 * the loser is told it lost rather than handed an error, because a client that
 * treats a lost race as fatal strands a workspace that is in fact fine.
 */
export async function provisionWorkspace(
	client: PoolClient,
	userId: string,
	input: ProvisionInput,
): Promise<ProvisionResult> {
	const membership = await client.query<{ id: string; role: string }>(
		"select id, role from membership where workspace_id = $1 and user_id = $2",
		[input.workspaceId, userId],
	);
	const seat = membership.rows[0];
	// One answer for "not a member" and "wrong role": telling a stranger which
	// of the two they are confirms the workspace exists.
	if (!seat || !MINT_ROLES.has(seat.role)) {
		return { ok: false, reason: "not-permitted" };
	}

	const identity = await client.query<{ public_key: string }>(
		`select public_key from user_key
		 where user_id = $1 and state = 'ready' and retired_at is null`,
		[userId],
	);
	const publicKey = identity.rows[0]?.public_key;
	// membership_key records the key its wrap is addressed to, and taking the
	// caller's word for that would let a grant name a key the recipient never
	// enrolled -- which the stale-key guard would then read as current.
	if (!publicKey) return { ok: false, reason: "not-enrolled" };

	const minted = await client.query(
		`insert into workspace_key (id, workspace_id, version, commitment, minted_by)
		 values ($1, $2, $3, $4, $5)
		 on conflict (workspace_id, version) do nothing`,
		[
			`wk_${crypto.randomUUID()}`,
			input.workspaceId,
			FIRST_VERSION,
			input.commitment,
			userId,
		],
	);

	const stored = await client.query<{ commitment: string }>(
		"select commitment from workspace_key where workspace_id = $1 and version = $2",
		[input.workspaceId, FIRST_VERSION],
	);
	const commitment = stored.rows[0]?.commitment;
	if (!commitment) return { ok: false, reason: "not-permitted" };

	// The caller's ciphertext wraps the WDK its own commitment pins. If the
	// stored commitment is someone else's, that ciphertext opens to a DIFFERENT
	// key, and writing it as this member's grant would leave the row pinned by
	// one key and openable to another -- the fork, reached by a retry instead of
	// a race. The client asks for a grant instead (Task 15).
	if (commitment !== input.commitment) {
		return {
			ok: true,
			workspaceId: input.workspaceId,
			version: FIRST_VERSION,
			outcome: "exists",
		};
	}

	const granted = await client.query(
		`insert into membership_key (id, membership_id, user_id, workspace_id,
		 key_version, enc, ciphertext, recipient_public_key, granted_by)
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $3)
		 on conflict (membership_id, key_version) do nothing`,
		[
			`mk_${crypto.randomUUID()}`,
			seat.id,
			userId,
			input.workspaceId,
			FIRST_VERSION,
			input.enc,
			input.ciphertext,
			publicKey,
		],
	);

	// Four outcomes from two booleans, and the client acts differently on each:
	// "repaired" in particular means the previous attempt committed the key row
	// and lost the grant, which is the state pendingProvisions reports as
	// no-grant.
	const outcome: ProvisionOutcome =
		minted.rowCount === 1
			? "minted"
			: granted.rowCount === 1
				? "repaired"
				: "already";
	return {
		ok: true,
		workspaceId: input.workspaceId,
		version: FIRST_VERSION,
		outcome,
	};
}
