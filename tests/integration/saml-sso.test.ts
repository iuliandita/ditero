import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";
import * as tables from "../../src/db/schema.ts";
import { type FixtureIdp, generateKeyPair } from "../support/saml-idp.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

// Auth is configured at import time, so the SAML environment is fixed before
// any module loads and each registration mode boots a fresh module graph.
const idp: FixtureIdp = await vi.hoisted(async () => {
	delete process.env.DITERO_E2E;
	const { createFixtureIdp } = await import("../support/saml-idp.ts");
	const fixture = createFixtureIdp("https://idp.example.test/entity");
	process.env.DITERO_SAML_IDP_METADATA = fixture.metadataXml;
	process.env.DITERO_SAML_NAME = "Corp SSO";
	process.env.DITERO_SAML_CLOCK_SKEW_SECONDS = "5";
	return fixture;
});

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const db = drizzle(admin, { schema: tables });
const ORIGIN = "http://localhost:3000";
const GRANT = `${"A".repeat(42)}A`;

type Booted = Awaited<ReturnType<typeof boot>>;
const open: Booted[] = [];

async function boot(
	mode: "open" | "bootstrap" | "closed",
	env: Record<string, string | undefined> = {},
) {
	vi.resetModules();
	for (const key of Object.keys(process.env))
		if (key.startsWith("DITERO_SAML_")) delete process.env[key];
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
	open.push(booted);
	return booted;
}

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query("truncate table invite, workspace cascade");
});

afterEach(async () => {
	for (const booted of open.splice(0)) await booted.pool.end();
});

afterAll(async () => {
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

const hasSession = (response: Response) =>
	response.headers
		.getSetCookie()
		.some((cookie) => /better-auth\.session_token=/.test(cookie));

async function userCount(): Promise<number> {
	const [row] = await db.select({ value: count() }).from(tables.user);
	return row.value;
}

async function signedIn(
	app: Booted,
	flow: Awaited<ReturnType<typeof beginFlow>>,
	overrides: Parameters<FixtureIdp["respond"]>[1] = {},
) {
	return postAcs(
		app,
		flow.acs,
		await idp.respond(flow, overrides),
		flow.relayState,
	);
}

async function expectRefused(response: Response, before: number) {
	expect(hasSession(response)).toBe(false);
	if (response.status === 302)
		expect(response.headers.get("location")).toMatch(/error=/);
	else expect(response.status).toBeGreaterThanOrEqual(400);
	expect(await userCount()).toBe(before);
}

async function samlAccounts() {
	return db
		.select()
		.from(tables.account)
		.where(eq(tables.account.accountId, "fixture-name-id"));
}

describe("service provider surface", () => {
	test("publishes the configured provider and signed-assertion metadata", async () => {
		const app = await boot("open");
		expect(app.ssoProviders()).toEqual([
			{
				id: expect.stringMatching(/^saml-[0-9a-f]{16}$/),
				name: "Corp SSO",
				protocol: "saml",
			},
		]);
		const response = await app.handleAuthRequest(
			new Request(`${ORIGIN}/api/auth/sso/saml2/sp/metadata`),
		);
		expect(response.status).toBe(200);
		const xml = await response.text();
		expect(xml).toContain(
			`/api/auth/sso/saml2/sp/acs/${app.ssoProviders()[0].id}`,
		);
		expect(xml).toContain('WantAssertionsSigned="true"');
		expect(xml).toContain("nameid-format:persistent");
	});

	test.each([
		["POST", "/api/auth/sso/register"],
		["GET", "/api/auth/sso/providers"],
		["POST", "/api/auth/sso/update-provider"],
		["POST", "/api/auth/sso/delete-provider"],
		["POST", "/api/auth/sso/request-domain-verification"],
		["GET", "/api/auth/sso/callback/anything"],
		["POST", "/api/auth/sso/saml2/sp/slo/anything"],
		["GET", "/api/auth/sso/saml2/sp/acs/anything"],
	])("%s %s is not reachable", async (method, path) => {
		const app = await boot("open");
		const response = await app.handleAuthRequest(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: { origin: ORIGIN, "content-type": "application/json" },
				body: method === "POST" ? "{}" : undefined,
			}),
		);
		expect(response.status).toBe(404);
	});

	test.each([
		"https://evil.example/",
		"//evil.example/",
		"/\\evil.example",
		"/anything-else",
		"/settings/../x",
		"javascript:alert(1)",
		"/native/authorize?grantId=short",
	])("refuses return address %s", async (callbackURL) => {
		const app = await boot("open");
		const response = await startSignIn(app, { callbackURL });
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("INVALID_RETURN_URL");
	});

	test("ignores caller-chosen providers, scopes and parameters", async () => {
		const app = await boot("open");
		const response = await startSignIn(app, {
			extra: {
				providerId: "attacker",
				additionalParams: { prompt: "x" },
				loginHint: "x",
			},
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { url: string }).url).toContain(
			"https://idp.example.test/entity/sso",
		);
	});
});

