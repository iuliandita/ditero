import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
	dropMemStore,
	MemStore,
} from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/mem-store.js";
import type { StoreProvider } from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/store.js";
import { ReplicacheImpl } from "../../../node_modules/@rocicorp/zero/out/replicache/src/replicache-impl.js";
import { StorageFailureError } from "../../../node_modules/@rocicorp/zero/out/replicache/src/storage-failure.js";

it("retries durable close after Zero stops background persistence on a storage failure", async () => {
	const failure = new StorageFailureError(
		"io-error",
		"injected storage failure",
	);
	let failing = false;
	const stores: MemStore[] = [];
	const provider: StoreProvider = {
		create(name) {
			const store = new MemStore(name);
			stores.push(store);
			return {
				read: () => store.read(),
				write: async () => {
					if (failing) throw failure;
					return store.write();
				},
				close: () => store.close(),
				get closed() {
					return store.closed;
				},
			};
		},
		drop: dropMemStore,
	};
	const options = {
		name: `durable-close-${randomUUID()}`,
		kvStore: provider,
		mutators: {
			write: async (tx: { set(key: string, value: string): Promise<void> }) =>
				await tx.set("accepted", "queued edit"),
		},
		logSinks: [],
	};
	const implOptions = {
		enableScheduledPersist: false,
		enableScheduledRefresh: false,
		enableMutationRecovery: false,
		enablePullAndPushInOpen: false,
	};
	const rep = new ReplicacheImpl(options, implOptions);
	let reopened: ReplicacheImpl | undefined;
	try {
		await rep.mutate.write();
		failing = true;
		// This records 1.11's sticky storage failure and stops its background writes.
		await rep.persist();
		const first = rep.close();
		expect(rep.close()).toBe(first);
		expect(() => rep.mutate.write()).toThrow("closed");
		await expect(first).rejects.toBe(failure);
		expect(stores.every((store) => !store.closed)).toBe(true);
		failing = false;
		await rep.close();
		reopened = new ReplicacheImpl(options, implOptions);
		expect(await reopened.query((tx) => tx.get("accepted"))).toBe(
			"queued edit",
		);
	} finally {
		failing = false;
		await rep.close();
		await reopened?.close();
	}
});
