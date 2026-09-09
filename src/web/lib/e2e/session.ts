import { autoLockMaxAgeMs } from "../../../domain/e2e/auto-lock.ts";
import { decodeBytes, decodeWrapped } from "../../../domain/e2e/wire.ts";
import {
	clearDeviceKey,
	DeviceStoreError,
	loadWrappedPrivateKey,
	storeWrappedPrivateKey,
} from "./device-store.ts";
import {
	type EnrolledIdentity,
	type Keyring,
	KeyringError,
	type KeyringState,
} from "./keyring.ts";

/** The wire shape of GET /api/e2e/identity. */
export type IdentityResponse = {
	enrolled: boolean;
	publicKey: string | null;
	formatVersion: number | null;
	passphraseWrapped: string | null;
	passphraseSalt: string | null;
};

/**
 * Null for a user with no identity, and null for a row missing any part of the
 * unlock input. A partial row cannot be unlocked by anything, so surfacing it
 * as `locked` would offer a passphrase prompt that can only ever fail.
 */
export function toEnrolledIdentity(
	userId: string,
	response: IdentityResponse | null,
): EnrolledIdentity | null {
	if (!response?.enrolled) return null;
	const { passphraseWrapped, passphraseSalt, formatVersion } = response;
	if (!passphraseWrapped || !passphraseSalt || formatVersion === null) {
		return null;
	}
	return {
		userId,
		passphraseWrapped: decodeWrapped(passphraseWrapped),
		passphraseSalt: decodeBytes(passphraseSalt),
		kdfVersion: formatVersion,
	};
}

export type Session = {
	state: () => KeyringState;
	/** Applies a fetched identity and tries the device store. */
	adoptIdentity: (
		userId: string,
		response: IdentityResponse | null,
	) => Promise<void>;
	unlock: (secret: string, remember: boolean) => Promise<void>;
	/** Post-enrollment: the private key is already in hand. */
	enrolled: (
		userId: string,
		response: IdentityResponse,
		privateKey: Uint8Array,
		remember: boolean,
	) => Promise<void>;
	lockNow: () => void;
	setAutoLockMinutes: (minutes: number | null) => void;
	signOut: () => Promise<void>;
};

export function createSession(
	keyring: Keyring,
	deviceId: () => string,
): Session {
	let currentUserId: string | null = null;

	const remember = async (privateKey: Uint8Array, keep: boolean) => {
		if (!currentUserId) return;
		// Turning the checkbox OFF must actively clear an existing record, not
		// merely skip writing one: a device that was remembered yesterday would
		// otherwise stay remembered forever, and the control would silently only
		// work in one direction.
		if (!keep) {
			await clearDeviceKey();
			return;
		}
		await storeWrappedPrivateKey(currentUserId, deviceId(), privateKey);
	};

	return {
		state: keyring.state,

		async adoptIdentity(userId, response) {
			currentUserId = userId;
			const identity = toEnrolledIdentity(userId, response);
			keyring.discover(identity);
			if (!identity) return;
			try {
				keyring.adopt(await loadWrappedPrivateKey(userId, deviceId()));
			} catch (error) {
				// Absent is the ordinary case on a new device. A record that will
				// not open is ALSO ordinary -- a different user on the same browser
				// -- so it is dropped rather than surfaced: the user simply gets
				// the passphrase prompt, which is the correct next step either way.
				if (!(error instanceof DeviceStoreError)) throw error;
				await clearDeviceKey();
			}
		},

		async unlock(secret, keep) {
			await keyring.unlock(secret);
			await remember(keyring.privateKey(), keep);
		},

		async enrolled(userId, response, privateKey, keep) {
			currentUserId = userId;
			const identity = toEnrolledIdentity(userId, response);
			if (!identity) {
				throw new KeyringError(
					"unenrolled",
					"session: enrollment did not yield an unlockable identity",
				);
			}
			keyring.discover(identity);
			keyring.adopt(privateKey);
			await remember(privateKey, keep);
		},

		lockNow: keyring.lockNow,

		setAutoLockMinutes(minutes) {
			keyring.setMaxAge(autoLockMaxAgeMs(minutes));
		},

		async signOut() {
			currentUserId = null;
			await keyring.clear();
		},
	};
}
