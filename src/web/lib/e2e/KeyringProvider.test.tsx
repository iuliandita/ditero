import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	generateIdentityKeyPair,
	importRecipientPrivateKey,
	openWdk,
	publicKeyFingerprint,
} from "../../../domain/e2e/hpke.ts";
import { decodeBytes, encodeBytes } from "../../../domain/e2e/wire.ts";
import type { E2eRuntime } from "./runtime.ts";

type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
type Pending = {
	index: number;
	run: () => undefined | (() => void);
	deps?: readonly unknown[];
};

// Drives the provider's hooks without a DOM: state and refs persist across
// renders, effects commit after each render when their dependencies change.
const hooks = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	pending: [] as Pending[],
	dirty: false,
}));
const fixture = vi.hoisted(() => ({
	keyState: "ready" as "ready" | "locked" | "unenrolled",
	wdks: new Map<string, Uint8Array>(),
	reconcile: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
		!!a &&
		!!b &&
		a.length === b.length &&
		a.every((value, index) => Object.is(value, b[index]));
	const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
		const index = hooks.cursor++;
		const slot = hooks.slots[index] as
			| { deps?: readonly unknown[]; value: unknown }
			| undefined;
		if (slot && same(slot.deps, deps)) return slot.value;
		const value = factory();
		hooks.slots[index] = { deps, value };
		return value;
	};
	return {
		...actual,
		useState: (initial: unknown) => {
			const index = hooks.cursor++;
			if (!(index in hooks.slots)) hooks.slots[index] = { value: initial };
			const slot = hooks.slots[index] as { value: unknown };
			return [
				slot.value,
				(next: unknown) => {
					const value = typeof next === "function" ? next(slot.value) : next;
					if (Object.is(value, slot.value)) return;
					slot.value = value;
					hooks.dirty = true;
				},
			];
		},
		useRef: (initial: unknown) => {
			const index = hooks.cursor++;
			if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
			return hooks.slots[index];
		},
		useMemo: memo,
		useCallback: (fn: unknown, deps?: readonly unknown[]) =>
			memo(() => fn, deps),
		useEffect: (
			run: () => undefined | (() => void),
			deps?: readonly unknown[],
		) => {
			const index = hooks.cursor++;
			const slot = hooks.slots[index] as EffectSlot | undefined;
			if (slot && same(slot.deps, deps)) return;
			hooks.pending.push({ index, run, deps });
		},
	};
});
vi.mock("./ciphertext-staging.ts", () => ({
	recoverCiphertextStages: async () => undefined,
}));
vi.mock("./derive.ts", () => ({
	createDeriver: () => ({ derive: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("./device-id.ts", () => ({ deviceId: () => "device-1" }));
vi.mock("./device-store.ts", () => ({
	createDeviceStore: () => ({ clearDeviceKey: vi.fn() }),
}));
vi.mock("./runtime.ts", () => ({ browserE2eRuntime: {} }));
vi.mock("./keyring.ts", () => ({
	createKeyring: () => ({
		state: () => fixture.keyState,
		wdkFor: (workspaceId: string, version: number) =>
			fixture.keyState === "ready"
				? fixture.wdks.get(`${workspaceId}:${version}`)
				: undefined,
		putWdk: vi.fn(),
		privateKey: () => new Uint8Array(32),
	}),
}));
vi.mock("./session.ts", () => ({
	createSession: () => ({
		state: () => fixture.keyState,
		adoptIdentity: async () => undefined,
		setAutoLockMinutes: () => undefined,
		lockNow: () => {
			fixture.keyState = "locked";
		},
		unlock: async () => undefined,
		signOut: async () => undefined,
		enrolled: async () => undefined,
	}),
}));
vi.mock("./workspace-keys.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./workspace-keys.ts")>()),
	reconcileWorkspaceKeys: fixture.reconcile,
}));

const { KeyringProvider } = await import("./KeyringProvider.tsx");

const WDK = new Uint8Array(32).map((_, index) => (index * 7 + 3) & 0xff);
const POLL_MS = 15_000;
let recipient: Awaited<ReturnType<typeof generateIdentityKeyPair>>;
let props: Parameters<typeof KeyringProvider>[0];
let value: { lockNow: () => void } | undefined;
let pendingResponse: (signal?: AbortSignal) => Promise<Response>;
let grantResponse: (requestId: string) => Response;
const page = { hidden: false, listeners: new Set<() => void>() };
function setHidden(hidden: boolean) {
	page.hidden = hidden;
	for (const listener of page.listeners) listener();
}
const grantBodies: Array<Record<string, string>> = [];
const signals: AbortSignal[] = [];
const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
	const path = String(input);
	if (init?.signal) signals.push(init.signal);
	if (init?.signal?.aborted)
		throw new DOMException("The operation was aborted.", "AbortError");
	if (path === "/api/e2e/identity")
		return Response.json({
			enrolled: true,
			publicKey: "owner-public-key",
			formatVersion: 1,
			passphraseWrapped: "wrapped",
			passphraseSalt: "salt",
		});
	if (path === "/api/e2e/grants/pending")
		return await pendingResponse(init?.signal ?? undefined);
	if (path === "/api/e2e/grants") {
		const body = JSON.parse(String(init?.body));
		grantBodies.push(body);
		return grantResponse(body.requestId);
	}
	throw new Error(`unexpected fetch ${path}`);
});

