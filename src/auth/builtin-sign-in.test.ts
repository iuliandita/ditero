import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	BASE,
	finishOAuth,
	json,
	type MockRoute,
	memoryAuth,
	mockProviderEndpoints,
	nowSeconds,
	type Outcome,
	signedInUser,
	signingKey,
	startOAuth,
	verifiedUser,
} from "../../tests/support/oauth-mocks.ts";
import { acceptedAuthOrigins } from "./providers.ts";

// Password hashing and RSA key generation are slow on a loaded CI runner.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

type Harness = Awaited<ReturnType<typeof setup>>;

async function setup(
	env: Record<string, string>,
	routes: MockRoute[],
	options: {
		mode?: "open" | "bootstrap" | "closed";
		invites?: string[];
		io?: Parameters<typeof memoryAuth>[0]["io"];
	} = {},
) {
	const mocks = mockProviderEndpoints(routes);
	const built = memoryAuth({ env, ...options });
	await built.auth.$context;
	return { ...built, mocks };
}

async function signIn(
	h: Harness,
	provider: string,
	options: { form?: boolean } = {},
) {
	const started = await startOAuth(h.auth, provider);
	return {
		started,
		outcome: await finishOAuth(h.auth, provider, started, options),
	};
}

const expectNoAccount = (h: Harness) => {
	expect(h.store.user).toHaveLength(0);
	expect(h.store.account).toHaveLength(0);
	expect(h.store.session).toHaveLength(0);
};

