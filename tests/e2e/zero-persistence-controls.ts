type Controls = {
	captureSockets: boolean;
	sockets: WebSocket[];
	idleHeld: boolean;
	idleRequests: number;
	marker: string;
	mode: "observe" | "hold" | "fail";
	puts: number;
	completedTransactions: number;
	failure: Error;
	releaseCompletion: (() => void) | undefined;
	restore: () => void;
};

declare global {
	interface Window {
		__zeroCloseControls: Controls;
	}
}

// Serialized by Playwright before page startup. Only browser scheduling and
// IndexedDB boundaries are controlled; no SDK internals are read or replaced.
export function installPersistenceControls(): void {
	const nativeIdle = window.requestIdleCallback?.bind(window);
	const nativeCancel = window.cancelIdleCallback?.bind(window);
	const nativePut = IDBObjectStore.prototype.put;
	const NativeWebSocket = window.WebSocket;
	const watchedTransactions = new WeakSet<IDBTransaction>();
	const callbacks = new Map<number, IdleRequestCallback>();
	const nativeHandles = new Map<number, number>();
	let handle = 1_000_000;
	const controls: Controls = {
		captureSockets: false,
		sockets: [],
		idleHeld: false,
		idleRequests: 0,
		marker: "",
		mode: "observe",
		puts: 0,
		completedTransactions: 0,
		failure: new Error("injected task persistence failure"),
		releaseCompletion: undefined,
		restore: () => {
			controls.idleHeld = false;
			controls.releaseCompletion?.();
			for (const callback of callbacks.values()) {
				if (nativeIdle) nativeIdle(callback);
			}
			callbacks.clear();
			window.requestIdleCallback = nativeIdle;
			window.cancelIdleCallback = nativeCancel;
			IDBObjectStore.prototype.put = nativePut;
			window.WebSocket = NativeWebSocket;
		},
	};
	window.__zeroCloseControls = controls;
	window.WebSocket = class extends NativeWebSocket {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			if (controls.captureSockets) controls.sockets.push(this);
		}
	};
	window.requestIdleCallback = (callback, options) => {
		const id = handle++;
		callbacks.set(id, callback);
		if (controls.idleHeld) {
			controls.idleRequests++;
		} else if (nativeIdle) {
			nativeHandles.set(
				id,
				nativeIdle((deadline) => {
					if (!callbacks.has(id)) return;
					if (controls.idleHeld) controls.idleRequests++;
					else {
						callbacks.delete(id);
						callback(deadline);
					}
				}, options),
			);
		}
		return id;
	};
	window.cancelIdleCallback = (id) => {
		callbacks.delete(id);
		const scheduled = nativeHandles.get(id);
		if (scheduled !== undefined) nativeCancel?.(scheduled);
		nativeHandles.delete(id);
	};
	IDBObjectStore.prototype.put = function (value, key) {
		if (controls.marker && JSON.stringify(value).includes(controls.marker)) {
			controls.puts++;
			if (controls.mode === "fail") {
				this.transaction.abort();
				throw controls.failure;
			}
			if (!watchedTransactions.has(this.transaction)) {
				watchedTransactions.add(this.transaction);
				this.transaction.addEventListener(
					"complete",
					(event) => {
						controls.completedTransactions++;
						if (controls.mode === "hold") {
							event.stopImmediatePropagation();
							const transaction = this.transaction;
							controls.releaseCompletion = () => {
								controls.releaseCompletion = undefined;
								transaction.dispatchEvent(new Event("complete"));
							};
						}
					},
					{ once: true, capture: true },
				);
			}
		}
		return key === undefined
			? nativePut.call(this, value)
			: nativePut.call(this, value, key);
	};
}

export function holdIdlePersistence(
	marker: string,
	mode: Controls["mode"] = "observe",
) {
	const controls = window.__zeroCloseControls;
	controls.marker = marker;
	controls.mode = mode;
	controls.idleHeld = true;
	controls.idleRequests = 0;
	controls.puts = 0;
	controls.completedTransactions = 0;
}

export function restorePersistenceControls() {
	window.__zeroCloseControls.restore();
}
