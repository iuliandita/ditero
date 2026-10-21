import { setImmediate } from "node:timers";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_FOCUS } from "./timer-core.ts";
import { accessFocusState, focusStorageKey } from "./timer-persistence.ts";
import { FocusProvider, type FocusTimerApi } from "./useFocusTimer.tsx";

type Effect = {
	deps: unknown[];
	cleanup?: () => void;
};
type Tab = {
	hooks: unknown[];
	cursor: number;
	dirty: boolean;
	effects: (() => void)[];
	api: FocusTimerApi;
	userID: string;
	scope?: string;
};
const fixture = vi.hoisted(() => ({
	active: null as Tab | null,
	mutate: vi.fn(),
	pref: { focus: { autoCycle: false } },
	loading: false,
}));

// Run each tab's real provider with isolated hook state and shared storage.
vi.mock("react", async (original) => {
	const react = await original<typeof import("react")>();
	function slot() {
		const tab = fixture.active;
		if (!tab) throw new Error("No active tab");
		return { tab, index: tab.cursor++ };
	}
	function memo(read: () => unknown, deps: unknown[]) {
		const { tab, index } = slot();
		const old = tab.hooks[index] as
			| { deps: unknown[]; value: unknown }
			| undefined;
		if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
			tab.hooks[index] = { deps, value: read() };
		}
		return (tab.hooks[index] as { value: unknown }).value;
	}
	return {
		...react,
		useState(initial: unknown) {
			const { tab, index } = slot();
			if (!(index in tab.hooks)) {
				tab.hooks[index] = typeof initial === "function" ? initial() : initial;
			}
			return [
				tab.hooks[index],
				(update: unknown) => {
					const next =
						typeof update === "function" ? update(tab.hooks[index]) : update;
					if (!Object.is(next, tab.hooks[index])) tab.dirty = true;
					tab.hooks[index] = next;
				},
			];
		},
		useRef(initial: unknown) {
			const { tab, index } = slot();
			tab.hooks[index] ??= { current: initial };
			return tab.hooks[index];
		},
		useMemo: memo,
		useCallback: (callback: unknown, deps: unknown[]) =>
			memo(() => callback, deps),
		useEffect(run: () => undefined | (() => void), deps: unknown[]) {
			const { tab, index } = slot();
			const old = tab.hooks[index] as Effect | undefined;
			if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
				tab.effects.push(() => {
					old?.cleanup?.();
					tab.hooks[index] = { deps, cleanup: run() };
				});
			}
		},
	};
});
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: fixture.active?.userID, mutate: fixture.mutate }),
}));
vi.mock("../hooks/useUserPref.ts", () => ({
	useUserPref: () => ({ pref: fixture.pref, loading: fixture.loading }),
}));
vi.mock("../lib/native-account.tsx", () => ({
	useNativeAccount: () => ({ storageScope: fixture.active?.scope }),
}));
vi.mock("../../zero/mutators.ts", () => ({
	mutators: { focus: { logSession: (args: unknown) => args } },
}));

const { mutators: actualMutators } = await vi.importActual<
	typeof import("../../zero/mutators.ts")
>("../../zero/mutators.ts");

