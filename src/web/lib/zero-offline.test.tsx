import { afterEach, expect, it, vi } from "vitest";
import { AppZeroProvider } from "./zero.tsx";
import { retireZeroClients } from "./zero-lifecycle.ts";

const fixture = vi.hoisted(() => ({
	effects: [] as (() => (() => void) | undefined)[],
	created: [] as Record<string, unknown>[],
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
		connection = {
			state: { current: { name: "disconnected" }, subscribe: () => () => {} },
		};
		constructor(options: Record<string, unknown>) {
			this.userID = options.userID as string;
			fixture.created.push(options);
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
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

it("opens the canonical account store without bootstrap, config, credentials, network sync, or auth refresh", async () => {
	vi.stubGlobal("window", new EventTarget());
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
