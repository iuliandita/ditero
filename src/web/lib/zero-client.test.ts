import { randomUUID } from "node:crypto";
import type { StorageFailureError } from "@rocicorp/zero";
import { afterEach, expect, it, vi } from "vitest";
import {
	dropMemStore,
	MemStore,
} from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/mem-store.js";
import type { StoreProvider } from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/store.js";
import { StorageFailureError as InjectedFailure } from "../../../node_modules/@rocicorp/zero/out/replicache/src/storage-failure.js";
import { mutators } from "../../zero/mutators.ts";
import { createSyncTracker, deriveSyncPhase } from "./sync-status.ts";
import { createZeroClient, type ZeroClient } from "./zero-client.ts";

const clients: ZeroClient[] = [];

afterEach(async () => {
	await Promise.allSettled(clients.splice(0).map((zero) => zero.close()));
});

function start(provider: StoreProvider) {
	const tracker = createSyncTracker();
	const failures: StorageFailureError[] = [];
	const zero = createZeroClient({
		userID: `storage-${randomUUID()}`,
		token: "unused",
		// Nothing listens here: every edit below exists only on this client.
		cacheURL: "http://127.0.0.1:9",
		onStorageFailure: (failure) => {
			failures.push(failure);
			tracker.setStorageFailed();
		},
		kvStore: provider,
	});
	clients.push(zero);
	return { zero, tracker, failures };
}

function phase(storageFailed: boolean) {
	return deriveSyncPhase({
		connection: "connecting",
		tabHidden: false,
		pending: 0,
		rejected: false,
		sessionExpired: false,
		authRejected: false,
		offlineSettled: true,
		storageFailed,
	});
}

it("reports a store that cannot open, while Zero continues in memory", async () => {
	const { tracker, failures } = start({
		create() {
			throw new InjectedFailure("cannot-open", "injected open failure");
		},
		drop: dropMemStore,
	});
	await vi.waitFor(() => expect(failures).toHaveLength(1));
	expect(failures[0]?.kind).toBe("cannot-open");
	expect(tracker.getSnapshot().storageFailed).toBe(true);
	expect(phase(tracker.getSnapshot().storageFailed)).toBe("storage-offline");
});

it("reports a store that fails after opening", async () => {
	let failing = false;
	const { zero, tracker, failures } = start({
		create(name) {
			const store = new MemStore(name);
			return {
				read: () => store.read(),
				write: async () => {
					if (failing) throw new InjectedFailure("io-error", "injected");
					return store.write();
				},
				close: () => store.close(),
				get closed() {
					return store.closed;
				},
			};
		},
		drop: dropMemStore,
	});
	const edit = zero.mutate(mutators.userPref.set({ keymapProfile: "vim" }));
	expect(await edit.client).toMatchObject({ type: "success" });
	expect(failures).toHaveLength(0);
	// The accepted edit schedules a persist, which now fails.
	failing = true;
	await vi.waitFor(() => expect(failures).toHaveLength(1), { timeout: 10_000 });
	expect(failures[0]?.kind).toBe("io-error");
	expect(tracker.getSnapshot().storageFailed).toBe(true);
});
