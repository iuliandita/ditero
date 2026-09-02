import type { PoolClient } from "pg";

const MINT_ROLES = new Set(["owner", "admin"]);

export type RotationGrant = {
	membershipId: string;
	userId: string;
	recipientPublicKey: string;
	enc: string;
	ciphertext: string;
};

export type WorkspaceRotationInput = {
	previousVersion: number;
	commitment: string;
	grants: RotationGrant[];
};

export type RotationMember = {
	membershipId: string;
	userId: string;
	name: string;
	role: string;
	recipientPublicKey: string | null;
};

export type WorkspaceRotationPlan = {
	workspaceId: string;
	currentVersion: number | null;
	currentCommitment: string | null;
	rotationRequired: boolean;
	canRotate: boolean;
	members: RotationMember[];
};

export type WorkspaceRotationFailure =
	| "not-found"
	| "not-permitted"
	| "not-enrolled"
	| "not-required"
	| "no-active-key"
	| "stale-version"
	| "incomplete-grants"
	| "stale-recipient-key";

export type WorkspaceRotationResult =
	| {
			ok: true;
			workspaceId: string;
			version: number;
			commitment: string;
			outcome: "rotated" | "already";
	  }
	| { ok: false; reason: WorkspaceRotationFailure };

type WorkspaceSeat = {
	rotation_required: boolean;
	role: string;
};

type ActiveKey = { version: number; commitment: string };

async function membersFor(
	client: PoolClient,
	workspaceId: string,
): Promise<RotationMember[]> {
	const rows = await client.query<{
		membership_id: string;
		user_id: string;
		name: string;
		role: string;
		public_key: string | null;
	}>(
		`select m.id as membership_id, m.user_id, u.name, m.role,
		        uk.public_key
		 from membership m
		 join "user" u on u.id = m.user_id
		 left join user_key uk on uk.user_id = m.user_id
		  and uk.state = 'ready' and uk.retired_at is null
		 where m.workspace_id = $1
		 order by m.id`,
		[workspaceId],
	);
	return rows.rows.map((row) => ({
		membershipId: row.membership_id,
		userId: row.user_id,
		name: row.name,
		role: row.role,
		recipientPublicKey: row.public_key,
	}));
}

async function activeKeyFor(
	client: PoolClient,
	workspaceId: string,
): Promise<ActiveKey | null> {
	const rows = await client.query<ActiveKey>(
		`select version, commitment from workspace_key
		 where workspace_id = $1 and active
		 order by version desc limit 2`,
		[workspaceId],
	);
	if (rows.rows.length > 1) {
		throw new Error("workspace rotation: multiple active key versions");
	}
	return rows.rows[0] ?? null;
}

async function lockRecipientIdentities(
	client: PoolClient,
	workspaceId: string,
): Promise<void> {
	await client.query(
		`select uk.id from user_key uk
		 join membership m on m.user_id = uk.user_id
		 where m.workspace_id = $1
		   and uk.state = 'ready' and uk.retired_at is null
		 for share of uk`,
		[workspaceId],
	);
}

export async function workspaceRotationPlan(
	client: PoolClient,
	userId: string,
	workspaceId: string,
): Promise<WorkspaceRotationPlan | null> {
	const seats = await client.query<WorkspaceSeat>(
		`select w.rotation_required, m.role
		 from workspace w
		 join membership m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1`,
		[workspaceId, userId],
	);
	const seat = seats.rows[0];
	if (!seat) return null;
	const active = await activeKeyFor(client, workspaceId);
	return {
		workspaceId,
		currentVersion: active?.version ?? null,
		currentCommitment: active?.commitment ?? null,
		rotationRequired: seat.rotation_required,
		canRotate: MINT_ROLES.has(seat.role),
		members: await membersFor(client, workspaceId),
	};
}

function validateGrantSet(
	members: RotationMember[],
	grants: RotationGrant[],
): WorkspaceRotationFailure | null {
	const enrolled = members.filter(
		(member) => member.recipientPublicKey !== null,
	);
	const submitted = new Map(
		grants.map((grant) => [grant.membershipId, grant] as const),
	);
	if (submitted.size !== grants.length || submitted.size !== enrolled.length) {
		return "incomplete-grants";
	}
	for (const member of enrolled) {
		const grant = submitted.get(member.membershipId);
		if (!grant) return "incomplete-grants";
		if (
			grant.userId !== member.userId ||
			grant.recipientPublicKey !== member.recipientPublicKey
		) {
			return "stale-recipient-key";
		}
	}
	return null;
}

/**
 * Mint and distribute the next WDK version after a membership removal.
 *
 * The workspace row is the transaction mutex. A second caller waits there,
 * then observes the committed next version and receives `already` instead of
 * trying to publish wraps for its losing WDK candidate.
 */
