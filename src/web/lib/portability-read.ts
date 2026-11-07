function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const aborted = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", aborted);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", aborted, { once: true });
	});
}

// Metadata reads can overlap the account's single admitted portability operation.
export async function readPortabilityMetadata<T>(
	path: string,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		for (let attempt = 0; ; attempt++) {
			const response = await fetch(path, {
				signal: controller.signal,
				credentials: "same-origin",
				cache: "no-store",
			});
			if (response.status !== 429 || attempt === 2) {
				if (!response.ok) throw new Error("Import metadata unavailable");
				return (await response.json()) as T;
			}
			const header = response.headers.get("Retry-After");
			const seconds = header === null ? 0.5 : Number(header);
			if (!Number.isFinite(seconds) || seconds < 0 || seconds > 5)
				throw new Error("Import metadata unavailable");
			await response.body?.cancel();
			await pause(Math.max(100, seconds * 1000), controller.signal);
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
