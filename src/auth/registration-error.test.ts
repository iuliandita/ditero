import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import { assertRegistrationAllowed } from "./registration.ts";
import { registrationAPIError } from "./registration-error.ts";

describe("OAuth registration denial", () => {
	it.each([
		[
			"bootstrap policy",
			"REGISTRATION_INVITE_REQUIRED",
			"Registration requires an invitation",
			() => assertRegistrationAllowed("bootstrap", 1),
		],
		[
			"closed policy",
			"REGISTRATION_DISABLED",
			"Registration is disabled",
			() => assertRegistrationAllowed("closed", 1),
		],
		[
			"policy lookup outage",
			"REGISTRATION_UNAVAILABLE",
			"Registration is unavailable",
			() => {
				throw new Error("connect ECONNREFUSED db:5432");
			},
		],
	] as const)("preserves %s through the real callback", async (_name, code, message, check) => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const store = { user: [], account: [], session: [], verification: [] };
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "oauth-registration-test-secret-32-bytes",
			database: memoryAdapter(store),
			logger: { disabled: true },
			socialProviders: {
				google: { clientId: "test-id", clientSecret: "test-secret" },
			},
			databaseHooks: {
				user: {
					create: {
						before: async () => {
							try {
								check();
							} catch (error) {
								throw registrationAPIError(error);
							}
						},
					},
				},
			},
		});
		const context = await auth.$context;
		const google = context.socialProviders[0];
		vi.spyOn(google, "validateAuthorizationCode").mockResolvedValue({
			accessToken: "test-token",
		});
		vi.spyOn(google, "getUserInfo").mockResolvedValue({
			user: {
				email: "new@example.test",
				name: "New",
				emailVerified: true,
			},
			data: { sub: "new-social-user" },
		});
		const start = await auth.handler(
			new Request("http://localhost:3000/api/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					provider: "google",
					callbackURL: "/",
					errorCallbackURL: "/?from=login",
				}),
			}),
		);
		expect(start.status).toBe(200);
		const { url } = await start.json();
		const state = new URL(url).searchParams.get("state");
		const cookie = start.headers
			.getSetCookie()
			.map((value) => value.split(";")[0])
			.join("; ");
		const callback = await auth.handler(
			new Request(
				`http://localhost:3000/api/auth/callback/google?code=test-code&state=${state}`,
				{ headers: { cookie } },
			),
		);
		expect(callback.status).toBe(302);
		const location = callback.headers.get("location");
		if (!location) throw new Error("Missing OAuth error redirect");
		const redirect = new URL(location, "http://localhost:3000");
		expect(redirect.pathname).toBe("/");
		expect(Object.fromEntries(redirect.searchParams)).toEqual({
			from: "login",
			error: code,
			error_description: message,
		});
		expect(store.user).toEqual([]);
		expect(store.account).toEqual([]);
		expect(store.session).toEqual([]);
		try {
			check();
		} catch (error) {
			expect(registrationAPIError(error).body).toMatchObject({
				code,
				message,
			});
		}
		log.mockRestore();
	});

	it("logs an unexpected failure without exposing it as policy", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const cause = new Error("connect ECONNREFUSED db:5432");
		const error = registrationAPIError(cause);
		expect(error.status).toBe("INTERNAL_SERVER_ERROR");
		expect(error.body).toEqual({
			message: "Registration is unavailable",
			code: "REGISTRATION_UNAVAILABLE",
		});
		expect(log).toHaveBeenCalledWith("registration policy check failed", cause);
		log.mockRestore();
	});
});