const tabs: Tab[] = [];
const data = new Map<string, string>();
const storage = {
	getItem: (key: string) => data.get(key) ?? null,
	setItem: (key: string, value: string) => data.set(key, value),
	removeItem: (key: string) => data.delete(key),
};
function render(tab: Tab) {
	let renders = 0;
	do {
		if (++renders > 20) throw new Error("Provider failed to settle");
		tab.cursor = 0;
		tab.dirty = false;
		tab.effects = [];
		fixture.active = tab;
		tab.api = (
			FocusProvider({ children: null }) as ReactElement<{
				value: FocusTimerApi;
			}>
		).props.value;
		for (const effect of tab.effects) effect();
	} while (tab.dirty);
	fixture.active = null;
}
function open(userID = "owner", scope?: string) {
	const tab = {
		hooks: [],
		cursor: 0,
		dirty: true,
		effects: [],
		api: {} as FocusTimerApi,
		userID,
		scope,
	} satisfies Tab;
	tabs.push(tab);
	render(tab);
	return tab;
}
function close(tab: Tab) {
	for (const hook of tab.hooks) (hook as Effect | undefined)?.cleanup?.();
	tabs.splice(tabs.indexOf(tab), 1);
}
async function storageEvent(key: string | null) {
	window.dispatchEvent(
		Object.assign(new Event("storage"), { key, storageArea: storage }),
	);
	await settle();
}
async function settle() {
	for (let i = 0; i < 20; i++) {
		await accessFocusState(focusStorageKey("owner"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		const dirty = tabs.filter((tab) => tab.dirty);
		for (const tab of dirty) render(tab);
		if (!dirty.length) return;
	}
	throw new Error("Provider failed to settle asynchronous actions");
}
async function stored(userID = "owner", scope?: string) {
	return (await accessFocusState(focusStorageKey(userID, scope))).state;
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"Date",
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
		],
	});
	vi.setSystemTime(10000);
	vi.stubGlobal("indexedDB", new IDBFactory());
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("localStorage", storage);
	vi.stubGlobal("__diteroFocusTestSec", 10);
	vi.stubGlobal("BroadcastChannel", undefined);
	vi.stubGlobal("navigator", {});
	vi.stubGlobal("crypto", {
		getRandomValues: crypto.getRandomValues.bind(crypto),
	});
	fixture.pref.focus = { ...DEFAULT_FOCUS, autoCycle: false };
	fixture.loading = false;
	fixture.mutate.mockReset().mockReturnValue({
		client: Promise.resolve({ type: "success" }),
	});
	data.clear();
});
afterEach(async () => {
	for (const tab of [...tabs]) close(tab);
	await settle();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("running and paused task intervals survive reload without tick writes", async () => {
	let tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
	const original = await stored();
	const writes = vi.spyOn(IDBObjectStore.prototype, "put");
	const notifications = vi.spyOn(storage, "setItem");
	vi.advanceTimersByTime(1250);
	render(tab);
	await settle();
	expect(tab.api.session?.remainingSec).toBe(9);
	expect(writes).not.toHaveBeenCalled();
	expect(notifications).not.toHaveBeenCalled();
	expect(await stored()).toEqual(original);
	close(tab);
	tab = open();
	await settle();
	expect(tab.api.session).toMatchObject({
		intervalId: original.session?.intervalId,
		boundTaskId: "task",
		boundTaskTitle: "Read",
		remainingSec: 9,
		running: true,
	});
	tab.api.pause();
	await settle();
	const paused = await stored();
	vi.advanceTimersByTime(5000);
	close(tab);
	tab = open();
	await settle();
	expect(tab.api.session).toMatchObject({
		intervalId: original.session?.intervalId,
		remainingSec: 9,
		running: false,
	});
	tab.api.start();
	await settle();
	expect(tab.api.session).toMatchObject({
		intervalId: original.session?.intervalId,
		remainingSec: 9,
		running: true,
	});
	expect((await stored()).revision).toBe(paused.revision + 1);
});

test("Stop during another tab's tick cannot revive the interval", async () => {
	const first = open();
	first.api.start();
	await settle();
	const stale = open();
	await settle();
	const put = IDBObjectStore.prototype.put;
	let midTick = false;
	vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
		this: IDBObjectStore,
		value,
		key,
	) {
		if (value.session === null && !midTick) {
			midTick = true;
			vi.advanceTimersByTime(250);
			render(stale);
		}
		return put.call(this, value, key);
	});
	first.api.reset();
	await settle();
	expect(midTick).toBe(true);
	await storageEvent(focusStorageKey("owner"));
	vi.advanceTimersByTime(15000);
	await settle();
	expect((await stored()).session).toBeNull();
	expect(first.api.session).toBeNull();
	expect(stale.api.session).toBeNull();
	expect(fixture.mutate).not.toHaveBeenCalled();
});

test("Stop reads the latest interval even before a storage event reaches a stale tab", async () => {
	const stale = open();
	stale.api.start();
	await settle();
	const first = open();
	await settle();
	const oldInterval = stale.api.session?.intervalId;
	first.api.skip();
	await settle();
	expect(first.api.session?.cycle.phase).toBe("break");
	expect(stale.api.session?.intervalId).toBe(oldInterval);
	stale.api.reset();
	await settle();
	expect((await stored()).session).toBeNull();
	await storageEvent(focusStorageKey("owner"));
	expect(first.api.session).toBeNull();
	expect(stale.api.session).toBeNull();
	expect(fixture.mutate).not.toHaveBeenCalled();
});

test("storage events follow the newest revision while accounts and servers stay isolated", async () => {
	const first = open();
	first.api.start();
	await settle();
	const follower = open();
	const other = open("other");
	const native = open("owner", "another-server");
	await settle();
	other.api.start();
	native.api.start();
	first.api.pause();
	await settle();
	await storageEvent(focusStorageKey("owner"));
	expect(follower.api.session?.running).toBe(false);
	first.api.start();
	await settle();
	await storageEvent(focusStorageKey("owner"));
	// Even an old queued notification reads the latest committed revision.
	storage.setItem(focusStorageKey("owner"), "1");
	await storageEvent(focusStorageKey("owner"));
	expect(follower.api.session?.running).toBe(true);
	expect(other.api.session?.running).toBe(true);
	expect(native.api.session?.running).toBe(true);
	const current = await stored();
	expect((await stored("other")).session?.intervalId).not.toBe(
		current.session?.intervalId,
	);
	expect(
		(await stored("owner", "another-server")).session?.intervalId,
	).not.toBe(current.session?.intervalId);
});

