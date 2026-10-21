import { afterEach, expect, it, vi } from "vitest";
import {
	readBrowserSession,
	rememberBrowserSession,
} from "./browser-session.ts";
import { AppZeroProvider } from "./zero.tsx";
import { retireZeroClients } from "./zero-lifecycle.ts";
import { browserZeroRuntime } from "./zero-runtime.ts";

const fixture = vi.hoisted(() => ({
	effects: [] as (() => (() => void) | undefined)[],
	created: [] as Record<string, unknown>[],
	instances: [] as {
		mutate: () => { client: Promise<unknown> };
		persist: ReturnType<typeof vi.fn<() => Promise<void>>>;
	}[],
	persist: vi.fn(async () => {}),
	watchAuth: vi.fn(),
	close: vi.fn(async () => {}),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (value: unknown) => [value, vi.fn()],
	useRef: (value: unknown) => ({ current: value }),
	useEffect: (effect: () => (() => void) | undefined) =>
		fixture.effects.push(effect),
}));
vi.mock("@rocicorp/zero", () => ({
	Zero: class {
		userID: string;
		clientID = "client-a";
		mutate = () => ({
			client: Promise.resolve({ type: "success" }),
			server: new Promise(() => {}),
		});
		close = fixture.close;
		persist = fixture.persist;
		connection = {
			state: { current: { name: "disconnected" }, subscribe: () => () => {} },
		};
		constructor(options: Record<string, unknown>) {
			this.userID = options.userID as string;
			fixture.created.push(options);
			fixture.instances.push(this);
		}
	},
}));
vi.mock("../../zero/mutators.ts", () => ({ mutators: {} }));
vi.mock("../../zero/schema.gen.ts", () => ({ schema: {} }));
vi.mock("./zero-auth.ts", async (original) => ({
	...(await original<typeof import("./zero-auth.ts")>()),
	watchZeroAuth: fixture.watchAuth,
}));
vi.mock("./export-boundary.ts", () => ({
	createExportBoundary: () => ({
		wrapMutation: (mutate: () => unknown) => mutate(),
		dispose() {},
		refreshJournal() {},
		connectionChanged() {},
	}),
}));

afterEach(async () => {
	await retireZeroClients();
	fixture.effects = [];
	fixture.created = [];
	fixture.instances = [];
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("opens the canonical account store without bootstrap, config, credentials, network sync, or auth refresh", async () => {
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("document", new EventTarget());
	const runtime = {
		kind: "browser" as const,
		bootstrap: vi.fn(),
		fetchConfig: vi.fn(),
		getAuth: vi.fn(),
	};
	AppZeroProvider({
		userID: "account-a",
		offline: true,
		runtime,
		children: null,
	});
	const cleanup = fixture.effects[0]();
	try {
		await vi.waitFor(() => expect(fixture.created).toHaveLength(1));
		expect(fixture.created[0]).toMatchObject({
			userID: "account-a",
			cacheURL: null,
			auth: undefined,
			storageKey: undefined,
		});
		expect(runtime.bootstrap).not.toHaveBeenCalled();
		expect(runtime.fetchConfig).not.toHaveBeenCalled();
		expect(runtime.getAuth).not.toHaveBeenCalled();
		expect(fixture.watchAuth).not.toHaveBeenCalled();
	} finally {
		cleanup?.();
	}
	await retireZeroClients();
	expect(fixture.close).toHaveBeenCalledOnce();
});

function browserFixture() {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key),
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
	vi.stubGlobal("window", new EventTarget());
	vi.stubGlobal("document", new EventTarget());
	vi.stubGlobal("navigator", { onLine: true });
	vi.spyOn(console, "error").mockImplementation(() => {});
	rememberBrowserSession({
		userId: "account-a",
		expiresAt: Date.now() + 60000,
	});
}

it.each(
	[401, 403].flatMap((status) =>
		["/api/bootstrap", "/api/config", "/api/auth/token"].map((endpoint) => ({
			status,
			endpoint,
		})),
	),
)("removes cached identity after startup $endpoint refuses $status", async ({
	status,
	endpoint,
}) => {
	browserFixture();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (path: string) =>
			path === endpoint
				? new Response(null, { status })
				: Response.json({ zeroURL: "wss://example.com", token: "token" }),
		),
	);
	AppZeroProvider({
		userID: "account-a",
		runtime: browserZeroRuntime,
		children: null,
	});
	const cleanup = fixture.effects[0]();
	try {
		await vi.waitFor(() => expect(readBrowserSession()).toBeNull());
		expect(fixture.created).toHaveLength(0);
	} finally {
		cleanup?.();
	}
});

