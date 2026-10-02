import { afterEach, describe, expect, it, vi } from "vitest";
import { createExportBoundary } from "./export-boundary.ts";

class Journal implements Storage {
	entries = new Map<string, string>();
	get length() {
		return this.entries.size;
	}
	clear() {
		this.entries.clear();
	}
	getItem(key: string) {
		return this.entries.get(key) ?? null;
	}
	key(index: number) {
		return [...this.entries.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.entries.delete(key);
	}
	setItem(key: string, value: string) {
		this.entries.set(key, value);
	}
}

const success = { type: "success" };
const error = (type: string) => ({
	type: "error",
	error: { type, message: "failed" },
});
function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
function boundary(
	storage: Storage = new Journal(),
	generation = "first",
	userID = "user",
	storageScope?: string,
) {
	return createExportBoundary({
		userID,
		storageScope,
		clientID: "client",
		generation,
		storage,
		isConnected: () => true,
	});
}
function wait(
	tracker: ReturnType<typeof boundary>,
	signal = new AbortController().signal,
) {
	return tracker.waitForSaved({ signal });
}
afterEach(() => vi.useRealTimers());

describe("export saved boundary", () => {
	it("journals before optimistic writes and waits for positive server acknowledgement", async () => {
		const storage = new Journal();
		const tracker = boundary(storage);
		const server = deferred();
		const mutation = {
			client: Promise.resolve(success),
			server: server.promise,
		};
		expect(
			tracker.wrapMutation(() => {
				expect(storage.length).toBe(1);
				return mutation;
			}),
		).toBe(mutation);
		const initial = tracker.getSnapshot();
		expect(tracker.getSnapshot()).toBe(initial);
		let saved = false;
		const waiting = wait(tracker).then((result) => {
			saved = result;
			return result;
		});
		await flush();
		expect(saved).toBe(false);
		expect(tracker.getSnapshot().pending).toBe(1);
		server.resolve(success);
		expect(await waiting).toBe(true);
		expect(storage.length).toBe(0);
	});

	it.each([
		error("zero"),
		undefined,
		{ type: "success", unexpected: true },
		{ type: "error", error: {} },
	])("retains uncertainty for an unproven server result %j", async (result) => {
		const storage = new Journal();
		const tracker = boundary(storage);
		tracker.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(result),
		}));
		await flush();
		expect(tracker.getSnapshot().uncertain).toBe(true);
		tracker.connectionChanged();
		tracker.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(success),
		}));
		await flush();
		expect(await wait(tracker)).toBe(false);
		expect(storage.length).toBe(1);
	});

	it("retains rejected promises and application refusal separately", async () => {
		const rejected = boundary();
		rejected.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.reject(new Error("disconnect")),
		}));
		const refused = boundary();
		refused.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(error("app")),
		}));
		await flush();
		expect(rejected.getSnapshot().uncertain).toBe(true);
		expect(refused.getSnapshot().refused).toBe(true);
		expect(await wait(refused)).toBe(false);
	});

	it("removes only proven never-applied local refusals", async () => {
		const storage = new Journal();
		const tracker = boundary(storage);
		tracker.wrapMutation(() => ({
			client: Promise.resolve(error("zero")),
			server: Promise.reject(new Error("closed")),
		}));
		await flush();
		expect(storage.length).toBe(0);
		expect(await wait(tracker)).toBe(true);
		tracker.wrapMutation(() => ({
			client: Promise.reject(new Error("unknown")),
			server: Promise.resolve(success),
		}));
		await flush();
		expect(tracker.getSnapshot().uncertain).toBe(true);
	});

	it("keeps one absolute deadline while new writes arrive and supports abort", async () => {
		vi.useFakeTimers();
		const tracker = boundary();
		const pending = () => ({
			client: Promise.resolve(success),
			server: deferred().promise,
		});
		tracker.wrapMutation(pending);
		const waiting = wait(tracker);
		await vi.advanceTimersByTimeAsync(9_000);
		tracker.wrapMutation(pending);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await waiting).toBe(false);
		const controller = new AbortController();
		const aborted = wait(tracker, controller.signal);
		controller.abort();
		expect(await aborted).toBe(false);
	});

	it("blocks offline and retired clients and retains dirty markers after dispose", async () => {
		let connected = true;
		const storage = new Journal();
		const tracker = createExportBoundary({
			userID: "user",
			clientID: "client",
			generation: "first",
			storage,
			isConnected: () => connected,
		});
		const server = deferred();
		tracker.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: server.promise,
		}));
		const waiting = wait(tracker);
		connected = false;
		tracker.connectionChanged();
		expect(await waiting).toBe(false);
		connected = true;
		const retired = wait(tracker);
		tracker.dispose();
		expect(await retired).toBe(false);
		server.resolve(success);
		await flush();
		expect(storage.length).toBe(1);
		expect(await wait(tracker)).toBe(false);
	});

	it("expires even when the wall clock moves backward while a write is pending", async () => {
		vi.useFakeTimers();
		const tracker = boundary();
		tracker.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: deferred().promise,
		}));
		const waiting = wait(tracker);
		vi.setSystemTime(Date.now() - 60_000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await waiting).toBe(false);
	});

	it("isolates users and runtime generations even with a reused public client ID", async () => {
		const storage = new Journal();
		const first = boundary(storage);
		first.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: deferred().promise,
		}));
		const reloaded = boundary(storage, "second");
		expect(reloaded.getSnapshot().prior).toBe(true);
		reloaded.wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(success),
		}));
		await flush();
		expect(await wait(reloaded)).toBe(false);
		expect(storage.length).toBe(1);
		expect(await wait(boundary(storage, "second", "other-user"))).toBe(true);
		const reusedGeneration = boundary(storage);
		expect(reusedGeneration.getSnapshot().prior).toBe(true);
	});

	it("does not let a native server's uncertainty block the same user on another server", async () => {
		const storage = new Journal();
		boundary(storage, "first", "user", "server-a").wrapMutation(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(undefined),
		}));
		await flush();
		expect(storage.length).toBe(1);
		const otherServer = boundary(storage, "first", "user", "server-b");
		expect(otherServer.getSnapshot()).toMatchObject({
			prior: false,
			uncertain: false,
		});
		expect(await wait(otherServer)).toBe(true);
		expect(storage.length).toBe(1);
	});

	it("retains a native scope's prior journal when that scope returns", async () => {
		const storage = new Journal();
		boundary(storage, "first", "user", "server-a").wrapMutation(() => ({
			client: Promise.resolve(success),
			server: deferred().promise,
		}));
		const returned = boundary(storage, "second", "user", "server-a");
		expect(returned.getSnapshot().prior).toBe(true);
		expect(await wait(returned)).toBe(false);
	});

	it("rechecks other journals before accepting an otherwise clean boundary", async () => {
		const storage = new Journal();
		const clean = boundary(storage);
		boundary(storage, "other-tab").wrapMutation(() => ({
			client: Promise.resolve(success),
			server: deferred().promise,
		}));
		expect(await wait(clean)).toBe(false);
		expect(clean.getSnapshot().prior).toBe(true);
	});

	it("fails closed on storage failure without blocking ordinary mutation invocation", async () => {
		const storage = new Journal();
		storage.setItem = () => {
			throw new Error("quota");
		};
		const tracker = boundary(storage);
		const run = vi.fn(() => ({
			client: Promise.resolve(success),
			server: Promise.resolve(success),
		}));
		tracker.wrapMutation(run);
		await flush();
		expect(run).toHaveBeenCalledOnce();
		expect(tracker.getSnapshot().storageFailed).toBe(true);
		expect(await wait(tracker)).toBe(false);
	});
});
