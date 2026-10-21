export class ConnectionRequiredError extends Error {}

// Only fetch rejection is transport failure. A received HTTP response keeps its
// existing status/body handling, even if the browser goes offline afterwards.
export async function fetchWithConnectionCheck(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new ConnectionRequiredError("Server connection unavailable", {
			cause: error,
		});
	}
}

export function isConnectionFailure(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	if ("status" in error && typeof error.status === "number")
		return error.status === 0;
	return error instanceof ConnectionRequiredError;
}

export function connectionRetry(
	attempt: () => Promise<unknown>,
	signals: EventTarget,
) {
	let stopped = false;
	let pending = false;
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function schedule() {
		if (stopped) return;
		timer = setTimeout(
			() => void retry(),
			Math.min(1000 * 2 ** Math.min(failures++, 5), 30_000),
		);
	}
	async function retry() {
		if (stopped || pending) return;
		clearTimeout(timer);
		pending = true;
		try {
			await attempt();
		} finally {
			pending = false;
			schedule();
		}
	}
	const online = () => void retry();
	signals.addEventListener("online", online);
	schedule();
	return {
		retry,
		stop() {
			stopped = true;
			clearTimeout(timer);
			signals.removeEventListener("online", online);
		},
	};
}
