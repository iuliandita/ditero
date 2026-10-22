import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	finishOAuth,
	json,
	type MockRoute,
	memoryAuth,
	mockProviderEndpoints,
	nowSeconds,
	type SigningKey,
	signedInUser,
	signingKey,
	startOAuth,
	verifiedUser,
} from "../../tests/support/oauth-mocks.ts";

const ISSUER = "https://idp.example.test/realms/home";
const env = {
	DITERO_OIDC_PROVIDERS: "family",
	DITERO_OIDC_FAMILY_ISSUER: ISSUER,
	DITERO_OIDC_FAMILY_CLIENT_ID: "ditero",
	DITERO_OIDC_FAMILY_CLIENT_SECRET: "idp-secret",
	DITERO_OIDC_FAMILY_NAME: "Family SSO",
};

type Token = Record<string, unknown>;
type Fixture = {
	key: SigningKey;
	routes: MockRoute[];
	// What the next token exchange returns; claims get the request's nonce.
	issue(
		claims?: Token,
		options?: { withIdToken?: boolean; key?: SigningKey },
	): void;
	userinfo: Token | null;
	state: { nonce: string; next: () => Promise<Token> };
};

async function idp(): Promise<Fixture> {
	const key = await signingKey();
	const fixture: Fixture = {
		key,
		routes: [],
		userinfo: null,
		issue() {},
		state: { nonce: "", next: async () => ({}) },
	};
	fixture.issue = (claims = {}, options = {}) => {
		fixture.state.next = async () => {
			const body: Token = {
				access_token: "access-token",
				token_type: "Bearer",
				expires_in: 300,
			};
			if (options.withIdToken !== false)
				body.id_token = await (options.key ?? key).sign({
					iss: ISSUER,
					aud: "ditero",
					sub: "user-1",
					email: "ada@example.test",
					email_verified: true,
					name: "Ada",
					nonce: fixture.state.nonce,
					iat: nowSeconds(),
					exp: nowSeconds() + 300,
					...claims,
				});
			return body;
		};
	};
	fixture.issue();
	fixture.routes = [
		(r) =>
			r.url.href === `${ISSUER}/.well-known/openid-configuration`
				? json({
						issuer: ISSUER,
						authorization_endpoint: `${ISSUER}/auth`,
						token_endpoint: `${ISSUER}/token`,
						userinfo_endpoint: `${ISSUER}/userinfo`,
						jwks_uri: `${ISSUER}/keys`,
						id_token_signing_alg_values_supported: ["RS256"],
					})
				: undefined,
		(r) => (r.url.href === `${ISSUER}/keys` ? json(key.jwks) : undefined),
		async (r) =>
			r.url.href === `${ISSUER}/token`
				? json(await fixture.state.next())
				: undefined,
		(r) =>
			r.url.href === `${ISSUER}/userinfo`
				? fixture.userinfo
					? json(fixture.userinfo)
					: json({ error: "unauthorized" }, 401)
				: undefined,
	];
	return fixture;
}

async function setup(options: Parameters<typeof memoryAuth>[0] = { env }) {
	const fixture = await idp();
	const mocks = mockProviderEndpoints(fixture.routes);
	const built = memoryAuth(options);
	await built.auth.$context;
	return { ...built, fixture, mocks };
}

async function signInAs(
	harness: Awaited<ReturnType<typeof setup>>,
	session?: Map<string, string>,
) {
	const started = await startOAuth(harness.auth, "family", {
		session,
		link: session !== undefined,
	});
	harness.fixture.state.nonce =
		started.authorization.searchParams.get("nonce") ?? "";
	return {
		started,
		outcome: await finishOAuth(harness.auth, "family", started),
	};
}

