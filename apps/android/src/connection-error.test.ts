import { expect, test, vi } from "vitest";

vi.mock("../../../src/paraglide/messages.js", () => ({
	m: {
		native_desktop_online_start_required: () =>
			"An online start is required to open cached data.",
		native_connect_failed: () => "Could not connect.",
	},
}));

import { NativeError } from "./bridge.ts";
import { connectionErrorMessage } from "./connection-error.ts";

test("only desktop session restoration explains the online-start requirement on a network failure", () => {
	expect(connectionErrorMessage(new NativeError("network"), true)).toBe(
		"An online start is required to open cached data.",
	);
	expect(connectionErrorMessage(new NativeError("network"), false)).toBe(
		"Could not connect.",
	);
	for (const code of [
		"unauthorized",
		"verify-failed",
		"session-refused",
		"vault-unavailable",
		"invalid-response",
		"cancelled",
	])
		expect(connectionErrorMessage(new NativeError(code), true)).toBe(
			"Could not connect.",
		);
	expect(connectionErrorMessage(new Error("network"), true)).toBe(
		"Could not connect.",
	);
});
