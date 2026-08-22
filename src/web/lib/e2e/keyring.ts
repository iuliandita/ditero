import {
	aad,
	decryptWrapped,
	EnvelopeOpenError,
	type Wrapped,
} from "../../../domain/e2e/envelope.ts";
import { deriveKek } from "../../../domain/e2e/kdf.ts";
import { clearDeviceKey } from "./device-store.ts";

// In-memory keyring (design 3.2). Everything it holds -- the unwrapped private
// key and any workspace data keys -- lives only here: locking drops it and
// nothing writes it to storage. device-store.ts persists the private key under
// a non-extractable device key; WDKs are never persisted at all, because a
// stored WDK would outlive the membership that justified handing it over.
export type KeyringState = "unenrolled" | "locked" | "ready";

export type EnrolledIdentity = {
	userId: string;
	passphraseWrapped: Wrapped;
	passphraseSalt: Uint8Array;
	kdfVersion: number;
};

export type KeyringFailure = "wrong-secret" | "locked" | "unenrolled" | "stale";

// A wrong passphrase and a record from an older format both surface from
// WebCrypto as one OperationError. The UI has to tell them apart: one says
// "try again", the other says "this device cannot open this record at all".
export class KeyringError extends Error {
	constructor(
		readonly reason: KeyringFailure,
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "KeyringError";
	}
}

export type KeyringOptions = {
	// Injected so the max-age transition is testable. Nothing in this module
	// reads Date.now() directly: a module-scope clock cannot be pinned, and an
	// unpinnable expiry is an untestable one.
	now: () => number;
	maxAgeMs: number;
	// Argon2id at m=64 MiB is deliberately expensive, so callers under test
	// substitute it. Correctness of the real one is pinned by kdf.ts's vectors.
	derive?: (
		secret: string,
		salt: Uint8Array,
		version: number,
	) => Promise<Uint8Array>;
};

export type Keyring = {
	state: () => KeyringState;
	discover: (identity: EnrolledIdentity | null) => void;
	unlock: (secret: string) => Promise<void>;
	lockNow: () => void;
	clear: () => Promise<void>;
	privateKey: () => Uint8Array;
	putWdk: (workspaceId: string, version: number, wdk: Uint8Array) => void;
	wdkFor: (workspaceId: string, version: number) => Uint8Array | undefined;
};

const defaultDerive = (secret: string, salt: Uint8Array, version: number) =>
	deriveKek(secret, salt, "passphrase", version);

export function createKeyring(options: KeyringOptions): Keyring {
	const derive = options.derive ?? defaultDerive;

	let identity: EnrolledIdentity | null = null;
	let privateKey: Uint8Array | null = null;
	let unlockedAt = 0;
	const wdks = new Map<string, Uint8Array>();

	const forget = () => {
		privateKey = null;
		// A WDK outliving its unlock would let a locked page keep decrypting.
		wdks.clear();
	};

	// Expiry is evaluated on read, not on a timer: a timer that does not fire
	// (a backgrounded tab, a suspended laptop) would leave the keyring readable
	// past its max age, which is the one case the max age exists for.
	const expired = () =>
		privateKey !== null && options.now() - unlockedAt >= options.maxAgeMs;

	const state = (): KeyringState => {
		if (!identity) return "unenrolled";
		if (expired()) forget();
		return privateKey ? "ready" : "locked";
	};

	return {
		state,
		discover(next) {
			identity = next;
			forget();
		},
		async unlock(secret) {
			if (!identity) {
				throw new KeyringError("unenrolled", "keyring: no identity to unlock");
			}
			const kek = await derive(
				secret,
				identity.passphraseSalt,
				identity.kdfVersion,
			);
			try {
				privateKey = await decryptWrapped(
					identity.passphraseWrapped,
					kek,
					aad.privateKeyPassphrase(identity.userId),
				);
			} catch (error) {
				// Stay locked. Assigning the reason by the envelope's own phase
				// discriminant keeps "your passphrase is wrong" away from "this
				// record predates a format change", which no passphrase fixes.
				const stale =
					error instanceof EnvelopeOpenError && error.reason !== "cannot-open";
				throw new KeyringError(
					stale ? "stale" : "wrong-secret",
					stale
						? "keyring: this record cannot be opened by this version"
						: "keyring: wrong passphrase",
					error,
				);
			}
			unlockedAt = options.now();
		},
		lockNow: forget,
		async clear() {
			identity = null;
			forget();
			await clearDeviceKey();
		},
		privateKey() {
			const current = state();
			if (current !== "ready" || !privateKey) {
				throw new KeyringError(
					current === "unenrolled" ? "unenrolled" : "locked",
					`keyring: no private key while ${current}`,
				);
			}
			return privateKey;
		},
		putWdk(workspaceId, version, wdk) {
			if (state() !== "ready") {
				throw new KeyringError("locked", "keyring: cannot cache while locked");
			}
			wdks.set(`${workspaceId}:${version}`, wdk);
		},
		wdkFor(workspaceId, version) {
			if (state() !== "ready") return undefined;
			return wdks.get(`${workspaceId}:${version}`);
		},
	};
}
