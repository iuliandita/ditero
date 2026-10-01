import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createSyncTracker,
	deriveSyncPhase,
	OFFLINE_EDIT_WINDOW_MS,
	trackMutations,
	ZERO_HIDDEN_REASON,
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
		tabHidden: false,
		pending: 0,
		rejected: false,
		sessionExpired: false,
		authRejected: false,
		offlineSettled: false,
	};

	it("distinguishes server auth rejection while preserving refusal precedence and queued edits", () => {
		const rejected = {
			...base,
			connection: "needs-auth" as const,
			authRejected: true,
			pending: 2,
		};
		expect(deriveSyncPhase(rejected)).toBe("auth-rejected");
		expect(deriveSyncPhase({ ...rejected, sessionExpired: true })).toBe(
			"reauth",
		);
		expect(deriveSyncPhase({ ...rejected, rejected: true })).toBe("rejected");
		expect(deriveSyncPhase({ ...rejected, connection: "closed" })).toBe(
			"stopped",
		);
		expect(deriveSyncPhase({ ...rejected, connection: "connected" })).toBe(
			"syncing",
		);
		const tracker = createSyncTracker();
		tracker.setAuthRejected(true);
		expect(tracker.getSnapshot().authRejected).toBe(true);
		tracker.setAuthRejected(false);
		expect(tracker.getSnapshot().authRejected).toBe(false);
	});

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

	it("treats a hidden-tab pause as a reconnect, not a refusal", () => {
		const hidden = { ...base, connection: "disconnected" as const };
		expect(deriveSyncPhase({ ...hidden, tabHidden: true })).toBe("syncing");
		expect(
			deriveSyncPhase({
				...hidden,
				reason: ZERO_HIDDEN_REASON,
				offlineSettled: true,
			}),
		).toBe("offline");
		expect(
			deriveSyncPhase({ ...hidden, reason: "unable to connect for 604800s" }),
		).toBe("stopped");
	});

	it("asks for a new sign-in only once the session is known to be gone", () => {
		const auth = {
			...base,
			connection: "needs-auth" as const,
			offlineSettled: true,
		};
		expect(deriveSyncPhase(auth)).toBe("offline");
		expect(deriveSyncPhase({ ...auth, sessionExpired: true })).toBe("reauth");
		expect(deriveSyncPhase({ ...base, sessionExpired: true })).toBe("synced");
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

describe("createSyncTracker", () => {
	it("counts a write until the server confirms it", async () => {
		const pending = createSyncTracker();
		const m = mutation();
		pending.track(m.handle);
		expect(pending.getSnapshot().pending).toBe(1);
		m.client(ok);
		await flush();
		expect(pending.getSnapshot().pending).toBe(1);
		m.server(ok);
		await flush();
		expect(pending.getSnapshot()).toMatchObject({
			pending: 0,
			rejected: false,
		});
	});

	it("drops a write that never applied locally without flagging it", async () => {
		const pending = createSyncTracker();
		const m = mutation();
		pending.track(m.handle);
		m.client(zeroError);
		m.server(zeroError);
		await flush();
		expect(pending.getSnapshot()).toMatchObject({
			pending: 0,
			rejected: false,
		});
	});

	it("flags a server refusal until dismissed", async () => {
		const pending = createSyncTracker();
		const m = mutation();
		pending.track(m.handle);
		m.client(ok);
		m.server(appError);
		await flush();
		expect(pending.getSnapshot()).toMatchObject({ pending: 0, rejected: true });
		pending.dismissRejection();
		expect(pending.getSnapshot().rejected).toBe(false);
	});

	it("keeps a write dropped with the connection pending until reconnect", async () => {
		const pending = createSyncTracker();
		const m = mutation();
		pending.track(m.handle);
		m.client(ok);
		m.server(zeroError);
		await flush();
		expect(pending.getSnapshot()).toMatchObject({
			pending: 1,
			rejected: false,
		});
		pending.connected();
		expect(pending.getSnapshot().pending).toBe(0);
	});

	it("notifies subscribers only on change", async () => {
		const pending = createSyncTracker();
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
		const pending = createSyncTracker();
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

it("matches the hidden-tab reason the installed Zero emits", () => {
	const source = readFileSync(
		"node_modules/@rocicorp/zero/out/zero-client/src/client/zero.js",
		"utf8",
	);
	expect(source).toContain(`message: "${ZERO_HIDDEN_REASON}"`);
});
