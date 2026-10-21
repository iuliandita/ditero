import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	readBrowserSession,
	rememberBrowserSession,
} from "./browser-session.ts";
import { createBrowserSessionFetch } from "./browser-session-fetch.ts";

const evidence = { userId: "account-a", expiresAt: Date.now() + 60_000 };
const session = () =>
	Response.json({
		user: { id: evidence.userId },
		session: { expiresAt: new Date(evidence.expiresAt).toISOString() },
	});
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key),
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
	vi.stubGlobal(
		"window",
		Object.assign(new EventTarget(), {
			location: { origin: "https://example.com" },
		}),
	);
	vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	"before sign-out",
	"during sign-out",
])("discards verification issued %s and clears again after it settles", async (timing) => {
	let release!: (response: Response) => void;
	let finishSignOut!: (response: Response) => void;
	const network = vi.fn<
		(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	>((input) =>
		String(input).endsWith("/get-session")
			? new Promise((resolve) => {
					release = resolve;
				})
			: new Promise((resolve) => {
					finishSignOut = resolve;
				}),
	);
	const fetchSession = createBrowserSessionFetch(network);
	rememberBrowserSession(evidence);
	const verification =
		timing === "before sign-out"
			? fetchSession("/api/auth/get-session")
			: undefined;
	const signingOut = fetchSession("/api/auth/sign-out");
	const during =
		timing === "during sign-out"
			? fetchSession("/api/auth/get-session")
			: undefined;
	expect(readBrowserSession()).toBeNull();
	finishSignOut(Response.json({ success: true }));
	await signingOut;
	release(session());
	expect(await (await (verification ?? during))?.json()).toBeNull();
	await vi.waitFor(() => expect(readBrowserSession()).toBeNull());
});

it("fences an authoritative null response while allowing fresh sign-in verification", async () => {
	let release!: (response: Response) => void;
	const network = vi
		.fn<typeof fetch>()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		)
		.mockResolvedValueOnce(Response.json(null))
		.mockResolvedValueOnce(Response.json({ success: true }))
		.mockResolvedValueOnce(session());
	const fetchSession = createBrowserSessionFetch(network);
	const stale = fetchSession("/api/auth/get-session");
	await fetchSession("/api/auth/get-session");
	release(session());
	expect(await (await stale).json()).toBeNull();
	expect(readBrowserSession()).toBeNull();
	await fetchSession("/api/auth/sign-in/email");
	await fetchSession("/api/auth/get-session");
	expect(readBrowserSession()).toEqual(evidence);
});

it("fences verification when another tab changes accounts", async () => {
	let release!: (response: Response) => void;
	const network = vi.fn<typeof fetch>().mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const fetchSession = createBrowserSessionFetch(network);
	const pending = fetchSession("/api/auth/get-session");
	const replacement = { ...evidence, userId: "account-b" };
	rememberBrowserSession(replacement);
	window.dispatchEvent(
		Object.assign(new Event("storage"), { key: "ditero.browser-session.v1" }),
	);
	release(session());
	expect(await (await pending).json()).toBeNull();
	expect(readBrowserSession()).toEqual(replacement);
});

it("an older sign-out cleanup cannot clear a subsequent sign-in", async () => {
	let release!: (response: Response) => void;
	const network = vi
		.fn<typeof fetch>()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		)
		.mockResolvedValueOnce(Response.json({ success: true }))
		.mockResolvedValueOnce(Response.json({ success: true }))
		.mockResolvedValueOnce(session());
	const fetchSession = createBrowserSessionFetch(network);
	const old = fetchSession("/api/auth/get-session");
	await fetchSession("/api/auth/sign-out");
	await fetchSession("/api/auth/sign-in/email");
	await fetchSession("/api/auth/get-session");
	release(session());
	await old;
	await Promise.resolve();
	expect(readBrowserSession()).toEqual(evidence);
});

it.each([
	"before",
	"during",
])("fences verification started %s another tab signs out, before storage events arrive", async (timing) => {
	vi.resetModules();
	const tabASession = await import("./browser-session.ts");
	const { createBrowserSessionFetch: createTabA } = await import(
		"./browser-session-fetch.ts"
	);
	const tabAWindow = window;
	let finishSignOut!: (response: Response) => void;
	const tabA = createTabA(
		() =>
			new Promise((resolve) => {
				finishSignOut = resolve;
			}),
	);
	tabASession.rememberBrowserSession(evidence);

	vi.resetModules();
	const tabBSession = await import("./browser-session.ts");
	const { createBrowserSessionFetch: createTabB } = await import(
		"./browser-session-fetch.ts"
	);
	const tabBWindow = Object.assign(new EventTarget(), {
		location: { origin: "https://example.com" },
	});
	vi.stubGlobal("window", tabBWindow);
	let release!: (response: Response) => void;
	const tabB = createTabB(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const pending =
		timing === "before" ? tabB("/api/auth/get-session") : undefined;

	vi.stubGlobal("window", tabAWindow);
	const signingOut = tabA("/api/auth/sign-out");
	vi.stubGlobal("window", tabBWindow);
	const changed = vi.fn();
	tabBWindow.addEventListener(tabBSession.BROWSER_SESSION_CHANGED, changed);
	tabBWindow.dispatchEvent(
		Object.assign(new Event("storage"), {
			key: tabBSession.BROWSER_SESSION_KEY,
		}),
	);
	expect(tabBSession.readBrowserSession()).toBeNull();
	const during =
		timing === "during" ? tabB("/api/auth/get-session") : undefined;

	vi.stubGlobal("window", tabAWindow);
	finishSignOut(Response.json({ success: true }));
	await signingOut;
	// Tab B has not received the completion's storage event. Its write must
	// compare the shared generation, even though the identity is already absent.
	vi.stubGlobal("window", tabBWindow);
	release(session());
	expect(await (await (pending ?? during))?.json()).toBeNull();
	expect(tabBSession.readBrowserSession()).toBeNull();
	expect(tabASession.readBrowserSession()).toBeNull();
	expect(changed).toHaveBeenCalled();
});