describe("assertion verification", () => {
	test("accepts a signed assertion and keys the account on the NameID", async () => {
		const app = await boot("open");
		const flow = await beginFlow(app, {
			callbackURL: `/native/authorize?grantId=${GRANT}`,
		});
		const response = await signedIn(app, flow);
		expect(response.status).toBe(302);
		expect(hasSession(response)).toBe(true);
		const location = new URL(response.headers.get("location") ?? "", ORIGIN);
		expect(location.pathname + location.search).toBe(
			`/native/authorize?grantId=${GRANT}`,
		);
		const [user] = await db.select().from(tables.user);
		expect(user).toMatchObject({
			email: "alice@example.test",
			name: "Alice Example",
			emailVerified: false,
		});
		const [account] = await samlAccounts();
		expect(account).toMatchObject({
			userId: user.id,
			providerId: app.ssoProviders()[0].id,
		});
		// A personal workspace only: SSO grants no shared membership or keys.
		const memberships = await db.select().from(tables.membership);
		expect(memberships.every((row) => row.userId === user.id)).toBe(true);
		expect(await db.select().from(tables.workspace)).toMatchObject([
			{ kind: "personal", ownerId: user.id },
		]);
	});

	test("a later sign-in follows the NameID, not the asserted email", async () => {
		const app = await boot("open");
		await signedIn(app, await beginFlow(app));
		const again = await signedIn(app, await beginFlow(app), {
			email: "renamed@example.test",
		});
		expect(hasSession(again)).toBe(true);
		expect(await userCount()).toBe(1);
		expect(await samlAccounts()).toHaveLength(1);
	});

	test.each<[string, Parameters<FixtureIdp["respond"]>[1]]>([
		["an unsigned assertion", { signAssertion: false }],
		["a different audience", { audience: "https://other-sp.example.test/" }],
		["an expired assertion", { notOnOrAfterOffset: -10 * 60_000 }],
		["a not-yet-valid assertion", { notBeforeOffset: 10 * 60_000 }],
		["no condition timestamps", { omitConditionTimes: true }],
		[
			"a different Destination",
			{ destination: "https://elsewhere.example/acs" },
		],
		["a different Recipient", { recipient: "https://elsewhere.example/acs" }],
		["a missing Recipient", { recipient: null }],
		["an unknown InResponseTo", { inResponseTo: "_never-issued" }],
		["a wrong IdP issuer", { issuer: "https://other-idp.example.test/entity" }],
	])("refuses %s", async (_name, overrides) => {
		const app = await boot("open");
		const flow = await beginFlow(app);
		await expectRefused(await signedIn(app, flow, overrides), 0);
	});

	test("trusts every signing certificate the metadata lists, for rotation", async () => {
		const { createFixtureIdp } = await import("../support/saml-idp.ts");
		const previous = createFixtureIdp(idp.entityId);
		const next = createFixtureIdp(idp.entityId, {
			extraCertificates: [previous.certificatePem],
		});
		const app = await boot("open", {
			DITERO_SAML_IDP_METADATA: next.metadataXml,
		});
		for (const signer of [previous, next]) {
			const flow = await beginFlow(app);
			const response = await postAcs(
				app,
				flow.acs,
				await signer.respond(flow),
				flow.relayState,
			);
			expect(hasSession(response)).toBe(true);
		}
		const flow = await beginFlow(app);
		const retired = createFixtureIdp(idp.entityId);
		await expectRefused(
			await postAcs(
				app,
				flow.acs,
				await retired.respond(flow),
				flow.relayState,
			),
			1,
		);
	});

	test("refuses SHA-1 signatures unless the operator allows them", async () => {
		const { createFixtureIdp } = await import("../support/saml-idp.ts");
		const legacy = createFixtureIdp(idp.entityId, { sha1: true });
		const strict = await boot("open", {
			DITERO_SAML_IDP_METADATA: legacy.metadataXml,
		});
		const flow = await beginFlow(strict);
		await expectRefused(
			await postAcs(
				strict,
				flow.acs,
				await legacy.respond(flow),
				flow.relayState,
			),
			0,
		);
		const lenient = await boot("open", {
			DITERO_SAML_IDP_METADATA: legacy.metadataXml,
			DITERO_SAML_ALLOW_DEPRECATED_ALGORITHMS: "true",
		});
		const again = await beginFlow(lenient);
		expect(
			hasSession(
				await postAcs(
					lenient,
					again.acs,
					await legacy.respond(again),
					again.relayState,
				),
			),
		).toBe(true);
	});

	test("refuses an assertion signed by a different key", async () => {
		const app = await boot("open");
		const { createFixtureIdp } = await import("../support/saml-idp.ts");
		const impostor = createFixtureIdp(idp.entityId);
		const flow = await beginFlow(app);
		const forged = await impostor.respond(flow);
		await expectRefused(
			await postAcs(app, flow.acs, forged, flow.relayState),
			0,
		);
	});

	test("refuses a replayed response and a replayed assertion ID", async () => {
		const app = await boot("open");
		const flow = await beginFlow(app);
		const samlResponse = await idp.respond(flow, {
			assertionId: "_fixed-assertion",
		});
		const first = await postAcs(app, flow.acs, samlResponse, flow.relayState);
		expect(hasSession(first)).toBe(true);
		const before = await userCount();
		await expectRefused(
			await postAcs(app, flow.acs, samlResponse, flow.relayState),
			before,
		);
		// A fresh AuthnRequest and RelayState, but the same assertion ID.
		const second = await beginFlow(app);
		await expectRefused(
			await postAcs(
				app,
				second.acs,
				await idp.respond(second, { assertionId: "_fixed-assertion" }),
				second.relayState,
			),
			before,
		);
	});

	test("refuses concurrent submissions of one assertion", async () => {
		const app = await boot("open");
		const flows = await Promise.all([beginFlow(app), beginFlow(app)]);
		const responses = await Promise.all(
			flows.map(async (flow) =>
				postAcs(
					app,
					flow.acs,
					await idp.respond(flow, { assertionId: "_race-assertion" }),
					flow.relayState,
				),
			),
		);
		expect(responses.filter(hasSession)).toHaveLength(1);
		expect(await userCount()).toBe(1);
	});

	test("refuses an IdP-initiated response while it is disabled", async () => {
		const app = await boot("open");
		const flow = await beginFlow(app);
		await expectRefused(
			await signedIn(app, flow, { omitInResponseTo: true }),
			0,
		);
	});

	test("accepts an IdP-initiated response only when the operator enabled it", async () => {
		const app = await boot("open", { DITERO_SAML_ALLOW_IDP_INITIATED: "true" });
		const flow = await beginFlow(app);
		const response = await postAcs(
			app,
			flow.acs,
			await idp.respond(flow, { omitInResponseTo: true }),
			null,
		);
		expect(hasSession(response)).toBe(true);
		const location = new URL(response.headers.get("location") ?? "", ORIGIN);
		expect(location.origin).toBe(ORIGIN);
		expect(location.pathname).toBe("/");
	});

	test.each([
		"not-a-real-state",
		"x".repeat(300),
	])("refuses an unknown RelayState %j", async (relayState) => {
		const app = await boot("open");
		const flow = await beginFlow(app);
		await expectRefused(
			await postAcs(app, flow.acs, await idp.respond(flow), relayState),
			0,
		);
	});

	test("refuses a response for another provider ID", async () => {
		const app = await boot("open");
		const flow = await beginFlow(app);
		const response = await postAcs(
			app,
			flow.acs.replace(/saml-[0-9a-f]+$/, "saml-0000000000000000"),
			await idp.respond(flow),
			flow.relayState,
		);
		expect(hasSession(response)).toBe(false);
		expect(response.status).toBe(404);
	});
});

