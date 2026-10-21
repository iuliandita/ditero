import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	BASE,
	finishOAuth,
	json,
	memoryAuth,
	mockProviderEndpoints,
	startOAuth,
} from "../../tests/support/oauth-mocks.ts";

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

// The system-browser consent page carries a pending grant in its URL. A provider
// sign-in has to come back to that exact page, whether it succeeds or is refused.
const grantId = `${"a".repeat(42)}A`;
const consent = `${BASE}/native/authorize?grantId=${grantId}`;

function github(email: string | null) {
	return mockProviderEndpoints([
		(r) =>
			r.url.href === "https://github.com/login/oauth/access_token"
				? json({ access_token: "gh-token", token_type: "bearer" })
				: undefined,
		(r) =>
			r.url.href === "https://api.github.com/user"
				? json({ id: 9, login: "ada", name: "Ada", email: null })
				: undefined,
		(r) =>
			r.url.href === "https://api.github.com/user/emails"
				? json(email ? [{ email, primary: true, verified: true }] : [])
				: undefined,
	]);
}

const env = { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };

describe("native consent return path", () => {
	test("a successful provider sign-in returns to the pending consent page", async () => {
		github("ada@example.test");
		const { auth } = memoryAuth({ env });
		const started = await startOAuth(auth, "github", {
			callbackURL: consent,
			errorCallbackURL: consent,
		});
		const outcome = await finishOAuth(auth, "github", started);
		expect(outcome.location?.href).toBe(consent);
		expect(outcome.jar.has("better-auth.session_token")).toBe(true);
	});

	test.each([
		[
			"a registration refusal",
			"ada@example.test",
			"closed",
			"REGISTRATION_DISABLED",
		],
		["a missing email", null, "open", "email_not_found"],
	] as const)("%s keeps the grant on the consent page", async (_label, email, mode, code) => {
		github(email);
		const { auth } = memoryAuth({ env, mode });
		const started = await startOAuth(auth, "github", {
			callbackURL: consent,
			errorCallbackURL: consent,
		});
		const outcome = await finishOAuth(auth, "github", started);
		expect(outcome.location?.pathname).toBe("/native/authorize");
		expect(outcome.location?.searchParams.get("grantId")).toBe(grantId);
		expect(outcome.error).toBe(code);
		expect(outcome.jar.has("better-auth.session_token")).toBe(false);
	});
});
