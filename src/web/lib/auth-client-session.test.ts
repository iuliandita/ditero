import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

test("the session hook store settles signed-out fetches and exposes pending refetches", async () => {
	let respond!: (response: Response) => void;
	const fetch = vi.fn<
		(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	>(() => new Promise<Response>((resolve) => (respond = resolve)));
	vi.stubGlobal("fetch", fetch);
	const { authClient } = await import("./auth-client.ts");
	const store = authClient.$store.atoms.session;
	const initial = store.get();
	expect(initial).toMatchObject({
		data: null,
		error: null,
		isPending: true,
		isRefetching: false,
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		const refetch = initial.refetch();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(attempt + 1));
		expect(store.get()).toMatchObject({ isPending: true, isRefetching: true });
		respond(Response.json(null));
		await refetch;
		expect(store.get()).toMatchObject({
			data: null,
			error: null,
			isPending: false,
			isRefetching: false,
			refetch: initial.refetch,
		});
	}
	expect(fetch.mock.calls[0]?.[0]).toBe("/api/auth/get-session");
});

test("session transport errors remain distinguishable from HTTP refusals and recover by refetch", async () => {
	const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
	vi.stubGlobal("fetch", fetch);
	const { authClient } = await import("./auth-client.ts");
	const { isConnectionFailure } = await import("./connection-required.ts");
	const store = authClient.$store.atoms.session;
	await store.get().refetch();
	expect(store.get()).toMatchObject({
		data: null,
		isPending: false,
		isRefetching: false,
	});
	expect(isConnectionFailure(store.get().error)).toBe(true);
	for (const status of [401, 403, 500, 503]) {
		fetch.mockImplementation(async () =>
			Response.json({ message: "Refused" }, { status }),
		);
		await store.get().refetch();
		expect(store.get().error).toMatchObject({ status });
		expect(isConnectionFailure(store.get().error)).toBe(false);
	}
	fetch.mockImplementation(async () => Response.json(null));
	await store.get().refetch();
	expect(store.get()).toMatchObject({
		data: null,
		error: null,
		isPending: false,
	});
});
