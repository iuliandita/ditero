import { describe, expect, it } from "vitest";
import {
	createPendingMutations,
	deriveSyncPhase,
	OFFLINE_EDIT_WINDOW_MS,
	trackMutations,
} from "./sync-status.ts";

const ok = { type: "success" };
const appError = { type: "error", error: { type: "app", message: "denied" } };
const zeroError = {
	type: "error",
	error: { type: "zero", message: "offline" },
};

function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function mutation() {
	const client = deferred();
	const server = deferred();
	return {
		handle: { client: client.promise, server: server.promise },
		client: client.resolve,
		server: server.resolve,
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("deriveSyncPhase", () => {
	const base = {
		connection: "connected" as const,
		pending: 0,
		rejected: false,
		offlineSettled: false,
	};

	it("is synced only when connected with nothing pending", () => {
		expect(deriveSyncPhase(base)).toBe("synced");
		expect(deriveSyncPhase({ ...base, pending: 2 })).toBe("syncing");
	});

	it("keeps a short reconnect quiet, then says offline", () => {
		expect(deriveSyncPhase({ ...base, connection: "connecting" })).toBe(
			"syncing",
		);
		expect(
			deriveSyncPhase({
				...base,
				connection: "connecting",
				offlineSettled: true,
			}),
		).toBe("offline");
		expect(
			deriveSyncPhase({
				...base,
				connection: "needs-auth",
				offlineSettled: true,
			}),
		).toBe("offline");
	});

	it("reports stopped whenever Zero refuses edits", () => {
		for (const connection of ["disconnected", "error", "closed"] as const)
			expect(
				deriveSyncPhase({ ...base, connection, pending: 3, rejected: true }),
			).toBe("stopped");
	});

	it("puts a server rejection ahead of offline and syncing", () => {
		expect(deriveSyncPhase({ ...base, rejected: true, pending: 1 })).toBe(
			"rejected",
		);
		expect(
			deriveSyncPhase({
				...base,
				connection: "connecting",
				offlineSettled: true,
				rejected: true,
			}),
		).toBe("rejected");
	});
});

describe("createPendingMutations", () => {
	it("counts a write until the server confirms it", async () => {
		const pending = createPendingMutations();
		const m = mutation();
		pending.track(m.handle);
		expect(pending.getSnapshot().pending).toBe(1);
		m.client(ok);
		await flush();
		expect(pending.getSnapshot().pending).toBe(1);
		m.server(ok);
		await flush();
		expect(pending.getSnapshot()).toEqual({ pending: 0, rejected: false });
	});

	it("drops a write that never applied locally without flagging it", async () => {
		const pending = createPendingMutations();
		const m = mutation();
		pending.track(m.handle);
		m.client(zeroError);
		m.server(zeroError);
		await flush();
		expect(pending.getSnapshot()).toEqual({ pending: 0, rejected: false });
	});

	it("flags a server refusal until dismissed", async () => {
		const pending = createPendingMutations();
		const m = mutation();
		pending.track(m.handle);
		m.client(ok);
		m.server(appError);
		await flush();
		expect(pending.getSnapshot()).toEqual({ pending: 0, rejected: true });
		pending.dismissRejection();
		expect(pending.getSnapshot().rejected).toBe(false);
	});

	it("keeps a write dropped with the connection pending until reconnect", async () => {
		const pending = createPendingMutations();
		const m = mutation();
		pending.track(m.handle);
		m.client(ok);
		m.server(zeroError);
		await flush();
		expect(pending.getSnapshot()).toEqual({ pending: 1, rejected: false });
		pending.connected();
		expect(pending.getSnapshot().pending).toBe(0);
	});

	it("notifies subscribers only on change", async () => {
		const pending = createPendingMutations();
		let calls = 0;
		const stop = pending.subscribe(() => calls++);
		pending.connected();
		expect(calls).toBe(0);
		const m = mutation();
		pending.track(m.handle);
		expect(calls).toBe(1);
		stop();
		m.client(ok);
		m.server(ok);
		await flush();
		expect(calls).toBe(1);
	});
});

describe("trackMutations", () => {
	it("counts every call through zero.mutate and returns its result", async () => {
		const pending = createPendingMutations();
		const m = mutation();
		const zero = {
			mutate: Object.assign(() => m.handle, { extra: 1 }),
		};
		trackMutations(zero, pending);
		const result = zero.mutate();
		expect(result).toBe(m.handle);
		expect((zero.mutate as unknown as { extra: number }).extra).toBe(1);
		expect(pending.getSnapshot().pending).toBe(1);
		m.client(ok);
		m.server(ok);
		await flush();
		expect(pending.getSnapshot().pending).toBe(0);
	});
});

it("keeps the offline edit window below the setTimeout ceiling", () => {
	expect(OFFLINE_EDIT_WINDOW_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
	expect(OFFLINE_EDIT_WINDOW_MS).toBeLessThan(2 ** 31 - 1);
});
