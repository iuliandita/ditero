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
		onAuthRejected = () => {},
		retrySignals = onNetworkOrFocus,
	}: {
		onSessionExpired?: (expired: boolean) => void;
		onAuthRejected?: (rejected: boolean) => void;
		retrySignals?: (retry: () => void) => () => void;
	} = {},
): () => void {
	let pending: Promise<void> | undefined;
	let stopped = false;
	let terminalRefusal = false;
	let failures = 0;
	let authRejections = 0;
	let nextAttemptAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cycle: { authSent: boolean; failed: boolean } | undefined;
	let previousState = zero.connection.state.current.name;

	function clearTimer() {
		clearTimeout(timer);
		timer = undefined;
	}

	function fail(attempt: NonNullable<typeof cycle>, authRejected = false) {
		if (attempt.failed) return;
		attempt.failed = true;
		failures++;
		nextAttemptAt =
			Date.now() + Math.min(1000 * 2 ** Math.min(failures - 1, 5), 30_000);
		if (authRejected) {
			authRejections++;
			onAuthRejected(authRejections >= 3);
		}
	}

	function retry() {
		if (
			stopped ||
			pending ||
			(cycle?.authSent && !cycle.failed) ||
			terminalRefusal ||
			zero.connection.state.current.name !== "needs-auth"
		)
			return;
		const remaining = nextAttemptAt - Date.now();
		if (remaining > 0) {
			if (timer === undefined)
				timer = setTimeout(() => {
					timer = undefined;
					retry();
				}, remaining);
			return;
		}
		clearTimer();
		const attempt = { authSent: false, failed: false };
		cycle = attempt;
		pending = (async () => {
			const auth = await getToken();
			if (
				stopped ||
				cycle !== attempt ||
				zero.connection.state.current.name === "connected"
			)
				return;
			onSessionExpired(false);
			attempt.authSent = true;
			await zero.connection.connect({ auth });
		})()
			.catch((error: unknown) => {
				if (stopped || cycle !== attempt) return;
				fail(attempt);
				if (error instanceof SessionExpiredError) {
					terminalRefusal = true;
					clearTimer();
					onSessionExpired(true);
				}
				onError(error);
			})
			.finally(() => {
				pending = undefined;
				if (!stopped && (cycle !== attempt || attempt.failed)) retry();
			});
	}

	const onState = (state: ConnectionState) => {
		if (stopped) return;
		const transitioned = state.name !== previousState;
		previousState = state.name;
		if (state.name === "connected") {
			clearTimer();
			failures = 0;
			authRejections = 0;
			nextAttemptAt = 0;
			cycle = undefined;
			terminalRefusal = false;
			onSessionExpired(false);
			onAuthRejected(false);
		} else if (state.name === "needs-auth") {
			// The public needs-auth transition means the submitted credential was
			// refused; duplicate state notifications are not new rejections.
			if (transitioned && cycle?.authSent) fail(cycle, true);
			retry();
		}
	};

	const unsubscribe = zero.connection.state.subscribe(onState);
	const stopRetry = retrySignals(() => {
		if (
			stopped ||
			pending ||
			(cycle?.authSent && !cycle.failed) ||
			zero.connection.state.current.name !== "needs-auth" ||
			Date.now() < nextAttemptAt
		)
			return;
		// A refused session never starts a timer. Only a later explicit signal
		// may check whether another tab has restored the session.
		terminalRefusal = false;
		retry();
	});
	onState(zero.connection.state.current);
	return () => {
		stopped = true;
		clearTimer();
		unsubscribe();
		stopRetry();
	};
}
