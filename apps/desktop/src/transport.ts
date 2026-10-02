import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { m } from "../../../src/paraglide/messages.js";
import { retireZeroClients } from "../../../src/web/lib/zero-lifecycle.ts";

type NativeObject = {
	postMessage(message: string): void;
	onmessage: ((event: MessageEvent) => void) | null;
};
export async function installTransport(): Promise<void> {
	let page: number;
	const native: NativeObject = {
		onmessage: null,
		postMessage(message) {
			void invoke("native_post", { message, page }).catch(() => {
				const request: unknown = JSON.parse(message);
				if (typeof request !== "object" || request === null) return;
				const { rid, cid } = request as { rid?: unknown; cid?: unknown };
				native.onmessage?.(
					new MessageEvent("message", {
						data: JSON.stringify({
							t: "reply",
							rid,
							cid,
							ok: false,
							code: "transport-refused",
						}),
					}),
				);
			});
		},
	};
	const channel = new Channel<string>();
	channel.onmessage = (data) =>
		native.onmessage?.(new MessageEvent("message", { data }));
	page = await invoke<number>("native_attach", { channel });
	Object.defineProperty(globalThis, "NativeDitero", {
		value: native,
		configurable: false,
		writable: false,
	});
	let closing = false;
	await getCurrentWindow().onCloseRequested(async (event) => {
		event.preventDefault();
		if (closing) return;
		closing = true;
		try {
			await retireZeroClients();
			await invoke("native_drain", { page });
			await getCurrentWindow().destroy();
		} catch {
			closing = false;
			window.alert(m.sync_save_pending_failed());
		}
	});
}