async function seedOwnerWithInvite(email: string) {
	await db
		.insert(tables.user)
		.values({ id: "seed-owner", name: "owner", email: "owner@test.invalid" });
	await db.insert(tables.workspace).values({
		id: "seed-ws",
		name: "Seed",
		ownerId: "seed-owner",
		kind: "shared",
	});
	await db.insert(tables.invite).values({
		id: "invite-email",
		workspaceId: "seed-ws",
		role: "member",
		email,
		token: "token-email",
		status: "pending",
		createdBy: "seed-owner",
	});
}

describe("registration gate", () => {
	test("closed instances refuse new SSO accounts with the localizable code", async () => {
		const app = await boot("closed");
		const response = await signedIn(app, await beginFlow(app));
		expect(response.headers.get("location")).toContain("REGISTRATION_DISABLED");
		await expectRefused(response, 0);
	});

	test("bootstrap lets the first account in and then requires an invitation", async () => {
		const app = await boot("bootstrap");
		const first = await signedIn(app, await beginFlow(app));
		expect(hasSession(first)).toBe(true);
		expect(await db.select().from(tables.membership)).toMatchObject([
			{ role: "owner" },
		]);
		const second = await signedIn(app, await beginFlow(app), {
			nameId: "someone-else",
			email: "bob@example.test",
		});
		expect(second.headers.get("location")).toContain(
			"REGISTRATION_INVITE_REQUIRED",
		);
		await expectRefused(second, 1);
	});

	test("an email invitation does not open the gate unless the operator trusts SAML emails", async () => {
		await seedOwnerWithInvite("alice@example.test");
		const app = await boot("bootstrap");
		const refused = await signedIn(app, await beginFlow(app));
		await expectRefused(refused, 1);
		await app.pool.end();
		open.splice(0);
		const trusting = await boot("bootstrap", {
			DITERO_SAML_EMAIL_INVITES: "true",
		});
		const accepted = await signedIn(trusting, await beginFlow(trusting));
		expect(hasSession(accepted)).toBe(true);
		// The invitation still has to be redeemed; sign-in alone grants nothing.
		expect(
			await db
				.select()
				.from(tables.membership)
				.where(eq(tables.membership.workspaceId, "seed-ws")),
		).toEqual([]);
		const [row] = await db
			.select({ uses: tables.invite.uses })
			.from(tables.invite);
		expect(row.uses).toBe(0);
	});

	test("an existing account with the asserted email is never taken over", async () => {
		const app = await boot("open");
		await db.insert(tables.user).values({
			id: "existing",
			name: "Alice",
			email: "alice@example.test",
			emailVerified: true,
		});
		const response = await signedIn(app, await beginFlow(app));
		expect(response.headers.get("location")).toContain("account_not_linked");
		await expectRefused(response, 1);
		expect(await samlAccounts()).toEqual([]);
	});
});

