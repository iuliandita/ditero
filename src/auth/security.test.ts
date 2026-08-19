import { describe, expect, test } from "vitest";
import {
	authRateLimitOptions,
	passkeyOptions,
	requireSameOrigin,
} from "./security.ts";

describe("authRateLimitOptions", () => {
	test("uses database storage and tighter sensitive-route limits", () => {
		const options = authRateLimitOptions();
		expect(options.storage).toBe("database");
		expect(options.enabled).toBe(true);
		expect(options.customRules["/sign-in/email"]).toEqual({
			window: 60,
			max: 5,
		});
		expect(options.customRules["/two-factor/*"]).toEqual({
			window: 60,
			max: 5,
		});
		// /get-session is only relaxed under the e2e harness (DITERO_E2E); prod keeps
		// the default limit, so it must have no customRule here.
		expect(options.customRules["/get-session"]).toBeUndefined();
	});

	test("exempts the passkey list read from the ceremony ceiling, and orders it first", () => {
		const options = authRateLimitOptions();
		expect(options.customRules["/passkey/*"]).toEqual({ window: 60, max: 10 });
		expect(options.customRules["/passkey/list-user-passkeys"]).toEqual({
			window: 60,
			max: 100,
		});
		// Better Auth picks the FIRST customRules key that matches the path, so the
		// exact path is only reachable while it precedes the wildcard.
		const keys = Object.keys(options.customRules);
		expect(keys.indexOf("/passkey/list-user-passkeys")).toBeLessThan(
			keys.indexOf("/passkey/*"),
		);
	});
});

describe("passkeyOptions", () => {
	test("derives the RP ID and exact origin from the public auth URL", () => {
		expect(
			passkeyOptions({ BETTER_AUTH_URL: "https://tasks.example.test/path" }),
		).toEqual({
			rpID: "tasks.example.test",
			rpName: "Ditero",
			origin: "https://tasks.example.test",
		});
	});

	test("supports an explicit parent-domain RP ID", () => {
		expect(
			passkeyOptions({
				BETTER_AUTH_URL: "https://tasks.example.test",
				DITERO_PASSKEY_RP_ID: "example.test",
			}),
		).toMatchObject({ rpID: "example.test" });
	});

	test("supports a separate development web origin", () => {
		expect(
			passkeyOptions({
				BETTER_AUTH_URL: "http://localhost:3000",
				DITERO_PASSKEY_ORIGIN: "http://localhost:5173",
			}),
		).toMatchObject({ rpID: "localhost", origin: "http://localhost:5173" });
	});
});

describe("requireSameOrigin", () => {
	const baseURL = "https://tasks.example.test";

	test("accepts the exact application origin", () => {
		expect(() =>
			requireSameOrigin(
				new Request(`${baseURL}/api/bootstrap`, {
					method: "POST",
					headers: { origin: baseURL },
				}),
				baseURL,
			),
		).not.toThrow();
	});

	test.each([
		undefined,
		"https://evil.test",
		"null",
	])("rejects an absent or foreign origin: %s", (origin) => {
		const headers = origin ? { origin } : undefined;
		expect(() =>
			requireSameOrigin(
				new Request(`${baseURL}/api/bootstrap`, {
					method: "POST",
					headers,
				}),
				baseURL,
			),
		).toThrow(/origin/i);
	});
});
