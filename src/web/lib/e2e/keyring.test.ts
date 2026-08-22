import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { clearDeviceKey } from "./device-store.ts";
import { createKeyring, KeyringError } from "./keyring.ts";

// M-E2E Task 9. The keyring is a state machine over material that must never
// be persisted, so the tests pin two things: which transitions are legal, and
// that a cached WDK never reaches IndexedDB.
//
// Real Argon2id derivation is m=64 MiB / t=3 by design, so the KDF is injected
// here. Its correctness is pinned by kdf.ts's own known-answer vectors; what
// this file tests is the machine around it.
const USER = "u_1";
const KEK = new Uint8Array(32).fill(7);
const PRIVATE_KEY = new Uint8Array(32).fill(9);

const derive = async (secret: string) =>
	secret === "correct-horse" ? KEK : new Uint8Array(32).fill(1);

async function enrolled() {
	const wrapped = await encryptWrapped(
		PRIVATE_KEY,
		KEK,
		aad.privateKeyPassphrase(USER),
	);
	return {
		userId: USER,
		passphraseWrapped: wrapped,
		passphraseSalt: new Uint8Array(16).fill(3),
		kdfVersion: 1,
	};
}

let clock = 0;
const now = () => clock;

function keyring(maxAgeMs = 60_000) {
	return createKeyring({ now, maxAgeMs, derive });
}

beforeEach(async () => {
	clock = 0;
	await clearDeviceKey();
});

describe("keyring", () => {
	it("starts unenrolled and becomes locked once a server row exists", async () => {
		const ring = keyring();
		expect(ring.state()).toBe("unenrolled");
		ring.discover(await enrolled());
		expect(ring.state()).toBe("locked");
	});

	it("unlocks with the correct passphrase", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		expect(ring.state()).toBe("ready");
	});

	it("stays locked on a wrong passphrase and reports why", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await expect(ring.unlock("wrong")).rejects.toMatchObject({
			name: "KeyringError",
			reason: "wrong-secret",
		});
		expect(ring.state()).toBe("locked");
	});

	it("locks on demand", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		ring.lockNow();
		expect(ring.state()).toBe("locked");
	});

	it("locks once the max age elapses", async () => {
		const ring = keyring(60_000);
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		clock = 59_999;
		expect(ring.state()).toBe("ready");
		clock = 60_000;
		expect(ring.state()).toBe("locked");
	});

	it("returns to unenrolled on clear", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		await ring.clear();
		expect(ring.state()).toBe("unenrolled");
	});

	it("refuses to hand out key material while locked", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		expect(() => ring.privateKey()).toThrow(KeyringError);
		await ring.unlock("correct-horse");
		expect(ring.privateKey()).toEqual(PRIVATE_KEY);
		ring.lockNow();
		expect(() => ring.privateKey()).toThrow(KeyringError);
	});

	it("caches a WDK in memory and never persists it", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		const wdk = new Uint8Array(32).fill(5);
		ring.putWdk("ws_1", 1, wdk);
		// Presence assertion: the cache works, so the absence below is about
		// persistence rather than about nothing having been cached.
		expect(ring.wdkFor("ws_1", 1)).toEqual(wdk);
		expect(await indexedDbHolds(wdk)).toBe(false);
	});

	it("drops cached WDKs when it locks", async () => {
		const ring = keyring();
		ring.discover(await enrolled());
		await ring.unlock("correct-horse");
		ring.putWdk("ws_1", 1, new Uint8Array(32).fill(5));
		ring.lockNow();
		await ring.unlock("correct-horse");
		expect(ring.wdkFor("ws_1", 1)).toBeUndefined();
	});
});

// Walks every record in every store of every database and looks for the bytes.
// A targeted read of the device store would pass even if a WDK were written
// somewhere else entirely, which is the failure this is guarding against.
//
// Polled, because IndexedDB writes are asynchronous and a leak would not be
// awaited by the code that caused it. A single scan races the write it is
// looking for and reports "clean" for a store that is about to hold the key --
// verified: a probe that persisted the WDK passed a single-scan version of
// this helper.
async function indexedDbHolds(
	needle: Uint8Array,
	windowMs = 250,
): Promise<boolean> {
	const deadline = Date.now() + windowMs;
	do {
		if (await scanOnce(needle)) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	return false;
}

async function scanOnce(needle: Uint8Array): Promise<boolean> {
	const databases = await indexedDB.databases();
	for (const { name } of databases) {
		if (!name) continue;
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(name);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		try {
			for (const store of Array.from(db.objectStoreNames)) {
				const values = await new Promise<unknown[]>((resolve, reject) => {
					const req = db
						.transaction(store, "readonly")
						.objectStore(store)
						.getAll();
					req.onsuccess = () => resolve(req.result);
					req.onerror = () => reject(req.error);
				});
				if (JSON.stringify(values).includes(JSON.stringify(Array.from(needle))))
					return true;
			}
		} finally {
			db.close();
		}
	}
	return false;
}
