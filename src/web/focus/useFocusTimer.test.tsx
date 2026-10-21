import { setImmediate } from "node:timers";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_FOCUS } from "./timer-core.ts";
import { focusStorageKey, restoreFocus } from "./timer-persistence.ts";
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
	useUserPref: () => ({ pref: fixture.pref, loading: false }),
}));
vi.mock("../lib/native-account.tsx", () => ({
	useNativeAccount: () => ({ storageScope: fixture.active?.scope }),
}));
vi.mock("../../zero/mutators.ts", () => ({
	mutators: { focus: { logSession: (args: unknown) => args } },
}));

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
function storageEvent(key: string | null) {
	window.dispatchEvent(
		Object.assign(new Event("storage"), { key, storageArea: storage }),
	);
	for (const tab of tabs) if (tab.dirty) render(tab);
}
async function settle() {
	await new Promise<void>((resolve) => setImmediate(resolve));
	for (const tab of tabs) if (tab.dirty) render(tab);
}
function pending() {
	return JSON.parse(storage.getItem(focusStorageKey("owner")) ?? "null")
		?.pendingCompletions;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10000);
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("localStorage", storage);
	vi.stubGlobal("__diteroFocusTestSec", 2);
	fixture.pref.focus = { ...DEFAULT_FOCUS, autoCycle: false };
	fixture.mutate.mockReset().mockReturnValue({
		client: Promise.resolve({ type: "success" }),
	});
	data.clear();
});
afterEach(() => {
	for (const tab of [...tabs]) close(tab);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([
	true,
	false,
])("another tab's Stop fences stale ticks and completion (storage event=%s)", (deliverEvent) => {
	const first = open();
	first.api.start();
	render(first);
	const stale = open();
	expect(stale.api.session?.running).toBe(true);
	first.api.reset();
	if (deliverEvent) storageEvent(focusStorageKey("owner"));
	vi.advanceTimersByTime(3000);
	render(stale);
	expect(storage.getItem(focusStorageKey("owner"))).toBeNull();
	expect(stale.api.session).toBeNull();
	expect(fixture.mutate).not.toHaveBeenCalled();
});

test("a newer revision fences stale task edits, while other accounts and servers stay isolated", () => {
	const first = open();
	first.api.start();
	render(first);
	const stale = open();
	const other = open("other");
	const native = open("owner", "another-server");
	other.api.start();
	native.api.start();
	first.api.pause();
	const paused = storage.getItem(focusStorageKey("owner"));
	stale.api.bindTask("stale-task", "Stale");
	render(stale);
	expect(storage.getItem(focusStorageKey("owner"))).toBe(paused);
	expect(stale.api.session?.running).toBe(false);
	expect(stale.api.session?.boundTaskId).toBeNull();
	storageEvent(focusStorageKey("owner"));
	render(other);
	render(native);
	expect(other.api.session?.running).toBe(true);
	expect(native.api.session?.running).toBe(true);
});

test.each([
	"failure",
	"reload-before-result",
	"reload-after-commit",
])("retains and replays a stable pending completion after %s", async (interruption) => {
	let finish!: (value: unknown) => void;
	fixture.mutate.mockReturnValueOnce({
		client: new Promise((resolve) => {
			finish = resolve;
		}),
	});
	const tab = open();
	tab.api.startForTask("task", "Read");
	render(tab);
	const intervalId = tab.api.session?.intervalId;
	vi.advanceTimersByTime(2000);
	render(tab);
	expect(fixture.mutate).toHaveBeenCalledOnce();
	const completion = {
		intervalId,
		taskId: "task",
		kind: "work",
		startedAt: 10000,
		endedAt: 12000,
		durationSec: 2,
	};
	expect(pending()).toEqual([completion]);
	expect(
		restoreFocus(storage.getItem(focusStorageKey("owner")))?.cycle.phase,
	).toBe("break");
	if (interruption === "failure") {
		vi.spyOn(console, "error").mockImplementation(() => {});
		finish({ type: "error", error: { type: "zero", message: "closed" } });
		await settle();
		expect(pending()).toEqual([completion]);
		tab.api.reset();
		render(tab);
		expect(pending()).toEqual([completion]);
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
	expect(fixture.mutate).toHaveBeenCalledTimes(2);
	expect(fixture.mutate.mock.calls[0][0]).toEqual(completion);
	expect(fixture.mutate.mock.calls[1][0]).toEqual(completion);
	render(reloaded);
	vi.advanceTimersByTime(3000);
	expect(fixture.mutate).toHaveBeenCalledTimes(2);
	expect(pending()).toEqual([completion]);
	finishReplay({ type: "success" });
	await settle();
	expect(pending() ?? []).toEqual([]);
	close(reloaded);
	open();
	expect(fixture.mutate).toHaveBeenCalledTimes(2);

	const { mutators } = await vi.importActual<
		typeof import("../../zero/mutators.ts")
	>("../../zero/mutators.ts");
	type LogInput = Parameters<typeof mutators.focus.logSession.fn>[0];
	const rows: { id: string }[] = [];
	const insert = vi.fn(async (row: { id: string }) => {
		rows.push(row);
	});
	const tx = {
		run: async () => rows[0],
		mutate: { focusSession: { insert } },
	} as unknown as LogInput["tx"];
	for (const [args] of fixture.mutate.mock.calls) {
		await mutators.focus.logSession.fn({ tx, ctx: { id: "owner" }, args });
	}
	expect(insert).toHaveBeenCalledOnce();
	expect(rows[0].id).toBe(`owner:${intervalId}`);
});
