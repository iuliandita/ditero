import { randomBytes, randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
	vi,
} from "vitest";
import { makeGuards } from "../../src/server/guards.ts";
import { s256Challenge } from "../../src/server/native-auth/contracts.ts";
import { nativeAuthRoutes } from "../../src/server/native-auth/routes.ts";
import { lookupNativeSession } from "../../src/server/native-auth/session.ts";
import { NativeGrantStore } from "../../src/server/native-auth/store.ts";
import { resetAuthFixture } from "../../tests/integration/reset-auth-fixture.ts";
import {
	finishOAuth,
	json,
	type MockRoute,
	mockProviderEndpoints,
	nowSeconds,
	type SigningKey,
	signingKey,
	startOAuth,
} from "../../tests/support/oauth-mocks.ts";
import type { FixtureIdp } from "../../tests/support/saml-idp.ts";

// Auth is configured at import time, so the SAML environment is fixed before
// any module loads and each registration mode boots a fresh module graph.
const idp: FixtureIdp = await vi.hoisted(async () => {
	delete process.env.DITERO_E2E;
	const { createFixtureIdp } = await import("../../tests/support/saml-idp.ts");
	const fixture = createFixtureIdp("https://idp.example.test/entity");
	process.env.DITERO_SAML_IDP_METADATA = fixture.metadataXml;
	process.env.DITERO_SAML_NAME = "Corp SSO";
	process.env.DITERO_SAML_CLOCK_SKEW_SECONDS = "5";
	return fixture;
});

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `federated_factor_${randomUUID().replaceAll("-", "")}`;
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = randomBytes(32).toString("hex");
let roleCreated = false;
beforeAll(async () => {
	const statement = await admin.query(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls', $1::text, $2::text) statement",
		[role, runtimeURL.password],
	);
	await admin.query(statement.rows[0].statement);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	process.env.DATABASE_URL = runtimeURL.href;
});
const ORIGIN = "http://localhost:3000";

type AuthModule = typeof import("../../src/auth/auth.ts");
type Booted = AuthModule & { pool: Pool; origin: string };
const open: Booted[] = [];

async function boot(
	mode: "open" | "bootstrap" | "closed",
	env: Record<string, string | undefined> = {},
): Promise<Booted> {
	vi.resetModules();
	for (const key of Object.keys(process.env))
		if (
			key.startsWith("DITERO_SAML_") ||
			key.startsWith("DITERO_OIDC_") ||
			key.startsWith("GITHUB_CLIENT_")
		)
			delete process.env[key];
	Object.assign(process.env, {
		DITERO_SAML_IDP_METADATA: idp.metadataXml,
		DITERO_SAML_NAME: "Corp SSO",
		DITERO_SAML_CLOCK_SKEW_SECONDS: "5",
		DITERO_REGISTRATION_MODE: mode,
		BETTER_AUTH_URL: ORIGIN,
	});
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const authModule = await import("../../src/auth/auth.ts");
	const client = await import("../../src/db/client.ts");
	const booted = {
		...authModule,
		pool: client.pool,
		origin: process.env.BETTER_AUTH_URL ?? ORIGIN,
	};
	expect(
		(
			await booted.pool.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	open.push(booted);
	return booted;
}

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query("truncate table rate_bucket");
	await admin.query("truncate table invite, workspace cascade");
});

afterEach(async () => {
	vi.unstubAllGlobals();
	for (const booted of open.splice(0)) await booted.pool.end();
});

afterAll(async () => {
	process.env.DATABASE_URL = databaseURL;
	if (roleCreated) {
		await admin.query(`drop owned by "${role}"`);
		await admin.query(`drop role "${role}"`);
	}
	await admin.end();
});

