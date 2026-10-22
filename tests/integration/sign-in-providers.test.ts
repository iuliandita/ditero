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
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";
import { publicConfig } from "../../src/server/public-config.ts";
import {
	finishOAuth,
	json,
	type MockRoute,
	mockProviderEndpoints,
	startOAuth,
} from "../support/oauth-mocks.ts";

// Auth reads its provider configuration at import time.
vi.hoisted(() => {
	process.env.GITHUB_CLIENT_ID = "gh-id";
	process.env.GITHUB_CLIENT_SECRET = "gh-secret";
	process.env.DITERO_OIDC_PROVIDERS = "family";
	process.env.DITERO_OIDC_FAMILY_ISSUER =
		"https://idp.example.test/realms/home";
	process.env.DITERO_OIDC_FAMILY_CLIENT_ID = "ditero";
	process.env.DITERO_OIDC_FAMILY_CLIENT_SECRET = "idp-secret";
});

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const auth = { handler: (request: Request) => handleAuthRequest(request) };

let profile = { id: 4242, name: "Ada" };
let emails: { email: string; primary: boolean; verified: boolean }[] = [];

const github: MockRoute[] = [
	(r) =>
		r.url.href === "https://github.com/login/oauth/access_token"
			? json({ access_token: "gh-token", token_type: "bearer" })
			: undefined,
	(r) =>
		r.url.href === "https://api.github.com/user"
			? json({ login: "ada", email: null, avatar_url: null, ...profile })
			: undefined,
	(r) =>
		r.url.href === "https://api.github.com/user/emails"
			? json(emails)
			: undefined,
	// Discovery for the OIDC provider is allowed to fail: only GitHub is driven here.
	(r) => (r.url.hostname === "idp.example.test" ? json({}, 404) : undefined),
];

beforeEach(async () => {
	mockProviderEndpoints(github);
	profile = { id: 4242, name: "Ada" };
	emails = [{ email: "ada@test.invalid", primary: true, verified: true }];
	await db.delete(tables.invite);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
	await db.delete(tables.rateLimit);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
	await pool.end();
});

async function githubSignIn() {
	const started = await startOAuth(auth, "github");
	return finishOAuth(auth, "github", started);
}

async function seedInvite(email: string) {
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

describe("provider sign-in against the real registration gate", () => {
	test("bootstrap: the first GitHub account is created with its personal workspace", async () => {
		const outcome = await githubSignIn();
		expect(outcome.error).toBeNull();
		const [account] = await db.select().from(tables.account);
		expect(account).toMatchObject({ providerId: "github", accountId: "4242" });
		const [user] = await db.select().from(tables.user);
		expect(user).toMatchObject({
			email: "ada@test.invalid",
			emailVerified: true,
		});
		const [workspaces] = await db
			.select({ value: count() })
			.from(tables.workspace)
			.where(eq(tables.workspace.ownerId, user.id));
		expect(workspaces.value).toBe(1);
	});

	test("bootstrap refuses an unverified first provider account through the real user hook", async () => {
		emails = [{ email: "ada@test.invalid", primary: true, verified: false }];
		const outcome = await githubSignIn();
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(await db.select().from(tables.user)).toEqual([]);
		expect(await db.select().from(tables.account)).toEqual([]);
		expect(await db.select().from(tables.session)).toEqual([]);
	});

	test("bootstrap: a later stranger needs an invitation", async () => {
		await db
			.insert(tables.user)
			.values({ id: "first", name: "First", email: "first@test.invalid" });
		const outcome = await githubSignIn();
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(await db.select().from(tables.account)).toEqual([]);
	});

	test("a verified email redeems an email invitation", async () => {
		await seedInvite("ada@test.invalid");
		const outcome = await githubSignIn();
		expect(outcome.error).toBeNull();
		const created = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.email, "ada@test.invalid"));
		expect(created).toHaveLength(1);
	});

	test("an unverified email does not, even when it matches the invitation", async () => {
		await seedInvite("ada@test.invalid");
		emails = [{ email: "ada@test.invalid", primary: true, verified: false }];
		const outcome = await githubSignIn();
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(await db.select().from(tables.account)).toEqual([]);
		expect(
			await db
				.select()
				.from(tables.user)
				.where(eq(tables.user.email, "ada@test.invalid")),
		).toEqual([]);
	});

	test("a matching password account is never linked implicitly", async () => {
		await db.insert(tables.user).values({
			id: "ada",
			name: "Ada",
			email: "ada@test.invalid",
			emailVerified: true,
		});
		const outcome = await githubSignIn();
		expect(outcome.error).toBe("PROVIDER_SIGN_IN_REFUSED");
		expect(await db.select().from(tables.account)).toEqual([]);
		expect(await db.select().from(tables.session)).toEqual([]);
	});

	test("a GitHub account without a verified-email list is reported, not created", async () => {
		emails = [];
		const outcome = await githubSignIn();
		expect(outcome.error).toBe("email_not_found");
		expect(await db.select().from(tables.user)).toEqual([]);
	});
});

describe("public provider list", () => {
	test("publishes ids and display data, never credentials", () => {
		const config = publicConfig(process.env);
		expect(config.socialProviders).toEqual(["github", "family"]);
		expect(config.oidcProviders).toEqual([
			{ id: "family", name: "family", icon: "key" },
		]);
		expect(JSON.stringify(config)).not.toMatch(/gh-secret|idp-secret/);
	});
});