// Password hashing and RSA key generation are slow on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("generic OpenID Connect sign-in", () => {
	test("uses authorization code with S256 PKCE, state and nonce", async () => {
		const h = await setup();
		const { started, outcome } = await signInAs(h);
		const query = started.authorization.searchParams;
		expect(started.authorization.origin + started.authorization.pathname).toBe(
			`${ISSUER}/auth`,
		);
		expect(query.get("response_type")).toBe("code");
		expect(query.get("client_id")).toBe("ditero");
		expect(query.get("redirect_uri")).toBe(
			"http://localhost:3000/api/auth/callback/family",
		);
		expect(query.get("scope")?.split(" ")).toEqual(
			expect.arrayContaining(["openid", "email", "profile"]),
		);
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("state")).toBeTruthy();
		expect(query.get("nonce")).toBeTruthy();
		const token = h.mocks.calls.find((c) => c.url.href === `${ISSUER}/token`);
		const verifier = token?.form.get("code_verifier") ?? "";
		expect(verifier.length).toBeGreaterThanOrEqual(43);
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
			query.get("code_challenge"),
		);
		expect(token?.headers.get("authorization")).toMatch(/^Basic /);
		expect(outcome.error).toBeNull();
		expect(outcome.location?.pathname).toBe("/done");
	});

	test("keys the account on issuer and subject, not on the email", async () => {
		const h = await setup();
		await signInAs(h);
		expect(h.store.user).toHaveLength(1);
		expect(h.store.account).toEqual([
			expect.objectContaining({
				providerId: "family",
				accountId: `${ISSUER}#user-1`,
			}),
		]);
		h.fixture.issue({ email: "renamed@example.test", name: "Ada L" });
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
		expect(h.store.account).toHaveLength(1);
		expect(h.store.user[0]).toMatchObject({ email: "ada@example.test" });
	});

	test("never links a new subject to an existing account by email", async () => {
		const h = await setup();
		await verifiedUser(h, "ada@example.test");
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(outcome.jar.has("better-auth.session_token")).toBe(false);
		expect(
			h.store.account.filter((a) => a.providerId === "family"),
		).toHaveLength(0);
		expect(h.store.user).toHaveLength(1);
	});

	test("links explicitly for a signed-in user, even with a different unverified email", async () => {
		const h = await setup();
		const session = await signedInUser(h.auth, "owner@example.test");
		h.fixture.issue({ email_verified: false });
		const { outcome } = await signInAs(h, session);
		expect(outcome.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
		expect(h.store.account).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "family",
					accountId: `${ISSUER}#user-1`,
				}),
			]),
		);
		// The linked subject now signs in to the same user, without a new account.
		const again = await signInAs(h);
		expect(again.outcome.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
		expect(again.outcome.jar.has("better-auth.session_token")).toBe(true);
	});

	test("refuses to link a subject already owned by another user", async () => {
		const h = await setup();
		await signInAs(h);
		const session = await signedInUser(h.auth, "other@example.test");
		const { outcome } = await signInAs(h, session);
		expect(outcome.error).toBe("account_already_linked_to_different_user");
	});

	test.each([
		["a different issuer", { iss: "https://evil.example.test" }],
		["a different audience", { aud: "someone-else" }],
		["an expired token", { iat: nowSeconds() - 700, exp: nowSeconds() - 400 }],
		["a mismatched nonce", { nonce: "not-the-nonce" }],
		["no subject", { sub: undefined }],
	])("refuses %s", async (_label, claims) => {
		const h = await setup();
		h.fixture.issue(claims);
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("unable_to_get_user_info");
		expect(h.store.user).toHaveLength(0);
		expect(h.store.account).toHaveLength(0);
		expect(h.store.session).toHaveLength(0);
	});

	test("refuses a token signed by a key the issuer does not publish", async () => {
		const h = await setup();
		h.fixture.issue({}, { key: await signingKey("test-key") });
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("unable_to_get_user_info");
		expect(h.store.user).toHaveLength(0);
	});

	test("refuses a token whose issuer differs from the configured one", async () => {
		// The discovery document and the token agree with each other, but not with
		// the issuer the operator configured (here, a trailing slash).
		const h = await setup({
			env: { ...env, DITERO_OIDC_FAMILY_ISSUER: `${ISSUER}/` },
		});
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("unable_to_get_user_info");
		expect(h.store.user).toHaveLength(0);
	});

	test("refuses a response without an ID token", async () => {
		const h = await setup();
		h.fixture.issue({}, { withIdToken: false });
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("unable_to_get_user_info");
		expect(h.store.user).toHaveLength(0);
	});

	test("fills in the email from userinfo only for the same subject", async () => {
		const h = await setup();
		h.fixture.issue({ email: undefined, email_verified: undefined });
		h.fixture.userinfo = {
			sub: "user-1",
			email: "ada@example.test",
			email_verified: true,
		};
		const ok = await signInAs(h);
		expect(ok.outcome.error).toBeNull();
		expect(h.store.user[0]).toMatchObject({
			email: "ada@example.test",
			emailVerified: true,
		});

		const other = await setup();
		other.fixture.issue({ email: undefined, email_verified: undefined });
		other.fixture.userinfo = {
			sub: "someone-else",
			email: "victim@example.test",
			email_verified: true,
		};
		const refused = await signInAs(other);
		expect(refused.outcome.error).toBe("email_not_found");
		expect(other.store.user).toHaveLength(0);
	});

	test("reports a missing email instead of creating a broken account", async () => {
		const h = await setup();
		h.fixture.issue({ email: undefined, email_verified: undefined });
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("email_not_found");
		expect(h.store.user).toHaveLength(0);
	});

	test("refuses unverified OIDC registration in every mode", async () => {
		for (const mode of ["open", "bootstrap", "closed"] as const) {
			const h = await setup({ env, mode, invites: ["ada@example.test"] });
			h.fixture.issue({ email_verified: false });
			const { outcome } = await signInAs(h);
			expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
			expect(h.store.user).toHaveLength(0);
			expect(h.store.account).toHaveLength(0);
			expect(h.store.session).toHaveLength(0);
		}
	});

	test("a client-submitted ID token is not a way to sign in", async () => {
		const h = await setup();
		const idToken = await h.fixture.key.sign({
			iss: ISSUER,
			aud: "ditero",
			sub: "user-1",
			email: "ada@example.test",
			email_verified: true,
			iat: nowSeconds(),
			exp: nowSeconds() + 300,
		});
		const response = await h.auth.handler(
			new Request("http://localhost:3000/api/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({
					provider: "family",
					idToken: { token: idToken },
				}),
			}),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(h.store.user).toHaveLength(0);
		expect(h.store.session).toHaveLength(0);
	});

	test("only providers the operator listed can start a sign-in", async () => {
		const h = await setup();
		const response = await h.auth.handler(
			new Request("http://localhost:3000/api/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({ provider: "github", callbackURL: "/" }),
			}),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	test("discovery recovery does not open client-submitted ID token sign-in", async () => {
		const fixture = await idp();
		let available = false;
		const mocks = mockProviderEndpoints([
			(r) =>
				r.url.href === `${ISSUER}/.well-known/openid-configuration` &&
				!available
					? json({}, 503)
					: undefined,
			...fixture.routes,
		]);
		const h = memoryAuth({ env });
		await h.auth.$context;
		available = true;
		await startOAuth(h.auth, "family");
		expect(
			mocks.calls.filter((r) =>
				r.url.pathname.endsWith("/openid-configuration"),
			),
		).toHaveLength(2);
		const token = await fixture.key.sign({
			iss: ISSUER,
			aud: "ditero",
			sub: "user-1",
			email: "ada@example.test",
			email_verified: true,
			iat: nowSeconds(),
			exp: nowSeconds() + 300,
		});
		const response = await h.auth.handler(
			new Request("http://localhost:3000/api/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:3000",
				},
				body: JSON.stringify({ provider: "family", idToken: { token } }),
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			code: "ID_TOKEN_NOT_SUPPORTED",
		});
		expect(h.store.user).toHaveLength(0);
		expect(h.store.session).toHaveLength(0);
	});
});