describe("explicit linking", () => {
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
			.map((cookie) => cookie.split(";", 1)[0])
			.join("; ");
	}

	test("requires a session to start", async () => {
		const app = await boot("open");
		const response = await startSignIn(app, { link: true });
		expect(response.status).toBe(401);
	});

	test("links the IdP identity to the signed-in user, even with another email", async () => {
		const app = await boot("open");
		const cookie = await passwordSession(app, "linker@example.test");
		const [me] = await db.select().from(tables.user);
		const flow = await beginFlow(app, {
			link: true,
			cookie,
			callbackURL: "/settings/security",
		});
		const response = await signedIn(app, flow, { email: "corp@example.test" });
		expect(hasSession(response)).toBe(true);
		expect(await userCount()).toBe(1);
		expect(await samlAccounts()).toMatchObject([{ userId: me.id }]);
		const next = await signedIn(app, await beginFlow(app));
		expect(hasSession(next)).toBe(true);
		expect(await userCount()).toBe(1);
	});

	test("an identity already linked elsewhere cannot be taken over by linking", async () => {
		const app = await boot("open");
		await signedIn(app, await beginFlow(app));
		const cookie = await passwordSession(app, "other@example.test");
		const flow = await beginFlow(app, { link: true, cookie });
		const response = await signedIn(app, flow);
		expect(response.headers.get("location")).toContain(
			"account_ownership_conflict",
		);
		expect(hasSession(response)).toBe(false);
		expect(await samlAccounts()).toHaveLength(1);
	});

	test("a link intent works once", async () => {
		const app = await boot("open");
		const cookie = await passwordSession(app, "once@example.test");
		const flow = await beginFlow(app, { link: true, cookie });
		const first = await signedIn(app, flow);
		expect(hasSession(first)).toBe(true);
		const [{ value }] = await db
			.select({ value: count() })
			.from(tables.verification)
			.where(
				eq(
					tables.verification.identifier,
					`ditero-saml-link:${flow.relayState}`,
				),
			);
		expect(value).toBe(0);
	});
});

