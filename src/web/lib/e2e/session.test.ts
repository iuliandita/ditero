import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encodeBytes, encodeWrapped } from "../../../domain/e2e/wire.ts";
import { clearDeviceKey, loadWrappedPrivateKey } from "./device-store.ts";
import { createKeyring } from "./keyring.ts";
import {
	createSession,
	type IdentityResponse,
	toEnrolledIdentity,
} from "./session.ts";

// M-E2E Task 11. The seam between a fetched identity, the keyring and the
// device store. Argon2id is injected for the same reason as keyring.test.ts.
const USER = "u_1";
const OTHER = "u_2";
const KEK = new Uint8Array(32).fill(7);
const PRIVATE_KEY = new Uint8Array(32).fill(9);
const SALT = new Uint8Array(16).fill(3);

const derive = async (secret: string) =>
	secret === "correct-horse" ? KEK : new Uint8Array(32).fill(1);

async function identityFor(userId: string): Promise<IdentityResponse> {
	const wrapped = await encryptWrapped(
		PRIVATE_KEY,
		KEK,
		aad.privateKeyPassphrase(userId),
	);
	return {
		enrolled: true,
		publicKey: encodeBytes(new Uint8Array(32).fill(4)),
		formatVersion: 1,
		passphraseWrapped: encodeWrapped(wrapped),
		passphraseSalt: encodeBytes(SALT),
	};
}

const UNENROLLED: IdentityResponse = {
	enrolled: false,
	publicKey: null,
	formatVersion: null,
	passphraseWrapped: null,
	passphraseSalt: null,
};

let clock = 0;
const DEVICE = "device-a";
let device = DEVICE;

function session(maxAgeMs = 60_000) {
	const keyring = createKeyring({ now: () => clock, maxAgeMs, derive });
	return { keyring, session: createSession(keyring, () => device) };
}

beforeEach(async () => {
	clock = 0;
	device = DEVICE;
	await clearDeviceKey();
});

describe("toEnrolledIdentity", () => {
	it("returns null for a user with no identity", () => {
		expect(toEnrolledIdentity(USER, UNENROLLED)).toBeNull();
		expect(toEnrolledIdentity(USER, null)).toBeNull();
	});

	it("returns null for a row missing any part of the unlock input", async () => {
		const full = await identityFor(USER);
		// Presence assertion: the complete row DOES resolve, so each null below
		// is what rejects it rather than the helper rejecting everything.
		expect(toEnrolledIdentity(USER, full)).not.toBeNull();
		for (const field of [
			"passphraseWrapped",
			"passphraseSalt",
			"formatVersion",
		] as const) {
			expect(
				toEnrolledIdentity(USER, { ...full, [field]: null }),
				field,
			).toBeNull();
		}
	});

	it("carries the stored KDF version rather than assuming one", async () => {
		const full = await identityFor(USER);
		expect(
			toEnrolledIdentity(USER, { ...full, formatVersion: 3 })?.kdfVersion,
		).toBe(3);
	});
});

describe("session", () => {
	it("is unenrolled for a user with no identity", async () => {
		const { session: s } = session();
		await s.adoptIdentity(USER, UNENROLLED);
		expect(s.state()).toBe("unenrolled");
	});

	it("is locked on a device with no stored key", async () => {
		const { session: s } = session();
		await s.adoptIdentity(USER, await identityFor(USER));
		expect(s.state()).toBe("locked");
	});

	it("unlocking with remember survives a fresh session on the same device", async () => {
		const first = session();
		await first.session.adoptIdentity(USER, await identityFor(USER));
		await first.session.unlock("correct-horse", true);
		expect(first.session.state()).toBe("ready");

		// A brand new keyring, as after a reload: no passphrase is supplied and
		// it must still come up ready. This is the whole reason device storage
		// exists.
		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("ready");
		expect(second.keyring.privateKey()).toEqual(PRIVATE_KEY);
	});

	it("unlocking without remember does not survive a reload", async () => {
		const first = session();
		await first.session.adoptIdentity(USER, await identityFor(USER));
		await first.session.unlock("correct-horse", false);
		expect(first.session.state()).toBe("ready");

		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("locked");
	});

	it("clearing remember revokes a device that was already remembered", async () => {
		const first = session();
		await first.session.adoptIdentity(USER, await identityFor(USER));
		await first.session.unlock("correct-horse", true);
		await expect(loadWrappedPrivateKey(USER, DEVICE)).resolves.toEqual(
			PRIVATE_KEY,
		);

		// Turning the checkbox off must actively clear, not merely skip writing:
		// a device remembered yesterday would otherwise stay remembered forever
		// and the control would only work in one direction.
		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		await second.session.unlock("correct-horse", false);

		const third = session();
		await third.session.adoptIdentity(USER, await identityFor(USER));
		expect(third.session.state()).toBe("locked");
	});

	it("a wrong passphrase leaves it locked and stores nothing", async () => {
		const { session: s } = session();
		await s.adoptIdentity(USER, await identityFor(USER));
		await expect(s.unlock("wrong", true)).rejects.toThrow();
		expect(s.state()).toBe("locked");

		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("locked");
	});

	it("another user on the same browser is not let in by the stored record", async () => {
		const first = session();
		await first.session.adoptIdentity(USER, await identityFor(USER));
		await first.session.unlock("correct-horse", true);

		// The device wrap binds userId as AAD, so the record cannot open for
		// OTHER. It must degrade to a passphrase prompt, never to an error and
		// never to access.
		const second = session();
		await second.session.adoptIdentity(OTHER, await identityFor(OTHER));
		expect(second.session.state()).toBe("locked");
	});

	it("a record from another device id does not unlock this one", async () => {
		const first = session();
		await first.session.adoptIdentity(USER, await identityFor(USER));
		await first.session.unlock("correct-horse", true);

		device = "device-b";
		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("locked");
	});

	it("enrolling comes up ready and is remembered", async () => {
		const { session: s } = session();
		await s.enrolled(USER, await identityFor(USER), PRIVATE_KEY, true);
		expect(s.state()).toBe("ready");

		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("ready");
	});

	it("lock now returns to locked without touching the stored key", async () => {
		const { session: s } = session();
		await s.adoptIdentity(USER, await identityFor(USER));
		await s.unlock("correct-horse", true);
		s.lockNow();
		expect(s.state()).toBe("locked");

		// Locking is not revoking: the next reload still comes up ready.
		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("ready");
	});

	it("sign-out clears the device record, unlike lock now", async () => {
		const { session: s } = session();
		await s.adoptIdentity(USER, await identityFor(USER));
		await s.unlock("correct-horse", true);
		await s.signOut();
		expect(s.state()).toBe("unenrolled");

		const second = session();
		await second.session.adoptIdentity(USER, await identityFor(USER));
		expect(second.session.state()).toBe("locked");
	});

	it("auto-lock never keeps a key past no deadline", async () => {
		const { session: s } = session(60_000);
		await s.adoptIdentity(USER, await identityFor(USER));
		await s.unlock("correct-horse", false);
		s.setAutoLockMinutes(0);
		clock += 365 * 24 * 3600 * 1000;
		expect(s.state()).toBe("ready");
	});

	it("auto-lock applies the chosen timeout to a live key", async () => {
		const { session: s } = session(Number.POSITIVE_INFINITY);
		await s.adoptIdentity(USER, await identityFor(USER));
		await s.unlock("correct-horse", false);
		s.setAutoLockMinutes(15);
		clock += 14 * 60_000;
		expect(s.state()).toBe("ready");
		clock += 2 * 60_000;
		expect(s.state()).toBe("locked");
	});
});