export async function rotateWorkspace(
	client: PoolClient,
	userId: string,
	workspaceId: string,
	input: WorkspaceRotationInput,
): Promise<WorkspaceRotationResult> {
	const seats = await client.query<WorkspaceSeat>(
		`select w.rotation_required, m.role
		 from workspace w
		 join membership m on m.workspace_id = w.id and m.user_id = $2
		 where w.id = $1
		 for update of w, m`,
		[workspaceId, userId],
	);
	const seat = seats.rows[0];
	if (!seat) return { ok: false, reason: "not-found" };
	if (!MINT_ROLES.has(seat.role)) {
		return { ok: false, reason: "not-permitted" };
	}

	const active = await activeKeyFor(client, workspaceId);
	if (!seat.rotation_required) {
		if (active && active.version > input.previousVersion) {
			return {
				ok: true,
				workspaceId,
				version: active.version,
				commitment: active.commitment,
				outcome: "already",
			};
		}
		return { ok: false, reason: "not-required" };
	}
	if (!active) return { ok: false, reason: "no-active-key" };
	if (active.version !== input.previousVersion) {
		return { ok: false, reason: "stale-version" };
	}

	// An identity rotation that starts after these wraps are written cannot see
	// their uncommitted rows to rewrap them. Hold each recipient identity stable
	// through commit; the identity rotation then runs second and includes v(n+1).
	await lockRecipientIdentities(client, workspaceId);
	const members = await membersFor(client, workspaceId);
	const caller = members.find((member) => member.userId === userId);
	if (!caller?.recipientPublicKey) {
		return { ok: false, reason: "not-enrolled" };
	}
	const invalid = validateGrantSet(members, input.grants);
	if (invalid) return { ok: false, reason: invalid };

	const nextVersion = active.version + 1;
	const minted = await client.query(
		`insert into workspace_key
		 (id, workspace_id, version, commitment, minted_by)
		 values ($1, $2, $3, $4, $5)
		 on conflict (workspace_id, version) do nothing`,
		[
			`wk_${crypto.randomUUID()}`,
			workspaceId,
			nextVersion,
			input.commitment,
			userId,
		],
	);
	if (minted.rowCount !== 1) {
		throw new Error("workspace rotation: next key version already exists");
	}

	for (const grant of input.grants) {
		const inserted = await client.query(
			`insert into membership_key
			 (id, membership_id, user_id, workspace_id, key_version, enc,
			  ciphertext, recipient_public_key, granted_by)
			 select $1, m.id, m.user_id, m.workspace_id, $2, $3, $4,
			        uk.public_key, $5
			 from membership m
			 join user_key uk on uk.user_id = m.user_id
			  and uk.state = 'ready' and uk.retired_at is null
			 where m.id = $6 and m.user_id = $7 and m.workspace_id = $8
			   and uk.public_key = $9`,
			[
				`mk_${crypto.randomUUID()}`,
				nextVersion,
				grant.enc,
				grant.ciphertext,
				userId,
				grant.membershipId,
				grant.userId,
				workspaceId,
				grant.recipientPublicKey,
			],
		);
		if (inserted.rowCount !== 1) {
			throw new Error("workspace rotation: recipient key changed during write");
		}
	}

	await client.query(
		`update key_grant_request set state = 'revoked'
		 where workspace_id = $1 and state = 'key_pending'`,
		[workspaceId],
	);
	for (const member of members) {
		if (member.recipientPublicKey !== null) continue;
		const inserted = await client.query(
			`insert into key_grant_request
			 (id, membership_id, user_id, workspace_id, requested_version, state)
			 values ($1, $2, $3, $4, $5, 'key_pending')`,
			[
				`kgr_${crypto.randomUUID()}`,
				member.membershipId,
				member.userId,
				workspaceId,
				nextVersion,
			],
		);
		if (inserted.rowCount !== 1) {
			throw new Error("workspace rotation: pending grant was not created");
		}
	}

	const retired = await client.query(
		`update workspace_key set active = false, retired_at = now()
		 where workspace_id = $1 and version = $2 and active`,
		[workspaceId, active.version],
	);
	if (retired.rowCount !== 1) {
		throw new Error("workspace rotation: active key changed during write");
	}
	const cleared = await client.query(
		`update workspace set rotation_required = false
		 where id = $1 and rotation_required`,
		[workspaceId],
	);
	if (cleared.rowCount !== 1) {
		throw new Error("workspace rotation: required flag changed during write");
	}

	return {
		ok: true,
		workspaceId,
		version: nextVersion,
		commitment: input.commitment,
		outcome: "rotated",
	};
}
