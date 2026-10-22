import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { SignJWT } from "jose";
import { expect, test, vi } from "vitest";
import { socialProvidersFromEnv } from "./providers.ts";

test("Google keeps its callback, PKCE and native consent return path with the provider subject", async () => {
	const store = { user: [], account: [], session: [], verification: [] };
	const auth = betterAuth({
		baseURL: "http://localhost:3000",
		secret: "google-callback-test-secret-32-bytes",
		database: memoryAdapter(store),
		socialProviders: socialProvidersFromEnv({
			GOOGLE_CLIENT_ID: "test-id",
			GOOGLE_CLIENT_SECRET: "test-secret",
		}),
	});
	const grantId = `${"a".repeat(42)}A`;
	const returnURL = `http://localhost:3000/native/authorize?grantId=${grantId}`;
	const start = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-in/social", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
			},
			body: JSON.stringify({ provider: "google", callbackURL: returnURL }),
		}),
	);
	expect(start.status).toBe(200);
	const authorization = new URL((await start.json()).url);
	expect(authorization.origin).toBe("https://accounts.google.com");
	expect(authorization.searchParams.get("redirect_uri")).toBe(
		"http://localhost:3000/api/auth/callback/google",
	);
	expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
	expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
	const state = authorization.searchParams.get("state");
	expect(state).toBeTruthy();
	const context = await auth.$context;
	const exchange = vi
		.spyOn(context.socialProviders[0], "validateAuthorizationCode")
		.mockResolvedValue({
			accessToken: "test-token",
			idToken: await new SignJWT({
				sub: "google-stable-subject",
				email: "social@example.test",
				email_verified: true,
				name: "Social user",
			})
				.setProtectedHeader({ alg: "HS256" })
				.sign(new TextEncoder().encode("test-only-token-secret")),
		});
	const callback = await auth.handler(
		new Request(
			`http://localhost:3000/api/auth/callback/google?code=test-code&state=${state}`,
			{
				headers: {
					cookie: start.headers
						.getSetCookie()
						.map((value) => value.split(";")[0])
						.join("; "),
				},
			},
		),
	);
	expect(callback.status).toBe(302);
	expect(callback.headers.get("location")).toBe(returnURL);
	expect(exchange).toHaveBeenCalledWith(
		expect.objectContaining({
			code: "test-code",
			codeVerifier: expect.any(String),
			redirectURI: "http://localhost:3000/api/auth/callback/google",
		}),
	);
	expect(store.account).toEqual([
		expect.objectContaining({
			providerId: "google",
			accountId: "google-stable-subject",
		}),
	]);
	const session = await auth.api.getSession({
		headers: new Headers({
			cookie: callback.headers
				.getSetCookie()
				.map((value) => value.split(";")[0])
				.join("; "),
		}),
	});
	expect(session?.user.email).toBe("social@example.test");
	expect(store.session).toHaveLength(1);
});
