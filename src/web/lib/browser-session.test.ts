import { afterEach, expect, it, vi } from "vitest";
import {
	BROWSER_SESSION_KEY,
	canRestoreBrowserSession,
	forgetBrowserSession,
	isSessionRefusal,
	readBrowserSession,
	rememberBrowserSession,
	SessionExpiredError,
} from "./browser-session.ts";

afterEach(() => vi.unstubAllGlobals());
const identity = { userId: "account-a", expiresAt: 2000 };
const offline = {
	identity,
	error: new TypeError("Failed to fetch"),
	online: false,
	secure: true,
	now: 1000,
};

it.each([
	["offline network failure", {}, true],
	["401", { error: { status: 401 } }, false],
	["403", { error: { status: 403 } }, false],
	["server failure", { error: { status: 503 } }, false],
	["revoked session", { identity: null }, false],
	["expiry boundary", { now: 2000 }, false],
	["expired evidence", { now: 2001 }, false],
	["unverified session", { error: null }, false],
	["online network or trust failure", { online: true }, false],
	["insecure LAN context", { secure: false }, false],
	["unclassified failure", { error: new Error("failure") }, false],
])("cached startup: %s", (_name, patch, expected) => {
	expect(canRestoreBrowserSession({ ...offline, ...patch })).toBe(expected);
});

it("persists only the selected account identity and removes it on revocation or sign-out", () => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key),
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	});
	rememberBrowserSession(identity);
	expect(JSON.parse(values.get(BROWSER_SESSION_KEY) ?? "null")).toEqual(
		identity,
	);
	expect(readBrowserSession()).toEqual(identity);
	rememberBrowserSession({ ...identity, userId: "account-b" });
	expect(readBrowserSession()?.userId).toBe("account-b");
	expect(values.size).toBe(1);
	forgetBrowserSession("account-a");
	expect(readBrowserSession()?.userId).toBe("account-b");
	forgetBrowserSession("account-b");
	expect(readBrowserSession()).toBeNull();
	for (const status of [401, 403]) {
		expect(isSessionRefusal({ status })).toBe(true);
		rememberBrowserSession(null);
		expect(readBrowserSession()).toBeNull();
	}
	expect(isSessionRefusal(new TypeError("offline"))).toBe(false);
	expect(isSessionRefusal({ status: 500 })).toBe(false);
});

it.each([
	"null",
	"{}",
	'{"userId":"","expiresAt":2000}',
	'{"userId":"account-a","expiresAt":"2000"}',
	"bad json",
])("refuses malformed stored evidence %s", (value) => {
	vi.stubGlobal("localStorage", { getItem: () => value });
	expect(readBrowserSession()).toBeNull();
});

it.each([
	new SessionExpiredError("expired"),
	{ code: "session-expired" },
	{ code: "auth-rejected" },
	{ kind: "Unauthorized" },
	{ kind: "AuthInvalidated" },
	{ errorBody: { kind: "PushFailed", reason: "http", status: 403 } },
])("recognizes explicit auth refusals %j", (error) => {
	expect(isSessionRefusal(error)).toBe(true);
});
