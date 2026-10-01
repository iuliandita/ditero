// Admission only. Locking, rollback ordering and persistence need a real
// database and are covered by the integration suite.
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { MAX_CONCURRENT_EXCHANGES, NativeGrantStore } from "./store.ts";

const ID = Buffer.alloc(32, 7).toString("base64url");

describe("exchange admission", () => {
	it("answers busy immediately once the cap is reached, without a queue", async () => {
		const gates: Array<() => void> = [];
		const connect = vi.fn(
			() =>
				new Promise<never>((_, reject) => {
					gates.push(() => reject(new Error("released")));
				}),
		);
		const store = new NativeGrantStore({ connect } as unknown as Pool, {
			createSession: vi.fn(),
			deleteSession: vi.fn(),
		});
		const held = Array.from({ length: MAX_CONCURRENT_EXCHANGES }, () =>
			store.exchange(ID, "a".repeat(43)).catch(() => "released"),
		);
		expect(await store.exchange(ID, "a".repeat(43))).toEqual({ kind: "busy" });
		expect(connect).toHaveBeenCalledTimes(MAX_CONCURRENT_EXCHANGES);

		for (const release of gates) release();
		await Promise.all(held);
		// A slot is free again once the earlier exchanges settle.
		const next = store.exchange(ID, "a".repeat(43)).catch(() => "released");
		expect(connect).toHaveBeenCalledTimes(MAX_CONCURRENT_EXCHANGES + 1);
		gates.at(-1)?.();
		await next;
	});
});
