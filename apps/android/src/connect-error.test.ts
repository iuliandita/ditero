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
