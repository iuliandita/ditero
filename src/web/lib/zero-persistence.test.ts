import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { createSchema, string, table, Zero } from "@rocicorp/zero";
import { describe, expect, it, vi } from "vitest";
import {
	dropMemStore,
	MemStore,
} from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/mem-store.js";
import type { StoreProvider } from "../../../node_modules/@rocicorp/zero/out/replicache/src/kv/store.js";
import { ReplicacheImpl } from "../../../node_modules/@rocicorp/zero/out/replicache/src/replicache-impl.js";
import { StorageFailureError } from "../../../node_modules/@rocicorp/zero/out/replicache/src/storage-failure.js";

const implOptions = {
	enableScheduledPersist: false,
	enableScheduledRefresh: false,
	enableMutationRecovery: false,
	enablePullAndPushInOpen: false,
};

describe.each(["put", "abort"] as const)("post-open %s failure", (mode) => {
	it.each([
		["QuotaExceededError", "full"],
		["AbortError", "io-error"],
		["UnknownError", "io-error"],
		["InvalidStateError", "io-error"],
	] as const)("reports %s and retains accepted edits", async (name, kind) => {
		const options = {
			name: `persistence-${randomUUID()}`,
			kvStore: "idb" as const,
			mutators: {
				write: async (
					tx: { set(key: string, value: string): Promise<void> },
					value: string,
				) => await tx.set("accepted", value),
			},
			logSinks: [],
		};
		const rep = new ReplicacheImpl(options, implOptions);
		const failures: StorageFailureError[] = [];
		rep.onStorageFailure = (failure) => failures.push(failure);
		let reopened: ReplicacheImpl | undefined;
		const nativePut = IDBObjectStore.prototype.put;
		const failure = new DOMException("injected post-open failure", name);
		let injected = new DOMException("invalid data control", "DataCloneError");
		const put = vi.spyOn(IDBObjectStore.prototype, "put");
		let lastRequest: IDBRequest | undefined;
		try {
			await rep.mutate.write("persisted control");
			await rep.persist();
			expect(failures).toEqual([]);
			await rep.mutate.write("queued edit");
			put.mockImplementation(function (this: IDBObjectStore, value, key) {
				if (this.transaction.db.name !== rep.idbName)
					return nativePut.call(this, value, key);
				if (mode === "put") throw injected;
				const request = nativePut.call(this, value, key);
				lastRequest = request;
				request.addEventListener("success", () => {
					if (request !== lastRequest) return;
					// Abort after the last request: only an abort event, no request error.
					Object.defineProperty(this.transaction, "error", { value: injected });
					this.transaction.abort();
				});
				return request;
			});
			// Data/validation failures must not permanently disable device storage.
			await expect(rep.persist()).rejects.toBe(injected);
			expect(failures).toHaveLength(0);
			injected = failure;
			await rep.persist();
			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatchObject({ kind, cause: failure });
			await rep.persist();
			expect(failures).toHaveLength(1);
			expect(await rep.query((tx) => tx.get("accepted"))).toBe("queued edit");
			// Close must retry the durable write rather than discard the in-memory DAG.
			put.mockRestore();
			await rep.close();
			reopened = new ReplicacheImpl(options, implOptions);
			expect(await reopened.query((tx) => tx.get("accepted"))).toBe(
				"queued edit",
			);
		} finally {
			put.mockRestore();
			await rep.close();
			await reopened?.close();
		}
	});
});

const schema = createSchema({
	tables: [table("item").columns({ id: string() }).primaryKey("id")],
	enableLegacyMutators: true,
});

