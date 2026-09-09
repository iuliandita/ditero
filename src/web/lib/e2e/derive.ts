import { KdfError, type KekPurpose } from "../../../domain/e2e/kdf.ts";
import {
	isKdfFailure,
	type KdfRequest,
	type KdfResponse,
} from "./kdf-protocol.ts";

export type Deriver = {
	derive: (
		secret: string,
		salt: Uint8Array,
		purpose: KekPurpose,
		version: number,
	) => Promise<Uint8Array>;
	dispose: () => void;
};

// Vite resolves this at build time into a same-origin chunk. `new Worker` with
// a string path would not be rewritten and would 404 in the built app while
// working in dev.
export function spawnKdfWorker(): Worker {
	return new Worker(new URL("./kdf-worker.ts", import.meta.url), {
		type: "module",
	});
}

/**
 * One worker, many derivations, correlated by id. Enrollment derives twice and
 * a change-passphrase derives three times; a worker per call would pay the
 * module and WASM startup each time, and an uncorrelated protocol would resolve
 * whichever promise happened to be first when two derivations overlap -- which
 * silently swaps the passphrase KEK for the recovery KEK and produces a wrap
 * neither secret opens.
 */
export function createDeriver(spawn: () => Worker = spawnKdfWorker): Deriver {
	let worker: Worker | null = null;
	let nextId = 0;
	const pending = new Map<
		number,
		{ resolve: (kek: Uint8Array) => void; reject: (error: unknown) => void }
	>();

	const rejectAll = (error: unknown) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};

	const ensure = (): Worker => {
		if (worker) return worker;
		const created = spawn();
		created.addEventListener("message", (event: MessageEvent<KdfResponse>) => {
			const waiter = pending.get(event.data.id);
			if (!waiter) return;
			pending.delete(event.data.id);
			if (isKdfFailure(event.data)) {
				waiter.reject(
					new KdfError(
						event.data.failure === "unknown"
							? "invalid-input"
							: event.data.failure,
						event.data.message,
					),
				);
				return;
			}
			waiter.resolve(event.data.kek);
		});
		// A worker that dies mid-derivation otherwise leaves the dialog on its
		// spinner forever, which reads to the user as a hung app rather than a
		// failure they can retry.
		created.addEventListener("error", (event) => {
			rejectAll(
				new KdfError("invalid-input", `kdf worker failed: ${event.message}`),
			);
			worker = null;
			created.terminate();
		});
		worker = created;
		return created;
	};

	return {
		derive(secret, salt, purpose, version) {
			const id = nextId++;
			const request: KdfRequest = { id, secret, salt, purpose, version };
			return new Promise<Uint8Array>((resolve, reject) => {
				pending.set(id, { resolve, reject });
				ensure().postMessage(request);
			});
		},
		dispose() {
			rejectAll(new KdfError("invalid-input", "kdf: deriver disposed"));
			worker?.terminate();
			worker = null;
		},
	};
}