describe("GitHub", () => {
	const env = { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" };
	function github(
		emails: unknown,
		profile: Record<string, unknown> = {},
	): MockRoute[] {
		return [
			(r) =>
				r.url.href === "https://github.com/login/oauth/access_token"
					? json({
							access_token: "gh-token",
							token_type: "bearer",
							scope: "read:user,user:email",
						})
					: undefined,
			(r) =>
				r.url.href === "https://api.github.com/user"
					? json({
							id: 4242,
							login: "ada",
							name: "Ada",
							email: null,
							avatar_url: "https://avatars.example.test/a.png",
							...profile,
						})
					: undefined,
			(r) =>
				r.url.href === "https://api.github.com/user/emails"
					? json(emails)
					: undefined,
		];
	}

	test("signs in with a verified email, PKCE and the numeric account ID", async () => {
		const h = await setup(
			env,
			github([
				{ email: "ada@example.test", primary: true, verified: true },
				{ email: "other@example.test", primary: false, verified: true },
			]),
		);
		const { started, outcome } = await signIn(h, "github");
		const query = started.authorization.searchParams;
		expect(started.authorization.origin).toBe("https://github.com");
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("scope")).toBe("read:user user:email");
		expect(outcome.error).toBeNull();
		expect(h.store.user[0]).toMatchObject({
			email: "ada@example.test",
			emailVerified: true,
		});
		expect(h.store.account[0]).toMatchObject({
			providerId: "github",
			accountId: "4242",
		});
		expect(
			h.mocks.calls
				.find((c) => c.url.pathname === "/login/oauth/access_token")
				?.form.get("code_verifier"),
		).toBeTruthy();
	});

	test("does not trust an email GitHub reports as unverified", async () => {
		const h = await setup(
			env,
			github([{ email: "ada@example.test", primary: true, verified: false }]),
			{
				mode: "closed",
				invites: ["ada@example.test"],
			},
		);
		const { outcome } = await signIn(h, "github");
		expect(outcome.error).toBe("REGISTRATION_DISABLED");
		expectNoAccount(h);
	});

	test("a verified email satisfies an invitation in a closed instance", async () => {
		const h = await setup(
			env,
			github([{ email: "ada@example.test", primary: true, verified: true }]),
			{
				mode: "closed",
				invites: ["ada@example.test"],
			},
		);
		expect((await signIn(h, "github")).outcome.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
	});

	test("explains a missing email instead of creating a broken account", async () => {
		const h = await setup(env, github([]));
		expect((await signIn(h, "github")).outcome.error).toBe("email_not_found");
		expectNoAccount(h);
	});

	test("a matching verified email does not link to an existing account", async () => {
		const h = await setup(
			env,
			github([{ email: "ada@example.test", primary: true, verified: true }]),
		);
		await verifiedUser(h, "ada@example.test");
		const { outcome } = await signIn(h, "github");
		expect(outcome.error).toBe("account_not_linked");
		expect(
			h.store.account.filter((a) => a.providerId === "github"),
		).toHaveLength(0);
	});

	test("refuses a failed token exchange", async () => {
		const h = await setup(env, [
			(r) =>
				r.url.pathname === "/login/oauth/access_token"
					? json({ error: "bad_verification_code" })
					: undefined,
		]);
		expect((await signIn(h, "github")).outcome.error).not.toBeNull();
		expectNoAccount(h);
	});
});

describe("Discord", () => {
	const env = {
		DISCORD_CLIENT_ID: "dc-id",
		DISCORD_CLIENT_SECRET: "dc-secret",
	};
	function discord(profile: Record<string, unknown>): MockRoute[] {
		return [
			(r) =>
				r.url.href === "https://discord.com/api/oauth2/token"
					? json({ access_token: "dc-token", token_type: "Bearer" })
					: undefined,
			(r) =>
				decodeURIComponent(r.url.href) === "https://discord.com/api/users/@me"
					? json({
							id: "80351110224678912",
							username: "ada",
							global_name: "Ada",
							avatar: null,
							discriminator: "0",
							...profile,
						})
					: undefined,
		];
	}

	test("signs in with the verified flag and the snowflake ID", async () => {
		const h = await setup(
			env,
			discord({ email: "ada@example.test", verified: true }),
		);
		const { started, outcome } = await signIn(h, "discord");
		expect(started.authorization.searchParams.get("scope")).toBe(
			"identify email",
		);
		expect(outcome.error).toBeNull();
		expect(h.store.user[0]).toMatchObject({
			email: "ada@example.test",
			emailVerified: true,
		});
		expect(h.store.account[0]).toMatchObject({
			providerId: "discord",
			accountId: "80351110224678912",
		});
	});

	test("an unverified Discord email does not count for an invitation", async () => {
		const h = await setup(
			env,
			discord({ email: "ada@example.test", verified: false }),
			{
				mode: "closed",
				invites: ["ada@example.test"],
			},
		);
		expect((await signIn(h, "discord")).outcome.error).toBe(
			"REGISTRATION_DISABLED",
		);
		expectNoAccount(h);
	});

	test("explains a missing email", async () => {
		const h = await setup(env, discord({ email: null, verified: false }));
		expect((await signIn(h, "discord")).outcome.error).toBe("email_not_found");
		expectNoAccount(h);
	});

	test("does not link to a same-email account", async () => {
		const h = await setup(
			env,
			discord({ email: "ada@example.test", verified: true }),
		);
		await verifiedUser(h, "ada@example.test");
		expect((await signIn(h, "discord")).outcome.error).toBe(
			"account_not_linked",
		);
	});
});

describe("Facebook", () => {
	const env = {
		FACEBOOK_CLIENT_ID: "fb-id",
		FACEBOOK_CLIENT_SECRET: "fb-secret",
	};
	function facebook(
		options: { appId?: string; email?: string | null } = {},
	): MockRoute[] {
		return [
			(r) =>
				r.url.pathname.endsWith("/oauth/access_token")
					? json({
							access_token: "fb-token",
							token_type: "bearer",
							expires_in: 3600,
						})
					: undefined,
			(r) =>
				r.url.pathname === "/debug_token"
					? json({
							data: {
								is_valid: true,
								app_id: options.appId ?? "fb-id",
								user_id: "fb-user-1",
							},
						})
					: undefined,
			(r) =>
				r.url.pathname === "/me"
					? json({
							id: "fb-user-1",
							name: "Ada",
							...(options.email === null
								? {}
								: {
										email: options.email ?? "ada@example.test",
										// Even a profile that claims verification is not believed.
										email_verified: true,
									}),
							picture: { data: { url: "https://cdn.example.test/p.png" } },
						})
					: undefined,
		];
	}

	test("signs in but never treats the email as verified", async () => {
		const h = await setup(env, facebook());
		const { started, outcome } = await signIn(h, "facebook");
		expect(started.authorization.searchParams.get("scope")).toBe(
			"email public_profile",
		);
		expect(outcome.error).toBeNull();
		expect(h.store.user[0]).toMatchObject({
			email: "ada@example.test",
			emailVerified: false,
		});
		expect(h.store.account[0]).toMatchObject({
			providerId: "facebook",
			accountId: "fb-user-1",
		});
	});

	test("its email cannot satisfy an invitation", async () => {
		const h = await setup(env, facebook(), {
			mode: "closed",
			invites: ["ada@example.test"],
		});
		expect((await signIn(h, "facebook")).outcome.error).toBe(
			"REGISTRATION_DISABLED",
		);
		expectNoAccount(h);
	});

	test("its email cannot link to an existing account", async () => {
		const h = await setup(env, facebook());
		await verifiedUser(h, "ada@example.test");
		expect((await signIn(h, "facebook")).outcome.error).toBe(
			"account_not_linked",
		);
	});

	test("refuses a token issued to a different Facebook app", async () => {
		const h = await setup(env, facebook({ appId: "someone-elses-app" }));
		expect((await signIn(h, "facebook")).outcome.error).toBe(
			"unable_to_get_user_info",
		);
		expectNoAccount(h);
	});

	test("explains a user who declined to share an email", async () => {
		const h = await setup(env, facebook({ email: null }));
		expect((await signIn(h, "facebook")).outcome.error).toBe("email_not_found");
		expectNoAccount(h);
	});
});

describe("Microsoft", () => {
	const TENANT = "11111111-2222-3333-4444-555555555555";
	const CONSUMER = "9188040d-6c67-4c5b-b112-36a304b66dad";
	const base = {
		MICROSOFT_CLIENT_ID: "ms-id",
		MICROSOFT_CLIENT_SECRET: "ms-secret",
	};

	async function microsoft(tenantSetting: string) {
		const key = await signingKey("ms-key");
		const state = { claims: {} as Record<string, unknown>, key };
		const tenantPath = tenantSetting.toLowerCase();
		const routes: MockRoute[] = [
			async (r) =>
				r.url.href ===
				`https://login.microsoftonline.com/${tenantPath}/oauth2/v2.0/token`
					? json({
							access_token: "ms-token",
							token_type: "Bearer",
							id_token: await state.key.sign(state.claims, { kid: "ms-key" }),
						})
					: undefined,
			(r) =>
				r.url.href ===
				`https://login.microsoftonline.com/${tenantPath}/discovery/v2.0/keys`
					? json(key.jwks)
					: undefined,
		];
		const h = await setup({ ...base, MICROSOFT_TENANT: tenantSetting }, routes);
		const claims = (tid: string, extra: Record<string, unknown> = {}) => {
			state.claims = {
				iss: `https://login.microsoftonline.com/${tid}/v2.0`,
				aud: "ms-id",
				tid,
				oid: "oid-0001",
				sub: "pairwise-sub",
				email: "ada@example.test",
				name: "Ada",
				iat: nowSeconds(),
				exp: nowSeconds() + 600,
				...extra,
			};
		};
		return { h, claims, state };
	}

	test("single tenant: keys the account on tenant and object ID, with openid scopes only", async () => {
		const { h, claims } = await microsoft(TENANT);
		claims(TENANT);
		const { started, outcome } = await signIn(h, "microsoft");
		expect(started.authorization.pathname).toBe(
			`/${TENANT}/oauth2/v2.0/authorize`,
		);
		expect(started.authorization.searchParams.get("scope")).toBe(
			"openid profile email",
		);
		expect(
			started.authorization.searchParams.get("code_challenge_method"),
		).toBe("S256");
		expect(outcome.error).toBeNull();
		expect(h.store.account[0]).toMatchObject({
			providerId: "microsoft",
			accountId: `${TENANT}:oid-0001`,
		});
		// The mutable email is not trusted: work-account emails are not verified claims.
		expect(h.store.user[0]).toMatchObject({ emailVerified: false });
		expect(
			h.mocks.calls.some((c) => c.url.hostname === "graph.microsoft.com"),
		).toBe(false);
	});

	test("the same object ID in another tenant is a different account", async () => {
		const { h, claims } = await microsoft("organizations");
		claims("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { email: "a@example.test" });
		await signIn(h, "microsoft");
		claims("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { email: "b@example.test" });
		await signIn(h, "microsoft");
		expect(h.store.account.map((a) => a.accountId)).toEqual([
			"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:oid-0001",
			"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:oid-0001",
		]);
	});

	test("a changed email keeps the same account", async () => {
		const { h, claims } = await microsoft(TENANT);
		claims(TENANT);
		await signIn(h, "microsoft");
		claims(TENANT, { email: "renamed@example.test" });
		const second = await signIn(h, "microsoft");
		expect(second.outcome.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
		expect(h.store.account).toHaveLength(1);
	});

	test("single tenant refuses a token from another tenant", async () => {
		const { h, claims } = await microsoft(TENANT);
		claims("99999999-9999-9999-9999-999999999999");
		expect((await signIn(h, "microsoft")).outcome.error).toBe(
			"unable_to_get_user_info",
		);
		expectNoAccount(h);
	});

	test.each([
		["organizations", CONSUMER, false],
		["organizations", "99999999-9999-9999-9999-999999999999", true],
		["consumers", CONSUMER, true],
		["consumers", "99999999-9999-9999-9999-999999999999", false],
		["common", CONSUMER, true],
		["common", "99999999-9999-9999-9999-999999999999", true],
	] as const)("%s mode with tenant %s", async (mode, tid, allowed) => {
		const { h, claims } = await microsoft(mode);
		claims(tid);
		const { outcome } = await signIn(h, "microsoft");
		if (allowed) expect(outcome.error).toBeNull();
		else expect(outcome.error).toBe("unable_to_get_user_info");
	});

	test.each([
		[
			"a forged issuer",
			{ iss: "https://login.microsoftonline.com/other/v2.0" },
		],
		["a different audience", { aud: "someone-else" }],
		[
			"an expired token",
			{ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 },
		],
		["a missing object ID", { oid: undefined }],
	])("refuses %s", async (_label, override) => {
		const { h, claims } = await microsoft("organizations");
		claims("99999999-9999-9999-9999-999999999999", override);
		expect((await signIn(h, "microsoft")).outcome.error).toBe(
			"unable_to_get_user_info",
		);
		expectNoAccount(h);
	});

	test("refuses a token signed by another key", async () => {
		const { h, claims, state } = await microsoft(TENANT);
		state.key = { ...(await signingKey("ms-key")) };
		claims(TENANT);
		expect((await signIn(h, "microsoft")).outcome.error).toBe(
			"unable_to_get_user_info",
		);
	});

	test("explains an account whose token has no email", async () => {
		const { h, claims } = await microsoft(TENANT);
		claims(TENANT, { email: undefined });
		expect((await signIn(h, "microsoft")).outcome.error).toBe(
			"email_not_found",
		);
		expectNoAccount(h);
	});
});

describe("Apple", () => {
	const { privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const env = {
		APPLE_CLIENT_ID: "app.example.web",
		APPLE_TEAM_ID: "ABCDE12345",
		APPLE_KEY_ID: "KEY1234567",
		APPLE_PRIVATE_KEY_FILE: "/keys/apple.p8",
	};
	const io = { readFile: () => pem };

	async function apple(
		claims: Record<string, unknown> = {},
		options: Parameters<typeof setup>[2] = {},
	) {
		const key = await signingKey("apple-key");
		const issued = { nonce: "" };
		const routes: MockRoute[] = [
			async (r) =>
				r.url.href === "https://appleid.apple.com/auth/token"
					? json({
							access_token: "apple-token",
							token_type: "Bearer",
							id_token: await key.sign(
								{
									iss: "https://appleid.apple.com",
									aud: "app.example.web",
									sub: "001234.apple.subject",
									email: "ada@example.test",
									email_verified: "true",
									iat: nowSeconds(),
									exp: nowSeconds() + 600,
									...(issued.nonce ? { nonce: issued.nonce } : {}),
									...claims,
								},
								{ kid: "apple-key" },
							),
						})
					: undefined,
			(r) =>
				r.url.href === "https://appleid.apple.com/auth/keys"
					? json(key.jwks)
					: undefined,
		];
		const h = await setup(env, routes, { io, ...options });
		return { h, issued };
	}

	// Apple answers with a cross-site form POST; the callback hands it to a GET.
	async function appleSignIn(h: Harness, issued: { nonce: string }) {
		const started = await startOAuth(h.auth, "apple");
		issued.nonce = started.authorization.searchParams.get("nonce") ?? "";
		const post = await finishOAuth(h.auth, "apple", started, {
			form: true,
			origin: "https://appleid.apple.com",
		});
		return { started, post };
	}

	test("sends the S256 challenge, a form_post response and an ES256 client secret", async () => {
		const { h, issued } = await apple();
		const started = await startOAuth(h.auth, "apple");
		issued.nonce = started.authorization.searchParams.get("nonce") ?? "";
		const query = started.authorization.searchParams;
		expect(started.authorization.origin).toBe("https://appleid.apple.com");
		expect(query.get("response_mode")).toBe("form_post");
		expect(query.get("code_challenge_method")).toBe("S256");
		const post = await finishOAuth(h.auth, "apple", started, {
			form: true,
			origin: "https://appleid.apple.com",
		});
		expect(post.location?.pathname).toBe("/api/auth/callback/apple");
		await finishOAuth(h.auth, "apple", started);
		const request = h.mocks.calls.find(
			(c) => c.url.href === "https://appleid.apple.com/auth/token",
		);
		const secret = request?.form.get("client_secret") ?? "";
		const claims = decodeJwt(secret);
		expect(claims).toMatchObject({
			iss: "ABCDE12345",
			sub: "app.example.web",
			aud: "https://appleid.apple.com",
		});
		expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(
			15_777_000,
		);
	});

	test("Apple's origin is accepted for the callback POST and nothing else", () => {
		const origins = ["http://localhost:3000"];
		const request = (method: string, path: string) =>
			new Request(`${BASE}${path}`, { method });
		expect(
			acceptedAuthOrigins(
				request("POST", "/api/auth/callback/apple"),
				origins,
				true,
			),
		).toContain("https://appleid.apple.com");
		for (const [method, path, enabled] of [
			["POST", "/api/auth/callback/apple", false],
			["POST", "/api/auth/sign-out", true],
			["POST", "/api/auth/link-social", true],
			["POST", "/api/auth/callback/github", true],
		] as const)
			expect(
				acceptedAuthOrigins(request(method, path), origins, enabled),
			).toEqual(origins);
	});

	test.each([
		["a different audience", { aud: "someone-else" }],
		["a different issuer", { iss: "https://evil.example.test" }],
		[
			"an expired token",
			{ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 },
		],
	])("refuses %s", async (_label, claims) => {
		const { h, issued } = await apple(claims);
		const { started } = await appleSignIn(h, issued);
		const done = await finishOAuth(h.auth, "apple", started);
		expect(done.error).toBe("unable_to_get_user_info");
		expectNoAccount(h);
	});

	test("completes sign-in through the GET hand-off", async () => {
		const { h, issued } = await apple();
		const { started, post } = await appleSignIn(h, issued);
		expect(post.location).not.toBeNull();
		const done = await finishOAuth(h.auth, "apple", started);
		expect(done.error).toBeNull();
		expect(h.store.account[0]).toMatchObject({
			providerId: "apple",
			accountId: "001234.apple.subject",
		});
		expect(h.store.user[0]).toMatchObject({
			email: "ada@example.test",
			emailVerified: true,
		});
	});

	test("a relay address cannot match an invitation and says so", async () => {
		const { h, issued } = await apple(
			{ email: "x1y2z3@privaterelay.appleid.com" },
			{ mode: "bootstrap", invites: ["ada@example.test"] },
		);
		await signedInUser(h.auth, "owner@example.test");
		const { started } = await appleSignIn(h, issued);
		const done = await finishOAuth(h.auth, "apple", started);
		expect(done.error).toBe("REGISTRATION_RELAY_EMAIL");
		expect(h.store.user).toHaveLength(1);
	});

	test("a relay address can still be linked explicitly by a signed-in user", async () => {
		const { h, issued } = await apple({
			email: "x1y2z3@privaterelay.appleid.com",
		});
		const session = await signedInUser(h.auth, "ada@example.test");
		const started = await startOAuth(h.auth, "apple", { session, link: true });
		issued.nonce = started.authorization.searchParams.get("nonce") ?? "";
		const done: Outcome = await finishOAuth(h.auth, "apple", started);
		expect(done.error).toBeNull();
		expect(h.store.user).toHaveLength(1);
		expect(
			h.store.account.filter((a) => a.providerId === "apple"),
		).toHaveLength(1);
	});

	test("a matching email never links implicitly", async () => {
		const { h, issued } = await apple();
		await verifiedUser(h, "ada@example.test");
		const { started } = await appleSignIn(h, issued);
		const done = await finishOAuth(h.auth, "apple", started);
		expect(done.error).toBe("account_not_linked");
	});
});

describe("provider availability", () => {
	test("nothing is configured by default", async () => {
		const h = await setup({}, []);
		const response = await h.auth.handler(
			new Request(`${BASE}/api/auth/sign-in/social`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: BASE },
				body: JSON.stringify({ provider: "github", callbackURL: "/" }),
			}),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(h.mocks.calls).toHaveLength(0);
	});
});
