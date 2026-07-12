type ConnectionState = { name: string };

type ZeroConnection = {
	state: {
		current: ConnectionState;
		subscribe(listener: (state: ConnectionState) => void): () => void;
	};
	connect(options: { auth: string }): Promise<void>;
};

export async function fetchZeroToken(): Promise<string> {
	const response = await fetch("/api/auth/token", { credentials: "include" });
	if (!response.ok) throw new Error(`token refresh failed: ${response.status}`);
	const body = (await response.json()) as { token?: string };
	if (!body.token) throw new Error("token refresh returned no token");
	return body.token;
}

export function watchZeroAuth(
	zero: { connection: ZeroConnection },
	getToken: () => Promise<string> = fetchZeroToken,
	onError: (error: unknown) => void = console.error,
): () => void {
	let pending: Promise<void> | undefined;
	let stopped = false;

	const onState = (state: ConnectionState) => {
		if (state.name !== "needs-auth" || pending || stopped) return;
		pending = (async () => {
			const auth = await getToken();
			if (!stopped) await zero.connection.connect({ auth });
		})()
			.catch(onError)
			.finally(() => {
				pending = undefined;
			});
	};

	const unsubscribe = zero.connection.state.subscribe(onState);
	onState(zero.connection.state.current);
	return () => {
		stopped = true;
		unsubscribe();
	};
}
