import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearDeviceKey,
	DeviceStoreError,
	loadWrappedPrivateKey,
	readDeviceKeyForTest,
	storeWrappedPrivateKey,
} from "./device-store.ts";

// M-E2E Task 9. Persisting a private key at all is only defensible because the
// key that protects it cannot be exported: an XSS payload can decrypt while it
// runs in the origin, but cannot carry a reusable key away. That is the
// property this file exists to pin.
const secret = () => crypto.getRandomValues(new Uint8Array(32));

beforeEach(async () => {
	await clearDeviceKey();
});

describe("device-store", () => {
	it("creates a non-extractable device key", async () => {
		await storeWrappedPrivateKey("u_1", "d_1", secret());
		const key = await readDeviceKeyForTest();
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
	});

	it("round-trips the private key", async () => {
		const sk = secret();
		await storeWrappedPrivateKey("u_1", "d_1", sk);
		expect(await loadWrappedPrivateKey("u_1", "d_1")).toEqual(sk);
	});

	// Both id guards are cryptographic, not a lookup miss: the ids are bound as
	// AES-GCM additional data, so a mismatch fails to authenticate rather than
	// returning nothing. A keyed lookup would be bypassable by writing the key
	// the attacker wants; the AAD is not.
	it("refuses to load under a different device id", async () => {
		await storeWrappedPrivateKey("u_1", "d_1", secret());
		await expect(loadWrappedPrivateKey("u_1", "d_2")).rejects.toThrow(
			DeviceStoreError,
		);
	});

	it("refuses to load under a different user id", async () => {
		await storeWrappedPrivateKey("u_1", "d_1", secret());
		await expect(loadWrappedPrivateKey("u_2", "d_1")).rejects.toThrow(
			DeviceStoreError,
		);
	});

	it("distinguishes an absent record from an unopenable one", async () => {
		await expect(loadWrappedPrivateKey("u_1", "d_1")).rejects.toMatchObject({
			reason: "absent",
		});
		await storeWrappedPrivateKey("u_1", "d_1", secret());
		await expect(loadWrappedPrivateKey("u_9", "d_1")).rejects.toMatchObject({
			reason: "cannot-open",
		});
	});

	it("clears everything on logout", async () => {
		await storeWrappedPrivateKey("u_1", "d_1", secret());
		await clearDeviceKey();
		await expect(loadWrappedPrivateKey("u_1", "d_1")).rejects.toMatchObject({
			reason: "absent",
		});
	});

	it("never stores the private key in the clear", async () => {
		const sk = secret();
		await storeWrappedPrivateKey("u_1", "d_1", sk);
		const raw = await readRecordForTest();
		const stored = new Uint8Array(raw.ciphertext);
		// Presence assertion first: there IS a ciphertext to inspect, so the
		// comparison below is about its contents rather than an empty buffer.
		expect(stored.length).toBeGreaterThan(sk.length);
		expect(indexOfSubarray(stored, sk)).toBe(-1);
	});
});

async function readRecordForTest(): Promise<{ ciphertext: ArrayBuffer }> {
	const { readRecordForTest: read } = await import("./device-store.ts");
	return await read();
}

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}
