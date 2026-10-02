import { randomId } from "../../../domain/random-id.ts";

const STORAGE_KEY = "ditero-device-id";

// The private key's device wrap binds userId AND deviceId as additional data,
// so this value has to survive every reload on this browser or the stored key
// stops opening -- indistinguishable, at the AES layer, from a tampered record.
// localStorage, not a cookie: it never leaves the browser and the server has no
// business knowing it.
export function deviceId(
	storage: Storage = localStorage,
	storageScope?: string,
): string {
	if (storageScope !== undefined && !storageScope.trim()) {
		throw new Error("device-id: storage scope must be nonempty");
	}
	const storageKey =
		storageScope === undefined
			? STORAGE_KEY
			: `${STORAGE_KEY}:${encodeURIComponent(storageScope)}`;
	const existing = storage.getItem(storageKey);
	// A blank or whitespace entry is treated as absent rather than used: an
	// empty deviceId would still bind, consistently, and would silently make
	// every browser that hit the same bug share one AAD context.
	if (existing?.trim()) return existing;
	const minted = randomId();
	storage.setItem(storageKey, minted);
	return minted;
}

export { STORAGE_KEY as DEVICE_ID_STORAGE_KEY };