test("expired reload completes once across two tabs before preferences finish loading", async () => {
	const tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
	const intervalId = tab.api.session?.intervalId;
	close(tab);
	vi.advanceTimersByTime(15000);
	fixture.pref.focus = { ...DEFAULT_FOCUS, autoCycle: true };
	fixture.loading = true;
	const first = open();
	const second = open();
	await settle();
	await storageEvent(focusStorageKey("owner"));
	expect(first.api.session).toMatchObject({
		cycle: { phase: "break" },
		running: false,
	});
	expect(second.api.session).toMatchObject({
		cycle: { phase: "break" },
		running: false,
	});
	expect((await stored()).pendingCompletions).toEqual([]);
	expect(fixture.mutate.mock.calls[0][0]).toEqual({
		intervalId,
		taskId: "task",
		kind: "work",
		startedAt: 10000,
		endedAt: 20000,
		durationSec: 10,
	});
	// A follower may replay the intent before its peer acknowledges the commit.
	expect(
		fixture.mutate.mock.calls.every(([args]) => args.intervalId === intervalId),
	).toBe(true);
	const completed = await stored();
	close(first);
	close(second);
	open();
	await settle();
	expect(await stored()).toEqual(completed);
});

test.each([
	"failure",
	"reload-before-result",
	"reload-after-commit",
])("replays a stable pending completion once after %s", async (interruption) => {
	vi.stubGlobal("__diteroFocusTestSec", 2);
	let finish!: (value: unknown) => void;
	fixture.mutate.mockReturnValueOnce({
		client: new Promise((resolve) => {
			finish = resolve;
		}),
	});
	const tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
	const intervalId = tab.api.session?.intervalId;
	vi.advanceTimersByTime(2000);
	await settle();
	expect(fixture.mutate).toHaveBeenCalledOnce();
	const completion = {
		intervalId,
		taskId: "task",
		kind: "work",
		startedAt: 10000,
		endedAt: 12000,
		durationSec: 2,
	};
	expect((await stored()).pendingCompletions).toEqual([completion]);
	expect((await stored()).session?.cycle.phase).toBe("break");
	if (interruption === "failure") {
		vi.spyOn(console, "error").mockImplementation(() => {});
		finish({ type: "error", error: { type: "zero", message: "closed" } });
		await settle();
		tab.api.reset();
		await settle();
		expect((await stored()).pendingCompletions).toEqual([completion]);
	} else if (interruption === "reload-after-commit") {
		close(tab);
		finish({ type: "success" });
		await settle();
	}
	if (tabs.includes(tab)) close(tab);
	let finishReplay!: (value: unknown) => void;
	fixture.mutate.mockReturnValue({
		client: new Promise((resolve) => {
			finishReplay = resolve;
		}),
	});
	const reloaded = open();
	await settle();
	expect(fixture.mutate).toHaveBeenCalledTimes(2);
	expect(fixture.mutate.mock.calls.map(([args]) => args)).toEqual([
		completion,
		completion,
	]);
	vi.advanceTimersByTime(3000);
	await settle();
	expect(fixture.mutate).toHaveBeenCalledTimes(2);
	expect((await stored()).pendingCompletions).toEqual([completion]);
	reloaded.api.reset();
	await settle();
	finishReplay({ type: "success" });
	await settle();
	expect((await stored()).pendingCompletions).toEqual([]);
	expect((await stored()).session).toBeNull();
	close(reloaded);
	open();
	await settle();
	expect(fixture.mutate).toHaveBeenCalledTimes(2);

	type LogInput = Parameters<typeof actualMutators.focus.logSession.fn>[0];
	const rows: { id: string }[] = [];
	const insert = vi.fn(async (row: { id: string }) => {
		rows.push(row);
	});
	const tx = {
		run: async () => rows[0],
		mutate: { focusSession: { insert } },
	} as unknown as LogInput["tx"];
	for (const [args] of fixture.mutate.mock.calls) {
		await actualMutators.focus.logSession.fn({
			tx,
			ctx: { id: "owner" },
			args,
		});
	}
	expect(insert).toHaveBeenCalledOnce();
	expect(rows[0].id).toBe(`owner:${intervalId}`);
});
