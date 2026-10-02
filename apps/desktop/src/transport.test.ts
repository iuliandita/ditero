import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	invoke: vi.fn(),
	retire: vi.fn(),
	destroy: vi.fn(),
	close: undefined as
		| ((event: { preventDefault(): void }) => Promise<void>)
		| undefined,
	receive: undefined as ((data: string) => void) | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: state.invoke,
	Channel: class {
		set onmessage(fn: (data: string) => void) {
			state.receive = fn;
		}
	},
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		destroy: state.destroy,
		async onCloseRequested(fn: typeof state.close) {
			state.close = fn;
			return () => {};
		},
	}),
}));
vi.mock("../../../src/web/lib/zero-lifecycle.ts", () => ({
	retireZeroClients: state.retire,
}));

vi.mock("../../../src/paraglide/messages.js", () => ({
	m: { sync_save_pending_failed: () => "Pending changes could not be saved." },
}));

import { installTransport } from "./transport.ts";

it("routes scoped refusals and keeps close retryable until pending changes retire", async () => {
	state.invoke.mockImplementation(async (operation: string) => {
		if (operation === "native_attach") return 7;
		if (operation === "native_post") throw new Error("refused");
	});
	const alert = vi.fn();
	vi.stubGlobal("window", { alert });
	await installTransport();
	const native = (
		globalThis as unknown as {
			NativeDitero: {
				postMessage(message: string): void;
				onmessage: ((e: MessageEvent) => void) | null;
			};
		}
	).NativeDitero;
	const replies: string[] = [];
	native.onmessage = (e) => replies.push(String(e.data));
	native.postMessage(
		JSON.stringify({ op: "ws.send", rid: 4, cid: 2, gen: 1, data: "[]" }),
	);
	await vi.waitFor(() => expect(replies).toHaveLength(1));
	expect(JSON.parse(replies[0])).toEqual({
		t: "reply",
		rid: 4,
		cid: 2,
		ok: false,
		code: "transport-refused",
	});
	expect(state.invoke).toHaveBeenCalledWith("native_post", {
		message: expect.any(String),
		page: 7,
	});
	const preventDefault = vi.fn();
	state.retire.mockRejectedValueOnce(new Error("storage failure"));
	await state.close?.({ preventDefault });
	expect(preventDefault).toHaveBeenCalledOnce();
	expect(state.destroy).not.toHaveBeenCalled();
	expect(state.invoke).not.toHaveBeenCalledWith("native_drain", { page: 7 });
	expect(alert).toHaveBeenCalledOnce();
	state.retire.mockResolvedValue(undefined);
	await state.close?.({ preventDefault });
	expect(state.invoke).toHaveBeenCalledWith("native_drain", { page: 7 });
	expect(state.destroy).toHaveBeenCalledOnce();
	expect(state.retire.mock.invocationCallOrder.at(-1)).toBeLessThan(
		state.destroy.mock.invocationCallOrder[0],
	);
	vi.unstubAllGlobals();
});
