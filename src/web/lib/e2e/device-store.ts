import { byteNarrower } from "../../../domain/e2e/bytes.ts";
import { aad } from "../../../domain/e2e/envelope.ts";

// Device-local persistence of the user's unwrapped private key (design 3.2,
// 11). The record is encrypted under a key generated with extractable:false,
// so the plaintext key never exists as bytes anywhere the page can read: an
// XSS payload can ask this module to decrypt while it runs in the origin, but
// cannot exfiltrate a key it can reuse later or elsewhere.
//
// This deliberately does NOT go through envelope.ts. encryptWrapped takes the
// key as a Uint8Array, which is exactly the thing that must not exist here;
// only the AAD builder is shared.
const DB_NAME = "ditero-e2e";
const DB_VERSION = 1;
const STORE = "device";
const RECORD_KEY = "current";
const NONCE_BYTES = 12;

const bytes = byteNarrower("device-store");

export type DeviceStoreFailure = "absent" | "cannot-open";

// "No key on this device" and "a key that will not open for these ids" lead to
// different UI: the first offers enrollment or unlock, the second means the
// record belongs to another identity and must be cleared, not retried.
export class DeviceStoreError extends Error {
	constructor(
		readonly reason: DeviceStoreFailure,
		message: string,
		cause?: unknown,
	) {
		super(message, { cause });
		this.name = "DeviceStoreError";
	}
}

type DeviceRecord = {
	deviceKey: CryptoKey;
	nonce: ArrayBuffer;
	ciphertext: ArrayBuffer;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(STORE)) {
				req.result.createObjectStore(STORE);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
	const db = await openDb();
	try {
		const tx = db.transaction(STORE, mode);
		const result = await run(tx.objectStore(STORE));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
		return result;
	} finally {
		db.close();
	}
}

async function readRecord(): Promise<DeviceRecord | undefined> {
	return await withStore("readonly", (store) =>
		request<DeviceRecord | undefined>(store.get(RECORD_KEY)),
	);
}

// Structured clone carries a CryptoKey without ever exposing its material, so
// the key is stored as itself rather than as bytes.
export async function storeWrappedPrivateKey(
	userId: string,
	deviceId: string,
	privateKey: Uint8Array,
): Promise<void> {
	const deviceKey = await crypto.subtle.generateKey(
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: bytes(nonce),
			additionalData: bytes(aad.privateKeyDevice(userId, deviceId)),
		},
		deviceKey,
		bytes(privateKey),
	);
	await withStore("readwrite", async (store) => {
		store.put(
			{ deviceKey, nonce: nonce.buffer, ciphertext } satisfies DeviceRecord,
			RECORD_KEY,
		);
	});
}

export async function loadWrappedPrivateKey(
	userId: string,
	deviceId: string,
): Promise<Uint8Array> {
	const record = await readRecord();
	if (!record) {
		throw new DeviceStoreError("absent", "device-store: no key on this device");
	}
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: bytes(new Uint8Array(record.nonce)),
				additionalData: bytes(aad.privateKeyDevice(userId, deviceId)),
			},
			record.deviceKey,
			record.ciphertext,
		);
		return new Uint8Array(plaintext);
	} catch (error) {
		// The ids are bound as additional data, so a mismatch surfaces here as a
		// bare OperationError. Classified, not rethrown: the caller needs to know
		// this record belongs to someone else rather than that AES failed.
		throw new DeviceStoreError(
			"cannot-open",
			"device-store: the stored key does not open for these ids",
			error,
		);
	}
}

// Logout and identity rotation both call this. Deleting the record drops the
// only reference to the device key, and an unexported non-extractable key has
// no other copy to revoke.
export async function clearDeviceKey(): Promise<void> {
	await withStore("readwrite", async (store) => {
		store.delete(RECORD_KEY);
	});
}

export async function readDeviceKeyForTest(): Promise<CryptoKey> {
	const record = await readRecord();
	if (!record) throw new DeviceStoreError("absent", "device-store: no record");
	return record.deviceKey;
}

export async function readRecordForTest(): Promise<DeviceRecord> {
	const record = await readRecord();
	if (!record) throw new DeviceStoreError("absent", "device-store: no record");
	return record;
}
