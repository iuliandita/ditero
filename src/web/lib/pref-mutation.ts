function succeeded(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.keys(value).length === 1 &&
		(value as { type?: unknown }).type === "success"
	);
}

export async function mutationServerSucceeded(mutation: {
	client: Promise<unknown>;
	server: Promise<unknown>;
}): Promise<boolean> {
	try {
		// Observe both rejections immediately and finish local bookkeeping before Saved.
		const [client, server] = await Promise.all([
			mutation.client,
			mutation.server,
		]);
		return succeeded(client) && succeeded(server);
	} catch {
		return false;
	}
}
