import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	registerZeroClient,
	retireZeroClients,
	waitForZeroRetirements,
} from "../lib/zero-lifecycle.ts";
import { useUserPref } from "./useUserPref.ts";

const fixture = vi.hoisted(() => ({
	effects: [] as (() => void)[],
	locale: "en",
	rows: [] as Record<string, unknown>[],
	zero: {} as {
		userID: string;
		mutate: (patch: unknown) => {
			client: Promise<unknown>;
			server: Promise<unknown>;
		};
		close: () => Promise<void>;
	},
	applyLocale: vi.fn(),
	show: vi.fn(),
}));

// Run the actual hook effects in registration order without a DOM dependency.
vi.mock("react", () => ({
	useMemo: (read: () => unknown) => read(),
	useCallback: (callback: unknown) => callback,
	useState: () => [0, () => {}],
	useEffect: (effect: () => void) => fixture.effects.push(effect),
}));
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => fixture.zero,
	useQuery: () => [fixture.rows, { type: "complete" }],
}));
vi.mock("../../zero/queries.ts", () => ({
	queries: { userPrefs: { mine: () => ({}) } },
}));
vi.mock("../../zero/mutators.ts", () => ({
	mutators: { userPref: { set: (patch: unknown) => patch } },
}));
vi.mock("../../paraglide/messages.js", () => ({
	m: { sync_save_pending_failed: () => "pending", action_retry: () => "retry" },
}));
vi.mock("../../paraglide/runtime.js", () => ({
	getLocale: () => fixture.locale,
	setLocale: (locale: string) => {
		fixture.locale = locale;
		fixture.applyLocale(locale);
	},
}));
vi.mock("../components/ui/snackbar.tsx", () => ({
	useSnackbar: () => ({ show: fixture.show }),
}));

let account = 0;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function generation(
	userID: string,
	close: () => Promise<void> = async () => {},
) {
	const mutate = vi.fn((_patch: unknown) => ({
		client: Promise.resolve({ type: "success" }),
		server: Promise.resolve({ type: "success" }),
	}));
	const zero = { userID, mutate, close };
	const retired = vi.fn();
	registerZeroClient(userID, zero, retired);
	fixture.zero = zero;
	return { mutate, retired };
}
function PreferenceReader() {
	useUserPref();
	return null;
}
function flushEffects() {
	fixture.effects = [];
	PreferenceReader();
	for (const effect of fixture.effects) effect();
}

beforeEach(() => {
	fixture.locale = "en";
	fixture.applyLocale.mockClear();
	fixture.show.mockClear();
	fixture.rows = [{ timezone: "UTC", timezoneChosen: false, locale: "ar" }];
	vi.stubGlobal("document", { documentElement: { lang: "en", dir: "ltr" } });
	vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
		resolvedOptions: () => ({ timeZone: "Europe/Berlin" }),
	} as Intl.DateTimeFormat);
});
afterEach(async () => {
	await retireZeroClients();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("defers timezone detection until stored-locale retirement reloads the account", async () => {
	const userID = `startup-${++account}`;
	const durable = deferred();
	const old = generation(userID, () => durable.promise);
	try {
		flushEffects();
		expect(old.retired).toHaveBeenCalledOnce();
		expect(old.mutate).not.toHaveBeenCalled();
		expect(fixture.applyLocale).not.toHaveBeenCalled();
	} finally {
		durable.resolve();
		await waitForZeroRetirements();
	}
	// Let reconciliation apply the locale after the shared retirement settles.
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fixture.applyLocale).toHaveBeenCalledExactlyOnceWith("ar");
	const replacement = generation(userID);
	flushEffects();
	expect(replacement.mutate).toHaveBeenCalledExactlyOnceWith({
		timezone: "Europe/Berlin",
	});
	expect(replacement.retired).not.toHaveBeenCalled();
	flushEffects();
	expect(replacement.mutate).toHaveBeenCalledOnce();
	expect(fixture.show).not.toHaveBeenCalled();
});

test.each([
	"en",
	null,
])("detects the timezone without retirement for stored locale %s", (locale) => {
	fixture.rows[0].locale = locale;
	const owner = generation(`startup-${++account}`);
	flushEffects();
	expect(owner.mutate).toHaveBeenCalledExactlyOnceWith({
		timezone: "Europe/Berlin",
	});
	expect(owner.retired).not.toHaveBeenCalled();
});
