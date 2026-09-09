import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_ID_STORAGE_KEY, deviceId } from "./device-id.ts";

class MemoryStorage {
	private map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

let storage: MemoryStorage;
const read = () => storage as unknown as Storage;

beforeEach(() => {
	storage = new MemoryStorage();
});

describe("deviceId", () => {
	it("is stable across calls", () => {
		const first = deviceId(read());
		// The device wrap binds this value as AAD, so a value that changed per
		// call would make the stored key unopenable on the very next reload.
		expect(deviceId(read())).toBe(first);
	});

	it("persists what it minted", () => {
		const minted = deviceId(read());
		expect(storage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(minted);
	});

	it("mints a fresh id per browser", () => {
		const a = deviceId(read());
		storage = new MemoryStorage();
		expect(deviceId(read())).not.toBe(a);
	});

	it("replaces a blank entry instead of binding to it", () => {
		for (const blank of ["", "   ", "\t"]) {
			storage = new MemoryStorage();
			storage.setItem(DEVICE_ID_STORAGE_KEY, blank);
			const resolved = deviceId(read());
			expect(resolved.trim(), JSON.stringify(blank)).not.toBe("");
			expect(resolved).not.toBe(blank);
		}
	});

	it("keeps an existing id rather than minting over it", () => {
		storage.setItem(DEVICE_ID_STORAGE_KEY, "already-here");
		expect(deviceId(read())).toBe("already-here");
	});
});