it("rejects public pending inspection when persistent and fallback memory startup fail", async () => {
	const primaryFailure = new StorageFailureError(
		"io-error",
		"primary open failed",
	);
	const memoryFailure = new Error("fallback memory open failed");
	const write = vi
		.spyOn(MemStore.prototype, "write")
		.mockRejectedValue(memoryFailure);
	// @ts-expect-error This isolated fixture schema differs from the app's global DefaultTypes schema.
	const zero = new Zero<typeof schema>({
		userID: randomUUID(),
		cacheURL: null,
		schema,
		kvStore: {
			create() {
				throw primaryFailure;
			},
			drop: dropMemStore,
		},
		logLevel: "error",
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const hung = new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error("pending inspection hung")),
				500,
			);
		});
		await expect(Promise.race([zero.pendingMutations(), hung])).rejects.toThrow(
			"Cannot inspect pending mutations because storage failed to open",
		);
		expect(write).toHaveBeenCalled();
	} finally {
		clearTimeout(timeout);
		write.mockRestore();
		await zero.close();
	}
});

it.each([
	"opening",
	"closing",
] as const)("keeps Zero running when storage fails during %s, then closes after real acknowledgement", async (when) => {
	const failure = new StorageFailureError("io-error", "injected failure");
	let failing = when === "opening";
	let writes = 0;
	const failures: StorageFailureError[] = [];
	const provider: StoreProvider = {
		create(name) {
			if (failing) throw failure;
			const store = new MemStore(name);
			return {
				read: () => store.read(),
				write: async () => {
					writes++;
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
	// @ts-expect-error This isolated fixture schema differs from the app's global DefaultTypes schema.
	const zero = new Zero<typeof schema>({
		userID: randomUUID(),
		cacheURL: null,
		schema,
		kvStore: provider,
		logLevel: "error",
		onStorageFailure: (failure) => failures.push(failure),
	});
	let rep: ReplicacheImpl | undefined;
	const originalPending = ReplicacheImpl.prototype.experimentalPendingMutations;
	const pending = vi
		.spyOn(ReplicacheImpl.prototype, "experimentalPendingMutations")
		.mockImplementation(function (this: ReplicacheImpl) {
			rep = this;
			return originalPending.call(this);
		});
	try {
		expect(await zero.pendingMutations()).toBe(0);
		await zero.mutate.item.upsert({ id: "accepted" });
		expect(await zero.pendingMutations()).toBe(1);
		expect(rep).toBeDefined();
		pending.mockRestore();
		const connection = zero.connection.state.current.name;
		failing = true;
		const closing = zero.close();
		expect(zero.close()).toBe(closing);
		expect(() => zero.mutate.item.upsert({ id: "too late" })).toThrow("closed");
		await expect(closing).rejects.toMatchObject({
			cause: failure,
			pendingMutations: 1,
		});
		expect(zero.closed).toBe(false);
		expect(zero.connection.state.current.name).toBe(connection);
		// Dispatch and close promise are reset on refusal, so sync can continue.
		await zero.mutate.item.upsert({ id: "after refusal" });
		expect(await zero.pendingMutations()).toBe(2);
		if (!rep) throw new Error("missing real Replicache instance");
		await rep.poke({
			baseCookie: null,
			pullResponse: {
				cookie: "1",
				lastMutationIDChanges: { [rep.clientID]: 2 },
				patch: [],
			},
		});
		expect(await zero.pendingMutations()).toBe(0);
		// Storage remains failed, but no accepted edits can now be lost.
		const writesBeforeClose = writes;
		await zero.close();
		expect(zero.closed).toBe(true);
		expect(writes).toBe(writesBeforeClose);
		expect(failures).toHaveLength(1);
	} finally {
		pending.mockRestore();
		failing = false;
		await zero.close();
	}
});

it.each([
	false,
	true,
])("settles accepted commits before shutdown, including a first-close storage failure (%s)", async (failClose) => {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const options = {
		name: `close-barrier-${randomUUID()}`,
		kvStore: "idb" as const,
		mutators: {
			write: async (tx: { set(key: string, value: string): Promise<void> }) => {
				enter();
				await held;
				await tx.set("accepted", "held commit");
			},
		},
		logSinks: [],
	};
	const rep = new ReplicacheImpl(options, implOptions);
	let reopened: ReplicacheImpl | undefined;
	const put = vi.spyOn(IDBObjectStore.prototype, "put");
	const failure = new DOMException(
		"first close quota failure",
		"QuotaExceededError",
	);
	const shutdown = vi.fn(() => {
		expect(() => rep.mutate.write()).toThrow("closed");
	});
	try {
		const accepted = rep.mutate.write();
		await entered;
		if (failClose)
			put.mockImplementation(() => {
				throw failure;
			});
		const closing = rep.close(shutdown);
		expect(rep.close(shutdown)).toBe(closing);
		expect(() => rep.mutate.write()).toThrow("closed");
		expect(shutdown).not.toHaveBeenCalled();
		release();
		await accepted;
		if (failClose) {
			await expect(closing).rejects.toMatchObject({ pendingMutations: 1 });
			expect(rep.closed).toBe(false);
			expect(shutdown).not.toHaveBeenCalled();
			put.mockRestore();
			await rep.close(shutdown);
		} else await closing;
		expect(shutdown).toHaveBeenCalledTimes(1);
		reopened = new ReplicacheImpl(options, implOptions);
		expect(await reopened.query((tx) => tx.get("accepted"))).toBe(
			"held commit",
		);
	} finally {
		release();
		put.mockRestore();
		await rep.close();
		await reopened?.close();
	}
});

it.each([
	false,
	true,
])("settles close and pending inspection after slow startup falls back to memory (accepted edit: %s)", async (withEdit) => {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const failure = new StorageFailureError(
		"cannot-open",
		"slow primary open failed",
	);
	let first = true;
	const provider: StoreProvider = {
		create(name) {
			const store = new MemStore(name);
			return {
				read: () => store.read(),
				write: async () => {
					if (first) {
						first = false;
						enter();
						await held;
						throw failure;
					}
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
	// @ts-expect-error This isolated fixture schema differs from the app's global DefaultTypes schema.
	const zero = new Zero<typeof schema>({
		userID: randomUUID(),
		cacheURL: null,
		schema,
		kvStore: provider,
		logLevel: "error",
	});
	let rep: ReplicacheImpl | undefined;
	const originalPending = ReplicacheImpl.prototype.experimentalPendingMutations;
	const pending = vi
		.spyOn(ReplicacheImpl.prototype, "experimentalPendingMutations")
		.mockImplementation(function (this: ReplicacheImpl) {
			rep = this;
			return originalPending.call(this);
		});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	try {
		await entered;
		// Dispatch is accepted before close, but its local commit awaits startup.
		const accepted = withEdit
			? zero.mutate.item.upsert({ id: "accepted during open" })
			: Promise.resolve();
		const inspection = zero.pendingMutations();
		const closing = zero.close();
		const results = Promise.allSettled([closing, inspection, accepted]);
		release();
		const [closed, inspected, committed] = await Promise.race([
			results,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("slow-open close or pending inspection hung")),
					1000,
				);
			}),
		]);
		settled = true;
		expect(committed.status).toBe("fulfilled");
		if (withEdit) {
			expect(closed).toMatchObject({
				status: "rejected",
				reason: { pendingMutations: 1, cause: failure },
			});
			expect(zero.closed).toBe(false);
			expect(await zero.pendingMutations()).toBe(1);
			if (!rep) throw new Error("missing real Replicache instance");
			await rep.poke({
				baseCookie: null,
				pullResponse: {
					cookie: "1",
					lastMutationIDChanges: { [rep.clientID]: 1 },
					patch: [],
				},
			});
			await zero.close();
		} else {
			expect(closed.status).toBe("fulfilled");
			expect(zero.closed).toBe(true);
		}
		expect(inspected).toEqual({ status: "fulfilled", value: withEdit ? 1 : 0 });
	} finally {
		release();
		clearTimeout(timeout);
		pending.mockRestore();
		if (settled && !zero.closed) await zero.close();
	}
});
