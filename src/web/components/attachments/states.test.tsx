import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentGateController } from "./states.tsx";

type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
type Pending = {
	index: number;
	run: () => undefined | (() => void);
	deps?: readonly unknown[];
};

// Drives the gate hook without a DOM: state and refs persist across renders,
// effects commit after each render when their dependencies change.
const hooks = vi.hoisted(() => ({
	cursor: 0,
	slots: [] as unknown[],
	pending: [] as Pending[],
	dirty: false,
}));
const fixture = vi.hoisted(() => ({
	key: null as null | { workspaceId: string; keyVersion: number },
	workspaceKey: vi.fn(),
	refreshWorkspaceKeys: vi.fn(),
	keyring: {} as Record<string, unknown>,
	grants: vi.fn(),
	props: { workspaceId: "ws_1", scope: "task:a" },
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
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: "member-1" }),
	useQuery: () => [[{ id: "ws_1", rotationRequired: false }]],
}));
vi.mock("../../../zero/queries.ts", () => ({
	queries: { workspaces: { mine: () => ({}) } },
}));
vi.mock("../../../paraglide/messages.js", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("../../lib/e2e/KeyringProvider.tsx", () => ({
	useKeyring: () => fixture.keyring,
}));
vi.mock("../../lib/e2e/attachment-api.ts", () => ({
	fetchAttachmentConfig: async () => ({ maxFileBytes: 1_000_000 }),
	fetchMyGrants: fixture.grants,
}));
vi.mock("../e2e/EnrollmentWizard.tsx", () => ({ EnrollmentWizard: "wizard" }));
vi.mock("../e2e/UnlockDialog.tsx", () => ({ UnlockDialog: "unlock" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/dialog", () => ({}));

// Renamed so the test renderer is not mistaken for a component calling a hook.
const { useAttachmentGate: attachmentGate } = await import("./states.tsx");

const WAIT_MS = 10_000;
let gate: AttachmentGateController;

function render() {
	hooks.cursor = 0;
	gate = attachmentGate(fixture.props.workspaceId, fixture.props.scope);
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

async function settle(ms = 0) {
	await vi.advanceTimersByTimeAsync(ms);
	for (let round = 0; round < 20; round++) {
		await vi.advanceTimersByTimeAsync(0);
		if (!hooks.dirty) break;
		hooks.dirty = false;
		render();
	}
}

function unmount() {
	for (const slot of hooks.slots) {
		const effect = slot as EffectSlot | undefined;
		if (effect && "cleanup" in effect) effect.cleanup?.();
	}
}

const file = new File(["member upload"], "member.txt", { type: "text/plain" });

async function select(action = vi.fn()) {
	const started = gate.runWithFiles([file], action);
	await settle();
	expect(await started).toBe(false);
	await settle();
	return action;
}

beforeEach(() => {
	vi.useFakeTimers();
	hooks.cursor = 0;
	hooks.slots = [];
	hooks.pending = [];
	hooks.dirty = false;
	fixture.key = null;
	fixture.workspaceKey.mockReset().mockImplementation(async () => fixture.key);
	fixture.refreshWorkspaceKeys.mockReset().mockResolvedValue(undefined);
	fixture.grants.mockReset().mockResolvedValue([]);
	fixture.props = { workspaceId: "ws_1", scope: "task:a" };
	fixture.keyring = {
		state: "ready",
		runtime: { fetcher: vi.fn() },
		workspaceKey: fixture.workspaceKey,
		refreshWorkspaceKeys: fixture.refreshWorkspaceKeys,
	};
	vi.stubGlobal("navigator", { onLine: true });
	render();
});
afterEach(() => {
	unmount();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("keeps a selection waiting for its grant and completes it when the key arrives", async () => {
	const action = await select();
	expect(gate.error).toBe("attachment_key_pending");
	expect(action).not.toHaveBeenCalled();

	await settle(WAIT_MS);
	expect(action).not.toHaveBeenCalled();
	fixture.key = { workspaceId: "ws_1", keyVersion: 1 };
	await settle(WAIT_MS);
	expect(action).toHaveBeenCalledTimes(1);
	expect(action).toHaveBeenCalledWith(fixture.key, [file], true);
	expect(gate.error).toBeNull();
	expect(gate.hasPendingAction()).toBe(false);

	const calls = fixture.workspaceKey.mock.calls.length;
	await settle(WAIT_MS * 5);
	expect(fixture.workspaceKey).toHaveBeenCalledTimes(calls);
	expect(action).toHaveBeenCalledTimes(1);
});

it("stops waiting on unmount, on lock, and after the budget", async () => {
	await select();
	const calls = () => fixture.workspaceKey.mock.calls.length;
	const before = calls();
	await settle(WAIT_MS);
	expect(calls()).toBe(before + 1);

	fixture.keyring = { ...fixture.keyring, state: "locked" };
	render();
	await settle(WAIT_MS * 3);
	expect(calls()).toBe(before + 1);

	fixture.keyring = { ...fixture.keyring, state: "ready" };
	render();
	await settle(WAIT_MS * 100);
	// The restarted wait gets its own budget of sixty runs, then says it stopped.
	expect(calls()).toBe(before + 1 + 60);
	expect(gate.error).toBe("attachment_key_wait_expired");
	expect(gate.hasPendingAction()).toBe(false);

	const action = await select();
	const restarted = calls();
	unmount();
	fixture.key = { workspaceId: "ws_1", keyVersion: 1 };
	await settle(WAIT_MS * 3);
	expect(calls()).toBe(restarted);
	expect(action).not.toHaveBeenCalled();
});

it("runs only the newest selection once its key arrives", async () => {
	const first = await select();
	const second = await select();
	fixture.key = { workspaceId: "ws_1", keyVersion: 1 };
	await settle(WAIT_MS);
	expect(first).not.toHaveBeenCalled();
	expect(second).toHaveBeenCalledTimes(1);
});

it.each([
	["another task", { workspaceId: "ws_1", scope: "task:b" }],
	["another workspace", { workspaceId: "ws_2", scope: "task:a" }],
])("abandons a waiting selection when the user moves to %s", async (_name, next) => {
	const action = await select();
	fixture.props = next;
	render();
	await settle();
	expect(gate.error).toBe("attachment_key_wait_moved");
	expect(gate.hasPendingAction()).toBe(false);
	fixture.key = { workspaceId: next.workspaceId, keyVersion: 1 };
	await settle(WAIT_MS * 3);
	expect(action).not.toHaveBeenCalled();
	expect(
		fixture.workspaceKey.mock.calls.every(
			([workspace]) => workspace === "ws_1",
		),
	).toBe(true);
});

it("never runs a selection whose key arrives after the user moved", async () => {
	const action = await select();
	let release!: () => void;
	fixture.workspaceKey.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ workspaceId: "ws_1", keyVersion: 1 });
			}),
	);
	await vi.advanceTimersByTimeAsync(WAIT_MS);
	// The move renders while the retry is in flight, before any effect runs.
	fixture.props = { workspaceId: "ws_2", scope: "task:b" };
	hooks.cursor = 0;
	gate = attachmentGate(fixture.props.workspaceId, fixture.props.scope);
	release();
	await vi.advanceTimersByTimeAsync(0);
	expect(action).not.toHaveBeenCalled();
	expect(gate.hasPendingAction()).toBe(false);
	await settle();
	expect(gate.error).toBe("attachment_key_wait_moved");
});

it("refuses a key that belongs to another workspace", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const action = await select();
	fixture.key = { workspaceId: "ws_2", keyVersion: 1 };
	await settle(WAIT_MS);
	expect(action).not.toHaveBeenCalled();
	expect(gate.error).toBe("attachment_error_upload_failed");
	expect(console.error).toHaveBeenCalled();
});

it("checks its own request cheaply before a full retry", async () => {
	const action = await select();
	const before = fixture.workspaceKey.mock.calls.length;
	fixture.grants.mockResolvedValue([
		{ workspaceId: "ws_1", keyVersion: 1, state: "pending" },
	]);
	await settle(WAIT_MS * 3);
	expect(fixture.grants).toHaveBeenCalledTimes(3);
	expect(fixture.workspaceKey).toHaveBeenCalledTimes(before);
	fixture.grants.mockResolvedValue([
		{ workspaceId: "ws_1", keyVersion: 1, state: "ready" },
	]);
	fixture.key = { workspaceId: "ws_1", keyVersion: 1 };
	await settle(WAIT_MS);
	expect(fixture.workspaceKey).toHaveBeenCalledTimes(before + 1);
	expect(action).toHaveBeenCalledOnce();
});

it("tells the action whether the retry was automatic or the user's resume", async () => {
	const action = await select();
	fixture.key = { workspaceId: "ws_1", keyVersion: 1 };
	await gate.resume();
	expect(action).toHaveBeenCalledExactlyOnceWith(fixture.key, [file], false);
});
