import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { protectOfflineEdits } from "./offline-durability.ts";

let stop: (() => void) | undefined;
let browser: EventTarget;
let documentEvents: EventTarget & { visibilityState: string };
let network: { onLine: boolean };
function unload() {
	const event = new Event("beforeunload", { cancelable: true });
	browser.dispatchEvent(event);
	return event.defaultPrevented;
}
beforeEach(() => {
	browser = new EventTarget();
	documentEvents = Object.assign(new EventTarget(), {
		visibilityState: "visible",
	});
	network = { onLine: false };
	vi.stubGlobal("window", browser);
	vi.stubGlobal("document", documentEvents);
	vi.stubGlobal("navigator", network);
});
afterEach(() => {
	stop?.();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("flushes each accepted offline commit without idle scheduling and warns until the latest commit is durable", async () => {
	let finish!: () => void;
	const persist = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const zero = {
		mutate: () => ({
			client: Promise.resolve({ type: "success" }),
			server: new Promise(() => {}),
		}),
		persist,
	};
	stop = protectOfflineEdits(zero);
	const first = zero.mutate();
	expect(unload()).toBe(true);
	await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
	const second = zero.mutate();
	await Promise.resolve();
	finish();
	await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
	expect(unload()).toBe(true);
	finish();
	await Promise.all([first.client, second.client]);
	expect(unload()).toBe(false);
});

it("retains the unload warning on disk failure, retries on hiding, and flushes online edits when going offline", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const persist = vi
		.fn(async () => {})
		.mockRejectedValueOnce(new Error("disk full"));
	const zero = {
		mutate: () => ({
			client: Promise.resolve({ type: "success" }),
			server: new Promise(() => {}),
		}),
		persist,
	};
	stop = protectOfflineEdits(zero);
	await zero.mutate().client;
	expect(console.error).toHaveBeenCalled();
	// Check the warning without dispatching its best-effort retry yet.
	let finish!: () => void;
	persist.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	expect(unload()).toBe(true);
	finish();
	documentEvents.visibilityState = "hidden";
	documentEvents.dispatchEvent(new Event("visibilitychange"));
	await vi.waitFor(() => expect(unload()).toBe(false));
	network.onLine = true;
	documentEvents.visibilityState = "visible";
	const priorCalls = persist.mock.calls.length;
	await zero.mutate().client;
	expect(persist).toHaveBeenCalledTimes(priorCalls);
	network.onLine = false;
	browser.dispatchEvent(new Event("offline"));
	await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(priorCalls + 1));
	await vi.waitFor(() => expect(unload()).toBe(false));
});