describe("registration gate for OpenID Connect sign-ups", () => {
	test.each([
		["open", [], true, true],
		["bootstrap", [], true, true],
		["closed", [], false, "PROVIDER_SIGN_IN_REFUSED"],
	] as const)("%s mode, first account", async (mode, invites, allowed, code) => {
		const h = await setup({ env, mode, invites: [...invites] });
		const { outcome } = await signInAs(h);
		if (allowed) expect(outcome.error).toBeNull();
		else expect(outcome.error).toBe(code);
	});

	test("bootstrap refuses later strangers and honors a verified-email invitation", async () => {
		const h = await setup({
			env,
			mode: "bootstrap",
			invites: ["ada@example.test"],
		});
		await signedInUser(h.auth, "owner@example.test");
		h.fixture.issue({ email: "stranger@example.test" });
		const stranger = await signInAs(h);
		expect(stranger.outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");

		h.fixture.issue({ email: "ada@example.test", email_verified: true });
		const invited = await signInAs(h);
		expect(invited.outcome.error).toBeNull();
	});

	test("an unverified email never satisfies an email invitation", async () => {
		const h = await setup({
			env,
			mode: "closed",
			invites: ["ada@example.test"],
		});
		h.fixture.issue({ email_verified: false });
		const { outcome } = await signInAs(h);
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(h.store.user).toHaveLength(0);
	});
});