function render() {
	hooks.cursor = 0;
	const element = KeyringProvider(props) as {
		props: { value: { lockNow: () => void } };
	};
	value = element.props.value;
	const effects = hooks.pending.splice(0);
	for (const effect of effects) {
		(hooks.slots[effect.index] as EffectSlot | undefined)?.cleanup?.();
		const cleanup = effect.run();
		hooks.slots[effect.index] = {
			deps: effect.deps,
			cleanup: typeof cleanup === "function" ? cleanup : undefined,
		};
	}
}

// WebCrypto settles on the real event loop, which fake timers do not drive.
const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(predicate: () => boolean) {
	for (let turn = 0; turn < 5_000 && !predicate(); turn++) {
		await realTurn();
		await vi.advanceTimersByTimeAsync(0);
	}
}

async function settle(ms = 0) {
	await vi.advanceTimersByTimeAsync(ms);
	for (let round = 0; round < 50; round++) {
		await realTurn();
		await vi.advanceTimersByTimeAsync(0);
		if (hooks.dirty) {
			hooks.dirty = false;
			render();
		}
	}
}

function unmount() {
	for (const slot of hooks.slots) {
		const effect = slot as EffectSlot | undefined;
		if (effect && "cleanup" in effect) effect.cleanup?.();
	}
}

const pendingPaths = () =>
	fetcher.mock.calls.filter(([input]) => input === "/api/e2e/grants/pending");

function request(
	publicKey: string | null = encodeBytes(recipient.publicKey),
	ids = ["kgr_1"],
) {
	return Response.json({
		requests: ids.map((requestId) => ({
			requestId,
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "member-1",
			recipientPublicKey: publicKey,
			requestedAt: "2026-10-22T12:00:00.000Z",
		})),
	});
}

beforeEach(async () => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	hooks.cursor = 0;
	hooks.slots = [];
	hooks.pending = [];
	hooks.dirty = false;
	fixture.keyState = "ready";
	fixture.wdks = new Map([["ws_1:1", WDK]]);
	fixture.reconcile.mockReset().mockResolvedValue([]);
	recipient ??= await generateIdentityKeyPair();
	pendingResponse = async () => Response.json({ requests: [] });
	grantResponse = (requestId) =>
		Response.json({ requestId, outcome: "granted" });
	page.hidden = false;
	page.listeners.clear();
	vi.stubGlobal("document", {
		get hidden() {
			return page.hidden;
		},
		addEventListener: (_type: string, listener: () => void) =>
			page.listeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) =>
			page.listeners.delete(listener),
	});
	grantBodies.length = 0;
	signals.length = 0;
	fetcher.mockClear();
	vi.stubGlobal("window", {
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	});
	vi.stubGlobal("navigator", { onLine: true });
	props = {
		userId: "owner-1",
		autoLockMinutes: null,
		runtime: { fetcher, signOut: vi.fn() } as unknown as E2eRuntime,
		children: null,
	};
	render();
	await settle();
	expect(fixture.reconcile).toHaveBeenCalledTimes(1);
	fixture.reconcile.mockClear();
});
afterEach(() => {
	unmount();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("fulfils a request created after unlock without a reload", async () => {
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(1);
	expect(grantBodies).toEqual([]);

	pendingResponse = async () => request();
	await settle(POLL_MS);
	await until(() => grantBodies.length > 0);
	expect(grantBodies).toHaveLength(1);
	expect(grantBodies[0]).toMatchObject({
		requestId: "kgr_1",
		recipientPublicKey: encodeBytes(recipient.publicKey),
	});
	const opened = await openWdk(
		{
			enc: decodeBytes(grantBodies[0]?.enc ?? ""),
			ciphertext: decodeBytes(grantBodies[0]?.ciphertext ?? ""),
		},
		await importRecipientPrivateKey(recipient.privateKey),
		{
			workspaceId: "ws_1",
			keyVersion: 1,
			recipientUserId: "member-1",
			recipientFingerprint: await publicKeyFingerprint(recipient.publicKey),
		},
	);
	expect(opened).toEqual(WDK);
	expect(fixture.reconcile).not.toHaveBeenCalled();
});

it("skips a tick while a reconcile is running and never overlaps itself", async () => {
	let finishReconcile = () => {};
	fixture.reconcile.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishReconcile = () => resolve([]);
			}),
	);
	const refreshing = (
		value as unknown as { refreshWorkspaceKeys: () => Promise<void> }
	).refreshWorkspaceKeys();
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(0);
	finishReconcile();
	await refreshing;

	let release = () => {};
	pendingResponse = () =>
		new Promise((resolve) => {
			release = () => resolve(request());
		});
	await settle(POLL_MS);
	// Held past one interval but inside the pass timeout.
	await settle(19_000);
	expect(pendingPaths()).toHaveLength(1);
	release();
	await until(() => grantBodies.length > 0);
	await settle(0);
	expect(grantBodies).toHaveLength(1);
});

