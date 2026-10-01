type ConnectionState = { name: string };

type ZeroConnection = {
	state: {
		current: ConnectionState;
		subscribe(listener: (state: ConnectionState) => void): () => void;
	};
	connect(options: { auth: string }): Promise<void>;
};

// The token endpoint answers 401 once the Better Auth session is gone (it
// lasts seven days by default), which no retry can fix: the user has to sign
// in again.
export class SessionExpiredError extends Error {}

export async function fetchZeroToken(): Promise<string> {
	const response = await fetch("/api/auth/token", { credentials: "include" });
	if (response.status === 401 || response.status === 403)
		throw new SessionExpiredError(`token refresh refused: ${response.status}`);
	if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
	const body = (await response.json()) as { token?: string };
	if (!body.token) throw new Error("token refresh returned no token");
	return body.token;
}

// A failed refresh is retried when the network or the tab comes back; a token
// request made while offline would otherwise leave Zero in needs-auth for good.
function onNetworkOrFocus(retry: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	const onVisible = () => {
		if (document.visibilityState === "visible") retry();
	};
	window.addEventListener("online", retry);
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		window.removeEventListener("online", retry);
		document.removeEventListener("visibilitychange", onVisible);
	};
}

export function watchZeroAuth(
	zero: { connection: ZeroConnection },
	getToken: () => Promise<string> = fetchZeroToken,
	onError: (error: unknown) => void = console.error,
	{
		onSessionExpired = () => {},
		retrySignals = onNetworkOrFocus,
	}: {
		onSessionExpired?: (expired: boolean) => void;
		retrySignals?: (retry: () => void) => () => void;
	} = {},
): () => void {
	let pending: Promise<void> | undefined;
	let stopped = false;
	let retryRequested = false;

	const onState = (state: ConnectionState) => {
		if (state.name !== "needs-auth" || pending || stopped) return;
		pending = (async () => {
			const auth = await getToken();
			onSessionExpired(false);
			if (!stopped) await zero.connection.connect({ auth });
		})()
			.catch((error: unknown) => {
				if (error instanceof SessionExpiredError) onSessionExpired(true);
				onError(error);
			})
			.finally(() => {
				pending = undefined;
				if (retryRequested) {
					retryRequested = false;
					onState(zero.connection.state.current);
				}
			});
	};

	const unsubscribe = zero.connection.state.subscribe(onState);
	const stopRetry = retrySignals(() => {
		if (stopped || zero.connection.state.current.name !== "needs-auth") return;
		if (pending) retryRequested = true;
		else onState(zero.connection.state.current);
	});
	onState(zero.connection.state.current);
	return () => {
		stopped = true;
		unsubscribe();
		stopRetry();
	};
}