describe("browser binding", () => {
	const HTTPS = { BETTER_AUTH_URL: "https://tasks.example.test" };
	const bindingCookie = (response: Response) =>
		response.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith("ditero.saml_bind="));

	async function begin(app: Booted) {
		const response = await startSignIn(app);
		const cookie = bindingCookie(response);
		const { url } = (await response.json()) as { url: string };
		return { flow: idp.parseRedirect(url), cookie };
	}

	test("plain-http development sets and requires no binding cookie", async () => {
		const app = await boot("open");
		const { cookie } = await begin(app);
		expect(cookie).toBeUndefined();
	});

	test("over https the starting browser carries a cookie the callback must present", async () => {
		const app = await boot("open", HTTPS);
		const { flow, cookie } = await begin(app);
		expect(cookie).toMatch(/SameSite=None/i);
		expect(cookie).toMatch(/Secure/i);
		expect(cookie).toMatch(/HttpOnly/i);
		expect(cookie).toMatch(/Path=\/api\/auth\/sso\/saml2\/sp\/acs\//);
		const sent = (cookie ?? "").split(";", 1)[0];
		const response = await postAcs(
			app,
			flow.acs,
			await idp.respond(flow),
			flow.relayState,
			sent,
		);
		expect(hasSession(response)).toBe(true);
	});

	test("a response delivered to a different browser is refused and costs nothing", async () => {
		const app = await boot("open", HTTPS);
		const { flow } = await begin(app);
		const samlResponse = await idp.respond(flow);
		const stranger = await postAcs(
			app,
			flow.acs,
			samlResponse,
			flow.relayState,
		);
		expect(stranger.status).toBe(302);
		expect(stranger.headers.get("location")).toContain("sso_browser_mismatch");
		expect(hasSession(stranger)).toBe(false);
		expect(await userCount()).toBe(0);
		// The AuthnRequest was not consumed, so the real browser can still finish.
		const { cookie } = await begin(app);
		expect(cookie).toBeDefined();
	});

	test("another flow's cookie does not unlock this response", async () => {
		const app = await boot("open", HTTPS);
		const mine = await begin(app);
		const theirs = await begin(app);
		const response = await postAcs(
			app,
			mine.flow.acs,
			await idp.respond(mine.flow),
			mine.flow.relayState,
			(theirs.cookie ?? "").split(";", 1)[0],
		);
		expect(hasSession(response)).toBe(false);
		expect(await userCount()).toBe(0);
	});
});

describe("signing and encryption material", () => {
	test("signs AuthnRequests when the IdP asks for it and a key pair is configured", async () => {
		const { createFixtureIdp } = await import("../support/saml-idp.ts");
		const strict = createFixtureIdp("https://strict-idp.example.test/entity", {
			wantRequestsSigned: true,
		});
		const pair = generateKeyPair("ditero-sp");
		const app = await boot("open", {
			DITERO_SAML_IDP_METADATA: strict.metadataXml,
			DITERO_SAML_SP_PRIVATE_KEY: pair.keyPem,
			DITERO_SAML_SP_CERT: pair.certificatePem,
		});
		const response = await startSignIn(app);
		expect(response.status).toBe(200);
		const url = new URL(((await response.json()) as { url: string }).url);
		expect(url.searchParams.get("Signature")).toBeTruthy();
		expect(url.searchParams.get("SigAlg")).toContain("rsa-sha256");
	});

	test("refuses to start when the IdP asks for signed requests and no key is configured", async () => {
		const { createFixtureIdp } = await import("../support/saml-idp.ts");
		const strict = createFixtureIdp("https://strict-idp.example.test/entity", {
			wantRequestsSigned: true,
		});
		await expect(
			boot("open", { DITERO_SAML_IDP_METADATA: strict.metadataXml }),
		).rejects.toThrow(/requires signed AuthnRequests/);
	});

	test("a key pair the IdP does not need for signing leaves requests unsigned", async () => {
		const pair = generateKeyPair("ditero-sp");
		const app = await boot("open", {
			DITERO_SAML_SP_PRIVATE_KEY: pair.keyPem,
			DITERO_SAML_SP_CERT: pair.certificatePem,
		});
		const response = await startSignIn(app);
		const url = new URL(((await response.json()) as { url: string }).url);
		expect(url.searchParams.get("Signature")).toBeNull();
	});
});

describe("runtime database role", () => {
	test("first sign-in works under a role that cannot bypass row-level security", async () => {
		const role = "ditero_saml_runtime";
		await admin.query(
			`do $$ begin if not exists(select from pg_roles where rolname='${role}') then create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
		);
		await admin.query(`grant usage on schema public to ${role}`);
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to ${role}`,
		);
		const app = await boot("open");
		app.pool.on("connect", (client) => void client.query(`set role ${role}`));
		const response = await signedIn(app, await beginFlow(app));
		expect(hasSession(response)).toBe(true);
		const [user] = await db.select().from(tables.user);
		expect(await db.select().from(tables.workspace)).toMatchObject([
			{ kind: "personal", ownerId: user.id },
		]);
	});
});