it("stops on lock and aborts its request on unmount", async () => {
	value?.lockNow();
	await settle(POLL_MS * 4);
	expect(pendingPaths()).toHaveLength(0);

	fixture.keyState = "ready";
	// The state poll notices the unlock; the fulfilment pass follows it.
	await settle(POLL_MS);
	pendingResponse = () => new Promise(() => {});
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(1);
	const inFlight = signals.at(-1);
	expect(inFlight?.aborted).toBe(false);
	unmount();
	expect(inFlight?.aborted).toBe(true);
	await settle(POLL_MS * 4);
	expect(pendingPaths()).toHaveLength(1);
});

it("surfaces a failing pass and backs off instead of looping", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	pendingResponse = async () => new Response("nope", { status: 500 });
	await settle(POLL_MS);
	expect(error).toHaveBeenCalledWith(
		"e2e: grant fulfilment failed",
		expect.objectContaining({ message: expect.stringContaining("500") }),
	);
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(1);
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(2);
});

it("reconciles once for a version it holds but has not loaded", async () => {
	fixture.wdks.clear();
	pendingResponse = async () => request();
	await settle(POLL_MS);
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(2);
	expect(fixture.reconcile).toHaveBeenCalledTimes(1);
	expect(grantBodies).toEqual([]);
});

it.each([
	[409, "conflict"],
	[404, "no-request"],
])("skips a request another holder won (%i %s) and serves the rest", async (status, reason) => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	grantResponse = (requestId) =>
		requestId === "kgr_1"
			? new Response(reason, { status })
			: Response.json({ requestId, outcome: "granted" });
	pendingResponse = async () =>
		request(encodeBytes(recipient.publicKey), ["kgr_1", "kgr_2"]);
	await settle(POLL_MS);
	await until(() => grantBodies.length === 2);
	await settle(0);
	expect(grantBodies.map((body) => body.requestId)).toEqual(["kgr_1", "kgr_2"]);
	expect(error).not.toHaveBeenCalled();
	// No backoff: the next pass runs on the normal cadence.
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(2);
});

it("still fails a pass on any other grant refusal", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	grantResponse = () => new Response("inactive-version", { status: 409 });
	pendingResponse = async () => request();
	await settle(POLL_MS);
	await until(() => error.mock.calls.length > 0);
	expect(error).toHaveBeenCalledWith(
		"e2e: grant fulfilment failed",
		expect.objectContaining({ message: expect.stringContaining("409") }),
	);
});

it("times out a stalled pass so a waiting file pick is released", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	pendingResponse = (signal) =>
		new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () =>
				reject(new DOMException("The operation was aborted.", "AbortError")),
			);
		});
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(1);
	let picked = false;
	void (
		value as unknown as {
			workspaceKey: (workspaceId: string) => Promise<unknown>;
		}
	)
		.workspaceKey("ws_1")
		.then(() => {
			picked = true;
		});
	await settle(5_000);
	expect(picked).toBe(false);
	await settle(20_000);
	expect(picked).toBe(true);
	expect(error).toHaveBeenCalledWith(
		"e2e: grant fulfilment failed",
		expect.objectContaining({ message: "e2e: grant fulfilment timed out" }),
	);
});

it("pauses while the page is hidden and checks at once on return", async () => {
	setHidden(true);
	await settle(POLL_MS * 4);
	expect(pendingPaths()).toHaveLength(0);
	setHidden(false);
	await settle(0);
	expect(pendingPaths()).toHaveLength(1);
	await settle(POLL_MS);
	expect(pendingPaths()).toHaveLength(2);
});
