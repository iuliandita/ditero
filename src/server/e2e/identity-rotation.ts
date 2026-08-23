import type { PoolClient } from "pg";

/**
 * SQL predicate: the recipient's CURRENT identity is `$publicKeyParam`.
 *
 * Returned as a fragment rather than run as its own query because a grant must
 * carry this check INSIDE its write. A read-then-insert has already decided by
 * the time it inserts, so a rotation committing in between delivers a wrap
 * addressed to a key the recipient has just revoked -- an orphan row nobody can
 * open and nothing later notices. Task 15's grant endpoint is the consumer;
 * the fragment ships with rotation because rotation is what makes a key stale.
 */
export function activeRecipientKeyGuard(
	userIdParam: number,
	publicKeyParam: number,
): string {
	return `exists (
		select 1 from user_key uk
		where uk.user_id = $${userIdParam}
		  and uk.public_key = $${publicKeyParam}
		  and uk.retired_at is null
		  and uk.state = 'ready')`;
}

export type Rewrap = {
	membershipKeyId: string;
	enc: string;
	ciphertext: string;
};

export type RotationInput = {
	publicKey: string;
	previousPublicKey: string;
	passphraseWrapped: string;
	recoveryWrapped: string;
	passphraseSalt: string;
	recoverySalt: string;
	formatVersion: number;
	rewraps: Rewrap[];
};

export type RotationFailure =
	| "not-enrolled"
	| "stale-previous-key"
	| "unchanged-key"
	| "incomplete-rewraps";

export type RotationResult =
	| { ok: true; publicKey: string; rewrapped: number }
	| { ok: false; reason: RotationFailure };

/**
 * Design 12. Retires the caller's identity, installs a fresh one, and moves
 * every WDK wrap they hold onto it -- all inside the caller's transaction, so a
 * failure anywhere leaves the old identity intact and still usable.
 *
 * The server cannot verify that a submitted rewrap opens to anything: the enc
 * and ciphertext are opaque to it. What it CAN enforce is that the set is
 * complete, and that is the check worth having, because the failure mode of a
 * partial rotation is silent -- the skipped versions stay addressed to a key
 * the user has just been told is dead, and nobody finds out until someone opens
 * an old file.
 */
export async function rotateIdentity(
	client: PoolClient,
	userId: string,
	input: RotationInput,
): Promise<RotationResult> {
	const current = await client.query<{ id: string; public_key: string }>(
		`select id, public_key from user_key
		 where user_id = $1 and state = 'ready' and retired_at is null`,
		[userId],
	);
	const active = current.rows[0];
	if (!active) return { ok: false, reason: "not-enrolled" };
	if (active.public_key !== input.previousPublicKey) {
		return { ok: false, reason: "stale-previous-key" };
	}
	// Rotating to the same key would report a successful revocation while
	// leaving the compromised key live. Every other failure here is honest
	// about having changed nothing; this one would not be.
	if (input.publicKey === input.previousPublicKey) {
		return { ok: false, reason: "unchanged-key" };
	}

	const held = await client.query<{ id: string }>(
		// user_id explicitly, not left to RLS: the policy is defence in depth and
		// a role with BYPASSRLS -- which every test database connection is --
		// would turn this into a read of every user's wraps.
		"select id from membership_key where user_id = $1",
		[userId],
	);
	const heldIds = new Set(held.rows.map((row) => row.id));
	const submitted = new Set(input.rewraps.map((r) => r.membershipKeyId));
	// Set equality both ways. Missing ids are the silent-loss case above;
	// EXTRA ids mean the client is rewrapping something it does not hold, which
	// is a diverged view rather than a harmless surplus, and either way this
	// rotation was computed against a set that no longer describes reality.
	const complete =
		submitted.size === input.rewraps.length &&
		submitted.size === heldIds.size &&
		[...heldIds].every((id) => submitted.has(id));
	if (!complete) return { ok: false, reason: "incomplete-rewraps" };

	// Retire before inserting: user_key_active is unique on user_id where
	// retired_at is null, so the two rows cannot both be live even momentarily.
	const retired = await client.query(
		"update user_key set retired_at = now(), updated_at = now() where id = $1 and retired_at is null",
		[active.id],
	);
	if (retired.rowCount !== 1)
		return { ok: false, reason: "stale-previous-key" };

	// Both halves in one statement. A new identity whose secret half never
	// landed is unrecoverable: its public key is immutable, no wrap opens it,
	// and the old identity has already been retired.
	await client.query(
		`with identity as (
		 insert into user_key (id, user_id, public_key, state)
		 values ($1, $2, $3, 'ready')
		 returning id, user_id)
		 insert into user_key_secret (user_key_id, user_id, passphrase_wrapped,
		 recovery_wrapped, passphrase_salt, recovery_salt, format_version)
		 select id, user_id, $4, $5, $6, $7, $8 from identity`,
		[
			`uk_${crypto.randomUUID()}`,
			userId,
			input.publicKey,
			input.passphraseWrapped,
			input.recoveryWrapped,
			input.passphraseSalt,
			input.recoverySalt,
			input.formatVersion,
		],
	);

	if (input.rewraps.length > 0) {
		const moved = await client.query(
			`update membership_key mk
			 set enc = v.enc, ciphertext = v.ciphertext, recipient_public_key = $2
			 from unnest($3::text[], $4::text[], $5::text[]) as v(id, enc, ciphertext)
			 where mk.id = v.id and mk.user_id = $1`,
			// mk.user_id is defence in depth and currently unreachable: the
			// completeness check above already requires the submitted ids to be
			// exactly the caller's own, so a foreign id is rejected before this
			// statement runs. Kept because it is the clause that stops the rule
			// from depending on a check three statements away.
			[
				userId,
				input.publicKey,
				input.rewraps.map((r) => r.membershipKeyId),
				input.rewraps.map((r) => r.enc),
				input.rewraps.map((r) => r.ciphertext),
			],
		);
		// The set was proven complete above, so a short count means a row was
		// deleted or reassigned mid-transaction. Throwing rolls the whole
		// rotation back rather than leaving a half-moved keyring.
		if (moved.rowCount !== input.rewraps.length) {
			throw new Error("identity rotation: rewrap set moved mid-transaction");
		}
	}

	return {
		ok: true,
		publicKey: input.publicKey,
		rewrapped: input.rewraps.length,
	};
}
