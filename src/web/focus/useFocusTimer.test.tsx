import { setImmediate } from "node:timers";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FocusEarlyError } from "../../domain/focus-interval.ts";
import { m } from "../../paraglide/messages.js";
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
	starts: {
		rows: [] as { userId: string; intervalId: string }[],
		type: "complete" as "complete" | "unknown",
	},
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
	useQuery: () => [fixture.starts.rows, { type: fixture.starts.type }],
}));
vi.mock("../hooks/useUserPref.ts", () => ({
	useUserPref: () => ({ pref: fixture.pref, loading: fixture.loading }),
}));
vi.mock("../lib/native-account.tsx", () => ({
	useNativeAccount: () => ({ storageScope: fixture.active?.scope }),
}));
vi.mock("../../zero/mutators.ts", () => ({
	mutators: {
		focus: {
			logSession: (args: unknown) => args,
			startInterval: (args: { intervalId: string }) => ({
				startInterval: args,
			}),
		},
	},
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
// Delivers the account's synced start rows (and whether the query is settled).
async function syncStarts(
	intervalIds: string[],
	type: "complete" | "unknown" = "complete",
) {
	fixture.starts = {
		rows: intervalIds.map((intervalId) => ({ userId: "owner", intervalId })),
		type,
	};
	for (const tab of tabs) tab.dirty = true;
	await settle();
}
async function stored(userID = "owner", scope?: string) {
	return (await accessFocusState(focusStorageKey(userID, scope))).state;
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: [
			"Date",
			"performance",
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
	// Offline by default: no server start, so these cases exercise the
	// monotonic-proof gate. Server-started intervals are covered separately.
	vi.stubGlobal("navigator", { onLine: false });
	vi.stubGlobal("crypto", {
		getRandomValues: crypto.getRandomValues.bind(crypto),
	});
	fixture.pref.focus = { ...DEFAULT_FOCUS, autoCycle: false };
	fixture.loading = false;
	fixture.starts = { rows: [], type: "complete" };
	fixture.mutate.mockReset().mockReturnValue({
		client: Promise.resolve({ type: "success" }),
		server: Promise.resolve({ type: "success" }),
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

test.each([
	"start",
	"startForTask",
] as const)("%s starts from a fresh clock after the page has been idle", async (action) => {
	const tab = open();
	await settle();
	vi.advanceTimersByTime(60000);
	if (action === "startForTask") tab.api.startForTask("task", "Read");
	else tab.api.start();
	await settle();
	expect(tab.api.session).toMatchObject({
		cycle: { phase: "work" },
		running: true,
		remainingSec: 10,
	});
	expect(fixture.mutate).not.toHaveBeenCalled();
	vi.advanceTimersByTime(2000);
	await settle();
	expect(tab.api.session?.remainingSec).toBe(8);
	vi.advanceTimersByTime(8000);
	await settle();
	expect(fixture.mutate).toHaveBeenCalledOnce();
});

test("resume starts from a fresh clock after a long pause", async () => {
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	await settle();
	tab.api.pause();
	await settle();
	const intervalId = tab.api.session?.intervalId;
	expect(tab.api.session?.remainingSec).toBe(8);
	vi.advanceTimersByTime(60000);
	tab.api.start();
	await settle();
	expect(tab.api.session).toMatchObject({
		intervalId,
		cycle: { phase: "work" },
		running: true,
		remainingSec: 8,
	});
	expect(fixture.mutate).not.toHaveBeenCalled();
	vi.advanceTimersByTime(2000);
	await settle();
	expect(tab.api.session?.remainingSec).toBe(6);
	vi.advanceTimersByTime(6000);
	await settle();
	expect(fixture.mutate).toHaveBeenCalledOnce();
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

test("expired reload advances across two tabs without crediting unobserved time", async () => {
	const tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
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
	expect(fixture.mutate).not.toHaveBeenCalled();
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
		client: Promise.resolve({ type: "success" }),
		server: new Promise((resolve) => {
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
		client: Promise.resolve({ type: "success" }),
		server: new Promise((resolve) => {
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

test.each([
	"success",
	"app",
	"zero",
] as const)("keeps the replay intent after local acknowledgement until server %s", async (outcome) => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	let finish!: (result: unknown) => void;
	fixture.mutate.mockReturnValue({
		client: Promise.resolve({ type: "success" }),
		server: new Promise((resolve) => {
			finish = resolve;
		}),
	});
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(10000);
	await settle();
	const pending = (await stored()).pendingCompletions;
	expect(pending).toHaveLength(1);
	finish(
		outcome === "success"
			? { type: "success" }
			: {
					type: "error",
					error: { type: outcome, message: "refused" },
				},
	);
	await settle();
	expect((await stored()).pendingCompletions).toEqual(
		outcome === "zero" ? pending : [],
	);
	expect(tab.api.error).toBe(
		outcome === "app"
			? "This interval couldn't be saved. It won't be retried."
			: null,
	);
	close(tab);
	open();
	await settle();
	expect(fixture.mutate).toHaveBeenCalledTimes(outcome === "zero" ? 2 : 1);
});

test.each([
	-3000, 3000,
])("pause/resume completes after a %i ms wall-clock correction", async (correction) => {
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	tab.api.pause();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(8);
	vi.setSystemTime(Date.now() + correction);
	close(tab);
	tab = open();
	await settle();
	tab.api.start();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(8);
	close(tab);
	tab = open();
	await settle();
	vi.advanceTimersByTime(8000);
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(fixture.mutate).toHaveBeenCalledOnce();
	const completion = fixture.mutate.mock.calls[0][0];
	expect(completion.durationSec).toBe(10);
	expect(completion.endedAt - completion.startedAt).toBe(10000);
	expect((await stored()).pendingCompletions).toEqual([]);
});

test.each([
	-60000, 60000,
])("running elapsed time ignores a %i ms wall-clock correction", async (correction) => {
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	await settle();
	vi.setSystemTime(Date.now() + correction);
	vi.advanceTimersByTime(1000);
	await settle();
	expect(tab.api.session?.remainingSec).toBe(7);
	tab.api.pause();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(7);
	vi.setSystemTime(100000);
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(7000);
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(fixture.mutate).toHaveBeenCalledOnce();
});

test("a backward clock correction across reload cannot grow the remaining interval", async () => {
	let tab = open();
	tab.api.start();
	await settle();
	close(tab);
	vi.setSystemTime(5000);
	tab = open();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(10);
	tab.api.pause();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(10);
	expect((await stored()).session?.running).toBe(false);
});

test.each([
	0, 5000, 60000,
])("reload with a %i ms clock change cannot credit unobserved time", async (correction) => {
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	await settle();
	close(tab);
	vi.setSystemTime(Date.now() + correction);
	tab = open();
	await settle();
	vi.advanceTimersByTime(Math.max(0, 8000 - correction));
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(fixture.mutate).not.toHaveBeenCalled();
	expect((await stored()).pendingCompletions).toEqual([]);
});

test("a live offline page credits monotonic time and replays it once after reload", async () => {
	vi.stubGlobal("navigator", { onLine: false });
	let finish!: (value: unknown) => void;
	fixture.mutate.mockReturnValueOnce({
		client: Promise.resolve({ type: "success" }),
		server: new Promise((resolve) => {
			finish = resolve;
		}),
	});
	const tab = open();
	tab.api.start();
	await settle();
	vi.setSystemTime(Date.now() + 60000);
	vi.advanceTimersByTime(10000);
	await settle();
	expect(fixture.mutate).toHaveBeenCalledOnce();
	const pending = (await stored()).pendingCompletions;
	expect(pending).toHaveLength(1);
	close(tab);
	open();
	await settle();
	expect(fixture.mutate).toHaveBeenCalledTimes(2);
	expect(fixture.mutate.mock.calls[1][0]).toEqual(pending[0]);
	finish({ type: "success" });
	await settle();
	expect((await stored()).pendingCompletions).toEqual([]);
});

test("auto-cycle anchors credit to the start of each new live interval", async () => {
	fixture.pref.focus = { ...DEFAULT_FOCUS, autoCycle: true };
	const tab = open();
	tab.api.start();
	await settle();
	for (let i = 0; i < 3; i++) {
		vi.advanceTimersByTime(10000);
		await settle();
	}
	expect(fixture.mutate).toHaveBeenCalledTimes(3);
	expect(
		new Set(fixture.mutate.mock.calls.map(([args]) => args.intervalId)).size,
	).toBe(3);
});

test("a restored forward-clock interval cannot turn unobserved time into credit by pausing", async () => {
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	await settle();
	tab.api.pause();
	await settle();
	expect((await stored()).session?.provenMs).toBe(2000);
	tab.api.start();
	await settle();
	close(tab);
	vi.setSystemTime(Date.now() + 5000);
	tab = open();
	await settle();
	tab.api.pause();
	await settle();
	expect(tab.api.session?.remainingSec).toBe(3);
	expect((await stored()).session?.provenMs).toBe(2000);
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(3000);
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(fixture.mutate).not.toHaveBeenCalled();
});

const OK = { client: Promise.resolve({ type: "success" }) };
const ok = () => ({ ...OK, server: Promise.resolve({ type: "success" }) });
const isStart = (
	args: object,
): args is { startInterval: { intervalId: string } } => "startInterval" in args;
const starts = () =>
	fixture.mutate.mock.calls
		.map(([args]) => args)
		.filter(isStart)
		.map((args) => args.startInterval.intervalId);
const logs = () =>
	fixture.mutate.mock.calls.map(([args]) => args).filter((a) => !isStart(a));

test("an online interval announces its start once and marks it server-started", async () => {
	vi.stubGlobal("navigator", {});
	const tab = open();
	tab.api.start();
	await settle();
	const state = await stored();
	expect(starts()).toEqual([state.session?.intervalId]);
	expect(state.session?.serverStarted).toBe(true);
	vi.advanceTimersByTime(1250);
	tab.api.pause();
	await settle();
	tab.api.start();
	await settle();
	expect(starts()).toHaveLength(1);
	expect(logs()).toEqual([]);
});

test.each([
	["pending", new Promise(() => {})],
	[
		"refused",
		Promise.resolve({ type: "error", error: { type: "app", message: "no" } }),
	],
])("a start that is %s leaves the interval unmarked", async (_, server) => {
	vi.stubGlobal("navigator", {});
	fixture.mutate.mockReturnValueOnce({ ...OK, server });
	const tab = open();
	tab.api.start();
	await settle();
	expect(starts()).toHaveLength(1);
	expect((await stored()).session?.serverStarted).toBe(false);
});

test("a reload mid-interval still credits an online interval once", async () => {
	vi.stubGlobal("navigator", {});
	let tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
	const intervalId = (await stored()).session?.intervalId;
	vi.advanceTimersByTime(3000);
	close(tab);
	tab = open();
	await settle();
	vi.advanceTimersByTime(7000);
	await settle();
	expect(logs()).toEqual([
		expect.objectContaining({ intervalId, taskId: "task", durationSec: 10 }),
	]);
	close(tab);
	open();
	await settle();
	expect(logs()).toHaveLength(1);
});

test("a forward clock change across reload is left to the server and retried when early", async () => {
	vi.stubGlobal("navigator", {});
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	close(tab);
	vi.setSystemTime(Date.now() + 60000);
	fixture.mutate.mockImplementation((args: object) =>
		isStart(args) ||
		fixture.mutate.mock.calls.filter(([a]) => !isStart(a)).length > 1
			? ok()
			: {
					...OK,
					server: Promise.resolve({
						type: "error",
						error: { type: "app", message: new FocusEarlyError(8000).message },
					}),
				},
	);
	tab = open();
	await settle();
	expect(logs()).toHaveLength(1);
	expect((await stored()).pendingCompletions).toHaveLength(1);
	expect(tab.api.error).toBeNull();
	vi.advanceTimersByTime(8000);
	await settle();
	expect(logs()).toHaveLength(1);
	vi.advanceTimersByTime(1500);
	await settle();
	expect(logs()).toHaveLength(2);
	expect(logs()[1]).toEqual(logs()[0]);
	expect((await stored()).pendingCompletions).toEqual([]);
	vi.advanceTimersByTime(60000);
	await settle();
	expect(logs()).toHaveLength(2);
});

test("a forward clock change across reload earns nothing when the start was never acknowledged", async () => {
	vi.stubGlobal("navigator", {});
	fixture.mutate.mockReturnValueOnce({ ...OK, server: new Promise(() => {}) });
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	close(tab);
	vi.setSystemTime(Date.now() + 60000);
	tab = open();
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(logs()).toEqual([]);
	expect((await stored()).pendingCompletions).toEqual([]);
	expect(tab.api.error).toBe(m.focus_not_counted());
});

test("completion reports the paused wall time", async () => {
	vi.stubGlobal("navigator", {});
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	tab.api.pause();
	await settle();
	vi.advanceTimersByTime(5000);
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(8000);
	await settle();
	expect(logs()).toEqual([expect.objectContaining({ pausedMs: 5000 })]);
});

const EARLY = (waitMs: number) => ({
	...OK,
	server: Promise.resolve({
		type: "error",
		error: { type: "app", message: new FocusEarlyError(waitMs).message },
	}),
});

test("a pause longer than a day still resumes and reports the capped pause", async () => {
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(2000);
	tab.api.pause();
	await settle();
	vi.advanceTimersByTime(30 * 3600 * 1000);
	tab.api.start();
	await settle();
	expect(tab.api.session).toMatchObject({ running: true, remainingSec: 8 });
	expect((await stored()).session?.pausedMs).toBe(86_400_000);
	expect(tab.api.error).toBeNull();
	vi.advanceTimersByTime(8000);
	await settle();
	expect(logs()).toEqual([expect.objectContaining({ pausedMs: 86_400_000 })]);
});

test("pauses accumulate up to the cap across several resumes", async () => {
	const tab = open();
	tab.api.start();
	await settle();
	for (const hours of [20, 20]) {
		vi.advanceTimersByTime(1000);
		tab.api.pause();
		await settle();
		vi.advanceTimersByTime(hours * 3600 * 1000);
		tab.api.start();
		await settle();
	}
	expect((await stored()).session).toMatchObject({
		running: true,
		pausedMs: 86_400_000,
	});
});

test("an interval whose start ack was lost is credited from the synced start after a reload", async () => {
	vi.stubGlobal("navigator", {});
	fixture.mutate.mockReturnValueOnce({ ...OK, server: new Promise(() => {}) });
	let tab = open();
	tab.api.startForTask("task", "Read");
	await settle();
	const intervalId = (await stored()).session?.intervalId as string;
	vi.advanceTimersByTime(3000);
	close(tab);
	tab = open();
	await settle();
	expect((await stored()).session?.serverStarted).toBe(false);
	await syncStarts([intervalId]);
	expect((await stored()).session?.serverStarted).toBe(true);
	vi.advanceTimersByTime(7000);
	await settle();
	expect(logs()).toEqual([
		expect.objectContaining({ intervalId, taskId: "task", durationSec: 10 }),
	]);
	expect(tab.api.error).toBeNull();
});

test("an expiry right after a load waits for the synced starts before judging the interval", async () => {
	vi.stubGlobal("navigator", {});
	fixture.mutate.mockReturnValueOnce({ ...OK, server: new Promise(() => {}) });
	let tab = open();
	tab.api.start();
	await settle();
	const intervalId = (await stored()).session?.intervalId as string;
	vi.advanceTimersByTime(3000);
	close(tab);
	vi.setSystemTime(Date.now() + 60000);
	fixture.starts = { rows: [], type: "unknown" };
	tab = open();
	await settle();
	expect(tab.api.session).toMatchObject({
		running: true,
		cycle: { phase: "work" },
	});
	await syncStarts([intervalId], "complete");
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(logs()).toHaveLength(1);
	expect(tab.api.error).toBeNull();
});

test("an uncountable work interval is dropped once with a notice after the lookup grace", async () => {
	vi.stubGlobal("navigator", {});
	vi.stubGlobal("__diteroFocusTestSec", 30);
	fixture.mutate.mockReturnValueOnce({ ...OK, server: new Promise(() => {}) });
	let tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(3000);
	close(tab);
	vi.setSystemTime(Date.now() + 60000);
	fixture.starts = { rows: [], type: "unknown" };
	tab = open();
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("work");
	expect(tab.api.error).toBeNull();
	vi.advanceTimersByTime(10_500);
	await settle();
	expect(tab.api.session?.cycle.phase).toBe("break");
	expect(logs()).toEqual([]);
	expect(tab.api.error).toBe(m.focus_not_counted());
	tab.api.dismissError();
	await settle();
	vi.advanceTimersByTime(60_000);
	await settle();
	expect(tab.api.error).toBeNull();
});

test("an uncountable break stays silent", async () => {
	const tab = open();
	tab.api.start();
	await settle();
	tab.api.skip();
	await settle();
	tab.api.start();
	await settle();
	const first = (await stored()).session;
	expect(first?.cycle.phase).toBe("break");
	expect(first?.running).toBe(true);
	close(tab);
	vi.setSystemTime(Date.now() + 60000);
	const reopened = open();
	await settle();
	expect(reopened.api.session?.cycle.phase).toBe("work");
	expect(logs()).toEqual([]);
	expect(reopened.api.error).toBeNull();
});

test("a completion the server keeps rejecting as early is retried a bounded number of times", async () => {
	fixture.mutate.mockImplementation(() => EARLY(1000));
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(10_000);
	await settle();
	for (let i = 0; i < 20; i++) {
		vi.advanceTimersByTime(2000);
		await settle();
	}
	expect(logs()).toHaveLength(6);
	expect((await stored()).pendingCompletions).toHaveLength(1);
	expect(tab.api.error).toBeNull();
});

test("two tabs racing the same completion show no failure when one loses on the primary key", async () => {
	fixture.mutate.mockImplementation(() => ({
		...OK,
		server: Promise.resolve({
			type: "error",
			error: {
				type: "app",
				message:
					'duplicate key value violates unique constraint "focus_session_pkey"',
			},
		}),
	}));
	const tab = open();
	tab.api.start();
	await settle();
	vi.advanceTimersByTime(10_000);
	await settle();
	expect(logs()).toHaveLength(1);
	expect(tab.api.error).toBeNull();
	expect((await stored()).pendingCompletions).toEqual([]);
});
