import { expect, test } from "vitest";
import { NativeError } from "./bridge.ts";
import { connectErrorMessage } from "./connect-error.ts";

test.each([
	["https-required", "Use an HTTPS server address."],
	["server-not-found", "Server not found. Check the spelling of the address."],
	[
		"certificate-not-trusted",
		"The server certificate is not trusted. Ask its administrator to check it.",
	],
	[
		"server-unreachable",
		"Cannot reach the server. Check your connection and try again.",
	],
	[
		"invalid-origin",
		"Could not connect. Check the server address and connection.",
	],
])("connect failure %s gets actionable localized copy", (code, expected) => {
	expect(connectErrorMessage(new NativeError(code))).toBe(expected);
});

test("only desktop session restoration explains the online-start requirement on a network failure", () => {
	expect(connectErrorMessage(new NativeError("network"), true)).toBe(
		"Desktop needs an online start to open cached data. Reconnect to your server, then select Connect. Your saved changes stay on this device.",
	);
	expect(connectErrorMessage(new NativeError("network"))).toBe(
		"Cannot reach the server. Check your connection and try again.",
	);
	for (const code of [
		"unauthorized",
		"verify-failed",
		"session-refused",
		"vault-unavailable",
		"invalid-response",
		"cancelled",
	])
		expect(connectErrorMessage(new NativeError(code), true)).toBe(
			"Could not connect. Check the server address and connection.",
		);
	expect(connectErrorMessage(new Error("network"), true)).toBe(
		"Could not connect. Check the server address and connection.",
	);
});
