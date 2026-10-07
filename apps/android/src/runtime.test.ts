import { beforeEach, expect, test, vi } from "vitest";
import { NativeError } from "./bridge.ts";
import {
	captureVerifiedContext,
	createNativeRuntime,
	StaleNativeContextError,
} from "./runtime.ts";

const native = vi.hoisted(() => ({
	state: {
		gen: 1,
		archiveInput: false,
		archiveMigration: false,
		server: { origin: "https://example.test" },
		session: {
			scope: 'native:["https://example.test","user-1"]',
			userId: "user-1",
			deviceId: "device-1",
			authHandle: "opaque-1",
		},
	},
	refresh: vi.fn(),
	refusal: vi.fn(),
}));
vi.mock("./bridge.ts", () => ({
	NativeError: class NativeError extends Error {
		constructor(public code: string) {
			super(code);
		}
	},
	bridgeState: () => native.state,
	readSession: async () => ({ ...native.state.session }),
	refreshToken: () => native.refresh(),
	setNativeSessionRefusalHandler: (...args: unknown[]) =>
		native.refusal(...args),
	readBridgeState: async () => ({ ...native.state, changed: false }),
	readConfig: vi.fn(),
	ensureBootstrap: vi.fn(),
	callE2e: vi.fn(),
	callAttachment: vi.fn(),
	revokeSession: vi.fn(),
}));
beforeEach(() => {
	native.state.gen = 1;
	native.state.archiveInput = false;
	native.state.archiveMigration = false;
	native.refresh.mockReset();
	native.refusal.mockReset();
});
test("only native-authorized offline proof supplies the opaque Zero handle", async () => {
	const context = await captureVerifiedContext();
	const retireZero = vi.fn(async () => {});
	const runtime = createNativeRuntime(context, {
		retireZero,
		onSessionEnded: vi.fn(),
	});
	native.refresh.mockRejectedValue(new NativeError("offline-ready"));
	await expect(runtime.zero.getAuth()).resolves.toBe("opaque-1");
	expect(retireZero).not.toHaveBeenCalled();
	native.refresh.mockRejectedValue(new NativeError("network"));
	await expect(runtime.zero.getAuth()).rejects.toMatchObject({
		code: "network",
	});
	native.refresh.mockRejectedValue(new NativeError("http-503"));
	await expect(runtime.zero.getAuth()).rejects.toMatchObject({
		code: "http-503",
	});
});
test("a late offline proof cannot retarget another native generation", async () => {
	const context = await captureVerifiedContext();
	const runtime = createNativeRuntime(context, {
		retireZero: async () => {},
		onSessionEnded: vi.fn(),
	});
	native.refresh.mockImplementation(async () => {
		native.state.gen++;
		throw new NativeError("offline-ready");
	});
	await expect(runtime.zero.getAuth()).rejects.toBeInstanceOf(
		StaleNativeContextError,
	);
});

test("socket authority loss waits for durable retirement before ending the account", async () => {
	const context = await captureVerifiedContext();
	let finish!: () => void;
	const retired = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const ended = vi.fn();
	const runtime = createNativeRuntime(context, {
		retireZero: () => retired,
		onSessionEnded: ended,
	});
	native.refresh.mockRejectedValue(new NativeError("offline-ready"));
	await runtime.zero.getAuth();
	const [, , refuse] = native.refusal.mock.calls[0] as [
		number,
		string,
		() => void,
	];
	const previous = native.state.session;
	Object.assign(native.state, { session: null });
	refuse();
	expect(ended).not.toHaveBeenCalled();
	finish();
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(ended).toHaveBeenCalledTimes(1);
	Object.assign(native.state, { session: previous });
});

test("verified archive input capability is captured and desktop-only", async () => {
	const options = { retireZero: async () => {}, onSessionEnded: vi.fn() };
	const absent = await captureVerifiedContext();
	expect(absent.archiveInput).toBe(false);
	native.state.archiveInput = true;
	const enabled = await captureVerifiedContext();
	expect(enabled.archiveInput).toBe(true);
	expect(
		createNativeRuntime(enabled, options).e2e.attachments?.archiveInput,
	).toBeUndefined();
	vi.stubGlobal("__TAURI_INTERNALS__", {});
	try {
		expect(
			createNativeRuntime(absent, options).e2e.attachments?.archiveInput,
		).toBeUndefined();
		expect(
			createNativeRuntime(enabled, options).e2e.attachments?.archiveInput,
		).toBeDefined();
	} finally {
		vi.unstubAllGlobals();
	}
});

test("migration capability captures verified explicit true and remains desktop-only", async () => {
	const absent = await captureVerifiedContext();
	expect(absent.archiveMigration).toBe(false);
	native.state.archiveMigration = true;
	const context = await captureVerifiedContext();
	expect(context.archiveMigration).toBe(true);
	const options = { retireZero: async () => {}, onSessionEnded: vi.fn() };
	expect(
		createNativeRuntime(context, options).e2e.attachments?.archiveMigration,
	).toBeUndefined();
	vi.stubGlobal("__TAURI_INTERNALS__", {});
	try {
		expect(
			createNativeRuntime(context, options).e2e.attachments?.archiveMigration,
		).toBeDefined();
		expect(
			createNativeRuntime(absent, options).e2e.attachments?.archiveMigration,
		).toBeUndefined();
	} finally {
		vi.unstubAllGlobals();
	}
});
