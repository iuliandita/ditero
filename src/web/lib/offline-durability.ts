import { mutationResultFailure } from "./run-mutation.ts";

type Mutation = { client: Promise<unknown>; server: Promise<unknown> };

export function protectOfflineEdits(zero: {
	mutate: unknown;
	persist(): Promise<void>;
}) {
	let pending = 0;
	let revision = 0;
	let durable = 0;
	let flushing: Promise<void> | undefined;
	const flush = async (): Promise<void> => {
		while (durable < revision) {
			if (!flushing) {
				const saving = revision;
				flushing = zero
					.persist()
					.then(() => {
						durable = saving;
					})
					.finally(() => {
						flushing = undefined;
					});
			}
			await flushing;
		}
	};
	const save = () => {
		void flush().catch(console.error);
	};
	const beforeUnload = (event: BeforeUnloadEvent) => {
		if (!navigator.onLine && (pending > 0 || durable < revision)) {
			// The browser owns the warning text; asynchronous IDB cannot block unload.
			event.preventDefault();
			event.returnValue = "";
			save();
		}
	};
	const hidden = () => {
		if (document.visibilityState === "hidden") save();
	};
	window.addEventListener("beforeunload", beforeUnload);
	window.addEventListener("pagehide", save);
	window.addEventListener("offline", save);
	document.addEventListener("visibilitychange", hidden);
	const mutate = zero.mutate as (...args: unknown[]) => Mutation;
	const guarded = (...args: unknown[]) => {
		const result = mutate(...args);
		pending++;
		const client = result.client
			.then(async (value) => {
				if (mutationResultFailure(value) === null) {
					revision++;
					if (!navigator.onLine || document.visibilityState === "hidden")
						await flush().catch(console.error);
				}
				return value;
			})
			.finally(() => {
				pending--;
			});
		return { ...result, client };
	};
	Object.assign(guarded, mutate);
	Object.defineProperty(zero, "mutate", { value: guarded, configurable: true });
	return () => {
		window.removeEventListener("beforeunload", beforeUnload);
		window.removeEventListener("pagehide", save);
		window.removeEventListener("offline", save);
		document.removeEventListener("visibilitychange", hidden);
	};
}
