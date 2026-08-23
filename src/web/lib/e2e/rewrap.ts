import {
	aad,
	decryptWrapped,
	EnvelopeOpenError,
	encryptWrapped,
} from "../../../domain/e2e/envelope.ts";
import type { KekPurpose } from "../../../domain/e2e/kdf.ts";
import { generateSalt } from "../../../domain/e2e/kdf.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
} from "../../../domain/e2e/wire.ts";
import type { Deriver } from "./derive.ts";
import { KeyringError } from "./keyring.ts";

/** The wire shape of GET /api/e2e/identity/recovery. */
export type RecoveryIdentityResponse = {
	enrolled: boolean;
	recoveryWrapped: string | null;
	recoverySalt: string | null;
	formatVersion: number | null;
};

/** One wrap being replaced, and the value it replaces. */
export type WrapReplacement = {
	wrapped: string;
	salt: string;
	previousWrapped: string;
};

export type RewrapRequest = {
	passphrase?: WrapReplacement;
	recovery?: WrapReplacement;
	formatVersion: number;
};

export type RewrapFailure = "conflict" | "failed";

export class RewrapError extends Error {
	constructor(
		readonly reason: RewrapFailure,
		message: string,
	) {
		super(message);
		this.name = "RewrapError";
	}
}

const AAD_FOR: Record<KekPurpose, (userId: string) => Uint8Array> = {
	passphrase: aad.privateKeyPassphrase,
	recovery: aad.privateKeyRecovery,
};

export async function fetchRecoveryIdentity(): Promise<RecoveryIdentityResponse> {
	const response = await fetch("/api/e2e/identity/recovery", {
		credentials: "include",
	});
	if (!response.ok) {
		throw new RewrapError(
			"failed",
			`rewrap: recovery read failed with ${response.status}`,
		);
	}
	return (await response.json()) as RecoveryIdentityResponse;
}

/**
 * Opens the recovery wrap. The keyring has no path to this: it is built around
 * the passphrase wrap, and a recovery unlock is a one-off that ends in a
 * mandatory rewrap rather than a state the app stays in.
 */
export async function openRecoveryWrap(options: {
	userId: string;
	identity: RecoveryIdentityResponse;
	code: string;
	derive: Deriver["derive"];
}): Promise<Uint8Array> {
	const { recoveryWrapped, recoverySalt, formatVersion } = options.identity;
	if (!recoveryWrapped || !recoverySalt || formatVersion === null) {
		throw new KeyringError("unenrolled", "rewrap: no recovery wrap to open");
	}
	const kek = await options.derive(
		options.code,
		decodeBytes(recoverySalt),
		"recovery",
		formatVersion,
	);
	try {
		return await decryptWrapped(
			decodeWrapped(recoveryWrapped),
			kek,
			AAD_FOR.recovery(options.userId),
		);
	} catch (error) {
		// Same split the passphrase path makes: a record this build cannot read
		// at all is not a wrong code, and telling the user to check their code
		// would send them hunting for a mistake they did not make.
		const stale =
			error instanceof EnvelopeOpenError && error.reason !== "cannot-open";
		throw new KeyringError(
			stale ? "stale" : "wrong-secret",
			stale
				? "rewrap: this record cannot be opened by this version"
				: "rewrap: wrong recovery code",
			error,
		);
	}
}

/**
 * Opens the passphrase wrap without touching the keyring. The rewrap flows
 * demand the passphrase even on an already-unlocked keyring -- unlocked can
 * mean "this browser held a stored key", which is not evidence that the person
 * at the keyboard knows the secret -- so verifying through `keyring.unlock`
 * would make the demand cosmetic on exactly the devices where it matters.
 */
export async function openPassphraseWrap(options: {
	userId: string;
	wrapped: string;
	salt: string;
	version: number;
	secret: string;
	derive: Deriver["derive"];
}): Promise<Uint8Array> {
	const kek = await options.derive(
		options.secret,
		decodeBytes(options.salt),
		"passphrase",
		options.version,
	);
	try {
		return await decryptWrapped(
			decodeWrapped(options.wrapped),
			kek,
			AAD_FOR.passphrase(options.userId),
		);
	} catch (error) {
		const stale =
			error instanceof EnvelopeOpenError && error.reason !== "cannot-open";
		throw new KeyringError(
			stale ? "stale" : "wrong-secret",
			stale
				? "rewrap: this record cannot be opened by this version"
				: "rewrap: wrong passphrase",
			error,
		);
	}
}

/**
 * A fresh salt per rewrap, never the stored one. Reusing a salt would let an
 * observer of both wraps confirm a passphrase was reused across a change,
 * and costs nothing to avoid.
 */
export async function buildReplacement(options: {
	userId: string;
	privateKey: Uint8Array;
	secret: string;
	purpose: KekPurpose;
	version: number;
	previousWrapped: string;
	derive: Deriver["derive"];
}): Promise<WrapReplacement> {
	const salt = generateSalt();
	const kek = await options.derive(
		options.secret,
		salt,
		options.purpose,
		options.version,
	);
	return {
		wrapped: encodeWrapped(
			await encryptWrapped(
				options.privateKey,
				kek,
				AAD_FOR[options.purpose](options.userId),
			),
		),
		salt: encodeBytes(salt),
		previousWrapped: options.previousWrapped,
	};
}

export async function postRewrap(body: RewrapRequest): Promise<void> {
	const response = await fetch("/api/e2e/rewrap", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.ok) return;
	// 409 is the compare-and-set losing: the wrap moved under this client, so
	// the replacement it built is addressed to a value that no longer exists.
	// Retrying with the same body can only lose again -- the caller has to
	// re-read and re-derive -- so the two are not one error.
	throw new RewrapError(
		response.status === 409 ? "conflict" : "failed",
		`rewrap: server refused with ${response.status}`,
	);
}