it("removes cached identity on each Zero auth refusal signal without clearing a replacement account", async () => {
	browserFixture();
	const runtime = {
		kind: "browser" as const,
		bootstrap: vi.fn(async () => {}),
		fetchConfig: vi.fn(async () => ({
			zeroURL: "wss://example.com",
			socialProviders: [],
		})),
		getAuth: vi.fn(async () => "token"),
	};
	AppZeroProvider({ userID: "account-a", runtime, children: null });
	const cleanup = fixture.effects[0]();
	try {
		await vi.waitFor(() => expect(fixture.watchAuth).toHaveBeenCalledOnce());
		const options = fixture.watchAuth.mock.calls[0][3];
		for (const refuse of [
			() => options.onAuthRefused(),
			() => options.onSessionExpired(true),
			() => options.onAuthRejected(true),
			() => fixture.watchAuth.mock.calls[0][2]({ status: 403 }),
		]) {
			rememberBrowserSession({
				userId: "account-a",
				expiresAt: Date.now() + 60000,
			});
			refuse();
			expect(readBrowserSession()).toBeNull();
			rememberBrowserSession({
				userId: "account-b",
				expiresAt: Date.now() + 60000,
			});
			refuse();
			expect(readBrowserSession()?.userId).toBe("account-b");
		}
	} finally {
		cleanup?.();
	}
});

it.each([
	"/api/config",
	"/api/auth/token",
])("invalidates a delayed auth refusal even after %s fails first", async (early) => {
	browserFixture();
	const late = early === "/api/config" ? "/api/auth/token" : "/api/config";
	let release!: (response: Response) => void;
	vi.stubGlobal(
		"fetch",
		vi.fn((path: string) => {
			if (path === late)
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			return Promise.resolve(
				path === early
					? new Response(null, { status: 503 })
					: Response.json({}),
			);
		}),
	);
	AppZeroProvider({
		userID: "account-a",
		runtime: browserZeroRuntime,
		children: null,
	});
	const cleanup = fixture.effects[0]();
	try {
		await vi.waitFor(() =>
			expect(console.error).toHaveBeenCalledWith(
				"Zero startup failed",
				expect.any(Error),
			),
		);
		expect(readBrowserSession()?.userId).toBe("account-a");
		release(new Response(null, { status: 401 }));
		await vi.waitFor(() => expect(readBrowserSession()).toBeNull());
		expect(fixture.created).toHaveLength(0);
	} finally {
		cleanup?.();
	}
});

it("keeps unsaved edits protected after failed retirement and removes the warning after a successful retry", async () => {
	browserFixture();
	fixture.persist.mockRejectedValue(new Error("disk full"));
	fixture.close.mockRejectedValueOnce(new Error("disk full"));
	AppZeroProvider({ userID: "account-a", offline: true, children: null });
	const cleanup = fixture.effects[0]();
	const unload = () => {
		const event = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(event);
		return event.defaultPrevented;
	};
	try {
		await vi.waitFor(() => expect(fixture.instances).toHaveLength(1));
		await fixture.instances[0].mutate().client;
		expect(unload()).toBe(true);
		await expect(retireZeroClients()).rejects.toThrow("disk full");
		expect(unload()).toBe(true);
		fixture.persist.mockResolvedValue(undefined);
		await retireZeroClients();
		expect(unload()).toBe(false);
	} finally {
		fixture.persist.mockResolvedValue(undefined);
		cleanup?.();
	}
});
