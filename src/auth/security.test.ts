import { afterEach, describe, expect, test, vi } from "vitest";
import {
	authRateLimitOptions,
	passkeyOptions,
	readSignInEmail,
	requireSameOrigin,
	SIGN_IN_BODY_LIMIT,
	signInRateKey,
} from "./security.ts";

describe("authRateLimitOptions", () => {
	afterEach(() => vi.unstubAllEnvs());
	test("uses database storage and tighter sensitive-route limits", () => {
		vi.stubEnv("DITERO_E2E", "0");
		const options = authRateLimitOptions();
		expect(options.storage).toBe("database");
		expect(options.enabled).toBe(true);
		expect(options.customRules["/sign-in/email"]).toEqual({
			window: 60,
			max: 30,
		});
		expect(options.customRules["/two-factor/*"]).toEqual({
			window: 60,
			max: 30,
		});
		expect(options.customRules["/sign-up/email"]).toEqual({
			window: 60,
			max: 10,
		});
		for (const path of ["/get-session", "/token"])
			expect(options.customRules[path]).toEqual({ window: 60, max: 600 });
		expect(options.customRules["/sign-in/sso"]).toEqual({
			window: 60,
			max: 20,
		});
		expect(options.customRules["/sso/saml2/sp/acs/*"]).toEqual({
			window: 60,
			max: 30,
		});
		expect(options.max).toBe(100);
		for (const path of ["/reset-password", "/change-password"])
			expect(options.customRules[path]).toEqual({ window: 300, max: 5 });
		expect(options.customRules["/request-password-reset"]).toEqual({
			window: 300,
			max: 3,
		});
	});
	test("relaxes only the harness per-IP rules", () => {
		vi.stubEnv("DITERO_E2E", "1");
		const options = authRateLimitOptions();
		for (const path of [
			"/sign-in/email",
			"/sign-up/email",
			"/get-session",
			"/token",
		])
			expect(options.customRules[path]).toEqual({ window: 60, max: 1000 });
		expect(options.customRules["/two-factor/*"]).toEqual({
			window: 60,
			max: 30,
		});
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

describe("sign-in identity buckets", () => {
	test("normalizes emails and address forms without storing the email", () => {
		const key = signInRateKey("198.51.100.24", " Member@Example.test ");
		expect(key).toBe(
			signInRateKey("::ffff:198.51.100.24", "member@example.test"),
		);
		expect(key).not.toContain("member");
		expect(key).not.toBe(signInRateKey("198.51.100.24", "other@example.test"));
		expect(key).not.toBe(signInRateKey("198.51.100.25", "member@example.test"));
		expect(signInRateKey("2001:db8::1", "member@example.test")).toBe(
			signInRateKey("2001:db8::2", "member@example.test"),
		);
	});
	test("reads a JSON clone while preserving the handler body", async () => {
		const body = { email: " Member@Example.test ", password: "secret" };
		const request = new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(await readSignInEmail(request)).toBe("member@example.test");
		expect(await request.json()).toEqual(body);
	});
	test.each([
		"{",
		"null",
		"[]",
		'{"email":42}',
		'{"email":""}',
		JSON.stringify({ email: "a".repeat(321) }),
		JSON.stringify({
			email: "member@example.test",
			padding: "a".repeat(SIGN_IN_BODY_LIMIT),
		}),
	])("refuses invalid or oversized bodies: %#", async (body) => {
		const request = new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(await readSignInEmail(request)).toBeNull();
	});
	test("bounds streamed bodies without trusting content-length", async () => {
		const request = new Request("http://localhost/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json", "content-length": "1" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(SIGN_IN_BODY_LIMIT));
					controller.enqueue(new Uint8Array(1));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect(await readSignInEmail(request)).toBeNull();
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
