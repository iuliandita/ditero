import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { VoiceEngine } from "../../../domain/voice-capture.ts";
import type { VoiceIdentity } from "./useVoiceCapture.ts";

// No DOM or renderer in this suite: React is replaced by a minimal runner that
// keeps hook state and collects effects so the hook body runs for real.
const effects: Array<() => void | (() => void)> = [];
const slots: unknown[] = [];
let cursor = 0;
const slot = <T>(init: () => T): T => {
	const i = cursor++;
	if (!(i in slots)) slots[i] = init();
	return slots[i] as T;
};
vi.mock("react", () => ({
	useState: <T>(init: () => T) => [slot(init)],
	useMemo: <T>(fn: () => T) => slot(fn),
	useEffect: (fn: () => void | (() => void)) => {
		effects.push(fn);
	},
	useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) =>
		getSnapshot(),
}));

let aborted = 0;
const engine: VoiceEngine = {
	check: async () => ({ status: "available", processing: "device" }),
	start: () => ({
		stop: () => {},
		abort: () => {
			aborted += 1;
		},
	}),
};
vi.mock("../../lib/speech-recognition.ts", () => ({
	createBrowserVoiceEngine: () => engine,
}));

const identity: VoiceIdentity = {
	open: true,
	accountId: "a1",
	native: false,
	currentListId: null,
	targetListId: null,
	workspaceId: "w1",
	locale: "en",
};

let win: EventTarget;
let doc: EventTarget & { visibilityState: string };

beforeEach(() => {
	aborted = 0;
	effects.length = 0;
	slots.length = 0;
	win = new EventTarget();
	doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
	vi.stubGlobal("window", win);
	vi.stubGlobal("document", doc);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function listening() {
	const { useVoiceCapture } = await import("./useVoiceCapture.ts");
	const render = () => {
		effects.length = 0;
		cursor = 0;
		return useVoiceCapture(identity);
	};
	let view = render();
	const cleanups = effects.map((run) => run());
	await Promise.resolve();
	await Promise.resolve();
	view = render();
	view.start();
	view = render();
	expect(view.state?.phase).toBe("listening");
	return {
		phase: () => render().state?.phase,
		unmount: () => {
			for (const cleanup of cleanups) if (cleanup) cleanup();
		},
	};
}

test("a hidden document cancels a running capture", async () => {
	const session = await listening();
	doc.visibilityState = "hidden";
	doc.dispatchEvent(new Event("visibilitychange"));
	expect(aborted).toBe(1);
	expect(session.phase()).toBe("idle");
});

test("a visible document, or window blur, keeps listening", async () => {
	const session = await listening();
	doc.dispatchEvent(new Event("visibilitychange"));
	win.dispatchEvent(new Event("blur"));
	expect(aborted).toBe(0);
	expect(session.phase()).toBe("listening");
});

test("pagehide still cancels", async () => {
	const session = await listening();
	win.dispatchEvent(new Event("pagehide"));
	expect(aborted).toBe(1);
	expect(session.phase()).toBe("idle");
});

test("unmount removes the visibilitychange listener it added", async () => {
	const add = vi.spyOn(doc, "addEventListener");
	const remove = vi.spyOn(doc, "removeEventListener");
	const session = await listening();
	session.unmount();
	const added = add.mock.calls.find(([type]) => type === "visibilitychange");
	expect(added).toBeDefined();
	expect(remove).toHaveBeenCalledWith("visibilitychange", added?.[1]);
});
