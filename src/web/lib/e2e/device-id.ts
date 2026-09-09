import { randomId } from "../../../domain/random-id.ts";

const STORAGE_KEY = "ditero-device-id";

// The private key's device wrap binds userId AND deviceId as additional data,
// so this value has to survive every reload on this browser or the stored key
// stops opening -- indistinguishable, at the AES layer, from a tampered record.
// localStorage, not a cookie: it never leaves the browser and the server has no
// business knowing it.
export function deviceId(storage: Storage = localStorage): string {
	const existing = storage.getItem(STORAGE_KEY);
	// A blank or whitespace entry is treated as absent rather than used: an
	// empty deviceId would still bind, consistently, and would silently make
	// every browser that hit the same bug share one AAD context.
	if (existing?.trim()) return existing;
	const minted = randomId();
	storage.setItem(STORAGE_KEY, minted);
	return minted;
}

export { STORAGE_KEY as DEVICE_ID_STORAGE_KEY };