async function startSignIn(
	app: Booted,
	init: {
		callbackURL?: string;
		errorCallbackURL?: string;
		cookie?: string;
		link?: boolean;
		extra?: Record<string, unknown>;
	} = {},
) {
	const provider = app.ssoProviders()[0];
	const response = await app.handleAuthRequest(
		new Request(
			`${app.origin}/api/auth/sign-in/sso${init.link ? "?link=1" : ""}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: app.origin,
					...(init.cookie ? { cookie: init.cookie } : {}),
				},
				body: JSON.stringify({
					providerId: provider.id,
					callbackURL: init.callbackURL ?? "/",
					errorCallbackURL: init.errorCallbackURL ?? "/",
					...init.extra,
				}),
			},
		),
	);
	return response;
}

async function beginFlow(
	app: Booted,
	init: Parameters<typeof startSignIn>[1] = {},
) {
	const response = await startSignIn(app, init);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { url: string };
	return idp.parseRedirect(body.url);
}

function postAcs(
	app: Booted,
	acs: string,
	samlResponse: string,
	relayState: string | null,
	cookie?: string,
) {
	const form = new URLSearchParams({ SAMLResponse: samlResponse });
	if (relayState) form.set("RelayState", relayState);
	return app.handleAuthRequest(
		new Request(acs, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				// The IdP's POST is cross-site: its own origin, and no cookies.
				origin: "https://idp.example.test",
				...(cookie ? { cookie } : {}),
			},
			body: form,
		}),
	);
}

async function signedIn(
	app: Booted,
	flow: Awaited<ReturnType<typeof beginFlow>>,
	overrides: Parameters<FixtureIdp["respond"]>[1] = {},
	cookie?: string,
) {
	return postAcs(
		app,
		flow.acs,
		await idp.respond(flow, overrides),
		flow.relayState,
		cookie,
	);
}

async function passwordSession(app: Booted, email: string) {
	const signUp = await app.handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/sign-up/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ name: "Alice", email, password: "pw-123456" }),
		}),
	);
	expect(signUp.status).toBe(200);
	const signIn = await app.handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ email, password: "pw-123456" }),
		}),
	);
	return signIn.headers
		.getSetCookie()
		.map((cookie: string) => cookie.split(";", 1)[0])
		.join("; ");
}

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

async function oidcIdp(): Promise<Fixture> {
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

function post(app: Booted, path: string, body: unknown, cookie = "") {
	return app.handleAuthRequest(
		new Request(`${ORIGIN}/api/auth${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}
const cookies = (r: Response) =>
	r.headers
		.getSetCookie()
		.map((x) => x.split(";")[0])
		.join("; ");
const cookieMap = (c: string) =>
	new Map(
		c
			.split("; ")
			.filter(Boolean)
			.map((x) => {
				const at = x.indexOf("=");
				return [x.slice(0, at), x.slice(at + 1)];
			}),
	);
const cookieText = (m: Map<string, string>) =>
	[...m].map(([k, v]) => `${k}=${v}`).join("; ");
async function reset(app: Booted, userId: string) {
	const token = randomBytes(24).toString("hex");
	await (await app.auth.$context).internalAdapter.createVerificationValue({
		identifier: `reset-password:${token}`,
		value: userId,
		expiresAt: new Date(Date.now() + 60000),
	});
	const response = await post(app, "/reset-password", {
		token,
		newPassword: "new-password-456",
	});
	expect(response.status).toBe(200);
	return response;
}
async function enroll(app: Booted) {
	const cookie = await passwordSession(app, "local@example.test");
	expect(
		(
			await post(
				app,
				"/two-factor/enable",
				{ password: "pw-123456", method: "totp" },
				cookie,
			)
		).status,
	).toBe(200);
	const context = await app.auth.$context;
	const session = await app.auth.api.getSession({
		headers: new Headers({ cookie }),
	});
	if (!session) throw new Error("missing session");
	const record = await context.adapter.findOne<{ secret: string }>({
		model: "twoFactor",
		where: [{ field: "userId", value: session.user.id }],
	});
	if (!record) throw new Error("missing enrollment");
	const secret = await symmetricDecrypt({
		key: context.secretConfig,
		data: record.secret,
	});
	const verified = await post(
		app,
		"/two-factor/verify-totp",
		await app.auth.api.generateTOTP({ body: { secret } }),
		cookie,
	);
	expect(verified.status).toBe(200);
	const passwordChallenge = await post(app, "/sign-in/email", {
		email: "local@example.test",
		password: "pw-123456",
	});
	expect(await passwordChallenge.json()).toMatchObject({
		twoFactorRedirect: true,
	});
	const remembered = await post(
		app,
		"/two-factor/verify-totp",
		{
			...(await app.auth.api.generateTOTP({ body: { secret } })),
			trustDevice: true,
		},
		cookies(passwordChallenge),
	);
	expect(remembered.status).toBe(200);
	const jar = cookieMap(cookies(remembered));
	expect(cookieText(jar)).toContain("better-auth.trust_device=");
	expect(
		(
			await admin.query('select two_factor_enabled from "user" where id=$1', [
				session.user.id,
			])
		).rows[0].two_factor_enabled,
	).toBe(true);
	return {
		cookie: cookieText(jar),
		userId: session.user.id,
		code: () => app.auth.api.generateTOTP({ body: { secret } }),
	};
}

type Protocol = "SAML" | "OIDC" | "GitHub";
async function linked(protocol: Protocol) {
	const fixture = protocol === "OIDC" ? await oidcIdp() : null;
	if (fixture) mockProviderEndpoints(fixture.routes);
	if (protocol === "GitHub")
		mockProviderEndpoints([
			(r) =>
				r.url.href === "https://github.com/login/oauth/access_token"
					? json({ access_token: "fixture-token", token_type: "bearer" })
					: undefined,
			(r) =>
				r.url.href === "https://api.github.com/user"
					? json({ id: 4242, login: "fixture", name: "Fixture", email: null })
					: undefined,
			(r) =>
				r.url.href === "https://api.github.com/user/emails"
					? json([
							{ email: "local@example.test", primary: true, verified: true },
						])
					: undefined,
		]);
	const app = await boot(
		"open",
		protocol === "OIDC"
			? env
			: protocol === "GitHub"
				? {
						GITHUB_CLIENT_ID: "fixture-id",
						GITHUB_CLIENT_SECRET: "fixture-secret",
					}
				: {},
	);
	const enrollment = await enroll(app);
	const rememberedCookie = cookieText(
		new Map(
			[...cookieMap(enrollment.cookie)].filter(([key]) =>
				key.includes("trust_device"),
			),
		),
	);
	const callback = async (cookie?: string, callbackURL = "/") => {
		if (protocol === "SAML") {
			const response = await signedIn(
				app,
				await beginFlow(app, {
					cookie: cookie ?? rememberedCookie,
					link: Boolean(cookie),
					callbackURL,
				}),
				{},
				cookie ?? rememberedCookie,
			);
			return {
				jar: cookieMap(cookies(response)),
				location: new URL(response.headers.get("location") ?? "/", ORIGIN),
				status: response.status,
			};
		}
		const provider = protocol === "OIDC" ? "family" : "github";
		const started = await startOAuth(
			{ handler: app.handleAuthRequest },
			provider,
			{
				callbackURL,
				errorCallbackURL: "/",
				link: Boolean(cookie),
				session: cookieMap(cookie ?? rememberedCookie),
			},
		);
		if (fixture)
			fixture.state.nonce =
				started.authorization.searchParams.get("nonce") ?? "";
		return finishOAuth({ handler: app.handleAuthRequest }, provider, started);
	};
	const link = await callback(enrollment.cookie);
	expect(link.location?.searchParams.has("error")).toBe(false);
	expect(
		(
			await admin.query(
				"select count(*)::int n from account where user_id=$1 and provider_id<>'credential'",
				[enrollment.userId],
			)
		).rows[0].n,
	).toBe(1);
	await admin.query("delete from session where user_id=$1", [
		enrollment.userId,
	]);
	return { app, callback, ...enrollment };
}
async function noAuthority(app: Booted, cookie: string, userId: string) {
	expect(
		await app.auth.api.getSession({ headers: new Headers({ cookie }) }),
	).toBeNull();
	expect(
		(
			await admin.query(
				"select count(*)::int n from session where user_id=$1",
				[userId],
			)
		).rows[0].n,
	).toBe(0);
	const token = await app.handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/token`, { headers: { cookie } }),
	);
	expect(token.status).toBe(401);
	expect(token.headers.get("set-auth-jwt")).toBeNull();
}
async function challenge(protocol: Protocol, callbackURL = "/") {
	const setup = await linked(protocol);
	const result = await setup.callback(undefined, callbackURL);
	expect(result.status).toBe(302);
	expect(result.location?.pathname).toBe("/two-factor");
	expect(result.location?.searchParams.get("callbackURL")).toBe(callbackURL);
	const pending = cookieText(result.jar);
	expect(pending).toContain("better-auth.two_factor=");
	// Even the raw Set-Cookie values from the callback confer no authority.
	await noAuthority(setup.app, pending, setup.userId);
	return { ...setup, pending };
}
test.each<Protocol>([
	"SAML",
	"OIDC",
	"GitHub",
])("%s requires local TOTP before any session or Zero token", async (protocol) => {
	const { app, pending, userId, code } = await challenge(protocol, "/setup");
	const invalid = await post(
		app,
		"/two-factor/verify-totp",
		{ code: "invalid" },
		pending,
	);
	expect(invalid.status).toBeGreaterThanOrEqual(400);
	await noAuthority(app, pending, userId);
	const valid = await post(
		app,
		"/two-factor/verify-totp",
		await code(),
		pending,
	);
	expect(valid.status).toBe(200);
	const cookie = cookies(valid);
	expect(
		(await app.auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
			.id,
	).toBe(userId);
	expect(
		(
			await app.handleAuthRequest(
				new Request(`${ORIGIN}/api/auth/token`, { headers: { cookie } }),
			)
		).status,
	).toBe(200);
});
test("native grant stays pending until federated TOTP succeeds", async () => {
	const { app, callback, userId, code } = await linked("SAML");
	const context = await app.auth.$context;
	const sessions = {
		createSession: async (id: string) => {
			const row = await context.internalAdapter.createSession(id);
			if (!row) throw new Error("No session");
			return row;
		},
		deleteSession: (token: string) =>
			context.internalAdapter.deleteSession(token),
	};
	const routes = nativeAuthRoutes({
		pool: app.pool,
		sessions,
		guards: makeGuards([ORIGIN], (headers) =>
			app.auth.api.getSession({ headers }),
		),
		rateLimit: async () => true,
		signZeroToken: async () => {
			throw new Error("Unexpected token request");
		},
	});
	const store = new NativeGrantStore(app.pool, sessions);
	const verifier = randomBytes(32).toString("base64url");
	const grant = await store.create(s256Challenge(verifier), "Phone");
	const returnTo = `/native/authorize?grantId=${grant.grantId}`;
	const fresh = await callback(undefined, returnTo);
	expect(fresh.location?.pathname).toBe("/two-factor");
	expect(fresh.location?.searchParams.get("callbackURL")).toBe(returnTo);
	const pending = cookieText(fresh.jar);
	await noAuthority(app, pending, userId);
	const approve = (cookie: string) =>
		routes.handle(
			new Request(`${ORIGIN}/api/native/grants/approve`, {
				method: "POST",
				headers: { origin: ORIGIN, "content-type": "application/json", cookie },
				body: JSON.stringify({ grantId: grant.grantId }),
			}),
		);
	expect((await approve(pending)).status).toBe(401);
	expect((await store.exchange(grant.grantId, verifier)).kind).toBe("pending");
	const valid = await post(
		app,
		"/two-factor/verify-totp",
		await code(),
		pending,
	);
	expect(valid.status).toBe(200);
	expect((await approve(cookies(valid))).status).toBe(200);
	const exchanged = await store.exchange(grant.grantId, verifier);
	expect(exchanged.kind).toBe("ok");
	if (exchanged.kind !== "ok") throw new Error("No native session");
	expect((await lookupNativeSession(app.pool, exchanged.token))?.userId).toBe(
		userId,
	);
});
test("reset invalidates a pending federated challenge and its attempts", async () => {
	const { app, pending, userId, code } = await challenge("OIDC");
	await reset(app, userId);
	const refused = await post(
		app,
		"/two-factor/verify-totp",
		await code(),
		pending,
	);
	expect(refused.status).toBe(401);
	expect((await refused.json()).code).toBe("INVALID_TWO_FACTOR_COOKIE");
	await noAuthority(app, pending, userId);
	expect(
		(
			await admin.query(
				"select count(*)::int n from verification where value=$1 or identifier like '2fa-attempts-%'",
				[userId],
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query('select two_factor_enabled from "user" where id=$1', [
				userId,
			])
		).rows[0].two_factor_enabled,
	).toBe(true);
});
