import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import { assertRegistrationAllowed } from "./registration.ts";
import { registrationAPIError } from "./registration-error.ts";

describe("OAuth registration denial", () => {
	it.each([
		[
			"bootstrap",
			"REGISTRATION_INVITE_REQUIRED",
			"Registration requires an invitation",
		],
		["closed", "REGISTRATION_DISABLED", "Registration is disabled"],
	] as const)("preserves %s policy through the real callback", async (mode, code, message) => {
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
						before: async (_user, context) => {
							try {
								assertRegistrationAllowed(mode, 1);
							} catch (error) {
								throw registrationAPIError(error, context?.path);
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
				id: "new-social-user",
				email: "new@example.test",
				name: "New",
				emailVerified: true,
			},
			data: {},
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
		expect(callback.headers.get("location")).toBe(`/?from=login&error=${code}`);
		expect(store.user).toEqual([]);
		expect(store.account).toEqual([]);
		expect(store.session).toEqual([]);
		try {
			assertRegistrationAllowed(mode, 1);
		} catch (error) {
			expect(registrationAPIError(error, "/sign-up/email").body).toMatchObject({
				code,
				message,
			});
		}
	});

	it.each([
		"/sign-up/email",
		"/callback/google",
	])("logs an unexpected failure on %s without exposing it as policy", (path) => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const cause = new Error("connect ECONNREFUSED db:5432");
		const error = registrationAPIError(cause, path);
		expect(error.status).toBe("INTERNAL_SERVER_ERROR");
		expect(error.body).toEqual({ message: "Registration is unavailable" });
		expect(log).toHaveBeenCalledWith("registration policy check failed", cause);
		log.mockRestore();
	});
});
