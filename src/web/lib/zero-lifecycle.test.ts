import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncTracker, trackMutations } from "./sync-status.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let lifecycle: typeof import("./zero-lifecycle.ts");

beforeEach(async () => {
	vi.resetModules();
	lifecycle = await import("./zero-lifecycle.ts");
});

function client() {
	return {
		userID: "a",
		mutate: vi.fn(() => ({
			client: Promise.resolve({ type: "success" }),
			server: new Promise<unknown>(() => {}),
		})),
		close: vi.fn(async () => {}),
	};
}

describe("Zero retirement", () => {
	it("is a no-op before any authenticated client exists", async () => {
		await lifecycle.retireZeroClients();
		await lifecycle.waitForZeroRetirements();
	});

	it("settles accepted local commits before close without waiting for the server", async () => {
		const local = deferred<{ type: string }>();
		const durable = deferred<void>();
		const zero = client();
		const mutate = zero.mutate;
		mutate.mockReturnValueOnce({
			client: local.promise,
			server: new Promise<unknown>(() => {}),
		});
		zero.close.mockImplementationOnce(() => durable.promise);
		const stop = vi.fn();
		lifecycle.registerZeroClient("a", zero, stop);
		zero.mutate();
		const retiring = lifecycle.retireZeroClients();
		expect(stop).toHaveBeenCalledTimes(1);
		await expect(zero.mutate().client).resolves.toMatchObject({
			type: "error",
			error: { type: "zero" },
		});
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(zero.close).not.toHaveBeenCalled();
		local.resolve({ type: "success" });
		await vi.waitFor(() => expect(zero.close).toHaveBeenCalledTimes(1));
		let completed = false;
		void retiring.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		durable.resolve();
		await retiring;
		expect(completed).toBe(true);
	});

	it("a failed local commit settles without preventing durable close", async () => {
		const local = deferred<{ type: string }>();
		const zero = client();
		zero.mutate.mockReturnValueOnce({
			client: local.promise,
			server: new Promise<unknown>(() => {}),
		});
		lifecycle.registerZeroClient("a", zero, () => {});
		zero.mutate();
		const retiring = lifecycle.retireZeroClients();
		local.reject(new Error("local mutation failed"));
		await retiring;
		expect(zero.close).toHaveBeenCalledTimes(1);
	});

	it("shares cleanup completion and concurrent explicit retirement", async () => {
		const durable = deferred<void>();
		const zero = client();
		zero.close.mockImplementationOnce(() => durable.promise);
		const stop = vi.fn();
		const owner = lifecycle.registerZeroClient("a", zero, stop);
		const first = owner.retire();
		expect(owner.retire()).toBe(first);
		const navigation = lifecycle.retireZeroClients();
		await vi.waitFor(() => expect(zero.close).toHaveBeenCalledTimes(1));
		expect(stop).toHaveBeenCalledTimes(1);
		durable.resolve();
		await Promise.all([first, navigation]);
	});

	it("keeps a persistence failure blocking factories until an explicit retry succeeds", async () => {
		const zero = client();
		const failure = new Error("storage unavailable");
		zero.close.mockRejectedValueOnce(failure);
		lifecycle.registerZeroClient("a", zero, () => {});
		await expect(lifecycle.retireZeroClients()).rejects.toBe(failure);
		const create = vi.fn(client);
		await expect(
			lifecycle.createAfterZeroRetirement(create, () => false),
		).rejects.toMatchObject({ cause: failure });
		expect(create).not.toHaveBeenCalled();
		expect(zero.close).toHaveBeenCalledTimes(1);
		await expect(zero.mutate().client).resolves.toMatchObject({
			type: "error",
		});
		await Promise.all([
			lifecycle.retireZeroClients(),
			lifecycle.retireZeroClients(),
		]);
		expect(zero.close).toHaveBeenCalledTimes(2);
		await expect(
			lifecycle.createAfterZeroRetirement(create, () => false),
		).resolves.toMatchObject({ userID: "a" });
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("does not replace the old account while its close is pending", async () => {
		const durable = deferred<void>();
		const zero = client();
		zero.close.mockImplementationOnce(() => durable.promise);
		lifecycle.registerZeroClient("a", zero, () => {});
		const retiring = lifecycle.retireZeroClients();
		const create = vi.fn(() => ({ userID: "b" }));
		const next = lifecycle.createAfterZeroRetirement(create, () => false);
		await Promise.resolve();
		expect(create).not.toHaveBeenCalled();
		durable.resolve();
		await retiring;
		await expect(next).resolves.toEqual({ userID: "b" });
	});

	it("a startup cancelled during the retirement wait never constructs a client", async () => {
		const durable = deferred<void>();
		const zero = client();
		zero.close.mockImplementationOnce(() => durable.promise);
		lifecycle.registerZeroClient("a", zero, () => {});
		const retiring = lifecycle.retireZeroClients();
		let cancelled = false;
		const create = vi.fn(client);
		const next = lifecycle.createAfterZeroRetirement(create, () => cancelled);
		cancelled = true;
		durable.resolve();
		await retiring;
		await expect(next).resolves.toBeUndefined();
		expect(create).not.toHaveBeenCalled();
	});

	it("preserves mutation properties and the existing sync tracker wrapper", async () => {
		const zero = client();
		Object.assign(zero.mutate, { marker: "mutation configuration" });
		lifecycle.registerZeroClient("a", zero, () => {});
		const tracker = createSyncTracker();
		trackMutations(zero, tracker);
		expect(zero.mutate).toHaveProperty("marker", "mutation configuration");
		zero.mutate();
		expect(tracker.getSnapshot().pending).toBe(1);
		await lifecycle.retireZeroClients();
		await expect(zero.mutate().client).resolves.toMatchObject({
			type: "error",
		});
	});

	it("rejects registering a client under another account", () => {
		expect(() => lifecycle.registerZeroClient("b", client(), () => {})).toThrow(
			"does not belong to this account",
		);
	});

	it("publishes completion before retirement callbacks can reenter", async () => {
		const durable = deferred<void>();
		const zero = client();
		zero.close.mockImplementationOnce(() => durable.promise);
		let owner!: ReturnType<typeof lifecycle.registerZeroClient>;
		let reentered: Promise<void> | undefined;
		owner = lifecycle.registerZeroClient("a", zero, () => {
			reentered = owner.retire();
		});
		const first = owner.retire();
		expect(reentered).toBe(first);
		await vi.waitFor(() => expect(zero.close).toHaveBeenCalledTimes(1));
		durable.resolve();
		await first;
	});

	it("caches a cleanup callback failure and retries it only explicitly", async () => {
		const zero = client();
		let stopFailed = true;
		const failure = new Error("watcher cleanup failed");
		const stop = vi.fn(() => {
			if (stopFailed) throw failure;
		});
		lifecycle.registerZeroClient("a", zero, stop);
		await expect(lifecycle.retireZeroClients()).rejects.toBe(failure);
		await expect(lifecycle.waitForZeroRetirements()).rejects.toMatchObject({
			cause: failure,
		});
		expect(stop).toHaveBeenCalledTimes(1);
		expect(zero.close).not.toHaveBeenCalled();
		stopFailed = false;
		await lifecycle.retireZeroClients();
		expect(stop).toHaveBeenCalledTimes(2);
		expect(zero.close).toHaveBeenCalledTimes(1);
	});

	it("does not retry a failed close during automatic reconciliation", async () => {
		const zero = client();
		const failure = new Error("storage unavailable");
		zero.close.mockRejectedValueOnce(failure);
		lifecycle.registerZeroClient("a", zero, () => {});
		await expect(lifecycle.retireZeroClients()).rejects.toBe(failure);
		await expect(
			lifecycle.retireZeroClients({ retryFailed: false }),
		).rejects.toBe(failure);
		expect(zero.close).toHaveBeenCalledTimes(1);
		await lifecycle.retireZeroClients();
	});

	it("does not invoke a social redirect until persistence completes", async () => {
		const durable = deferred<void>();
		const zero = client();
		zero.close.mockImplementationOnce(() => durable.promise);
		lifecycle.registerZeroClient("a", zero, () => {});
		const social = vi.fn(async () => "redirected");
		const login = lifecycle.runAfterZeroRetirement(social);
		await vi.waitFor(() => expect(zero.close).toHaveBeenCalledTimes(1));
		expect(social).not.toHaveBeenCalled();
		durable.resolve();
		await expect(login).resolves.toBe("redirected");
		expect(social).toHaveBeenCalledTimes(1);
	});

	it("prevents social redirect on persistence failure and recovers on user retry", async () => {
		const zero = client();
		const failure = new Error("storage unavailable");
		zero.close.mockRejectedValueOnce(failure);
		lifecycle.registerZeroClient("a", zero, () => {});
		const social = vi.fn(async () => "redirected");
		await expect(
			lifecycle.runAfterZeroRetirement(social),
		).rejects.toBeInstanceOf(lifecycle.ZeroRetirementError);
		expect(social).not.toHaveBeenCalled();
		await expect(lifecycle.runAfterZeroRetirement(social)).resolves.toBe(
			"redirected",
		);
		expect(social).toHaveBeenCalledTimes(1);
		expect(zero.close).toHaveBeenCalledTimes(2);
	});

	it("keeps owner lifetime separate from a completed client retirement", async () => {
		const zero = client();
		let cancelled = false;
		lifecycle.registerZeroClient(
			"a",
			zero,
			() => {},
			() => cancelled,
		);
		const active = lifecycle.captureZeroClientOwner();
		await lifecycle.retireZeroClients();
		expect(lifecycle.isZeroClientOwnerActive(zero)).toBe(true);
		expect(active?.()).toBe(true);
		cancelled = true;
		expect(lifecycle.isZeroClientOwnerActive(zero)).toBe(false);
		expect(active?.()).toBe(false);
	});
});
