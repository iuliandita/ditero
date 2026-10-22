import { describe, expect, it } from "vitest";
import {
	ProviderConfigError,
	type ProviderIO,
	publicSignInProviders,
	readProviderSettings,
	structureOnlyIO,
} from "./provider-env.ts";

const files: Record<string, string> = {
	"/run/secrets/github": "gh-secret\n",
	"/run/secrets/empty": "\n",
	"/run/secrets/idp": "idp-secret\r\n",
};
const io: ProviderIO = {
	readFile(path) {
		if (path in files) return files[path];
		throw new Error("ENOENT");
	},
};

const oidc = {
	DITERO_OIDC_PROVIDERS: "authentik",
	DITERO_OIDC_AUTHENTIK_ISSUER: "https://id.example.test/application/o/ditero/",
	DITERO_OIDC_AUTHENTIK_CLIENT_ID: "ditero",
	DITERO_OIDC_AUTHENTIK_CLIENT_SECRET: "secret",
};

function parse(env: Record<string, string | undefined>) {
	return readProviderSettings(env, io);
}

describe("built-in provider credentials", () => {
	it("enables nothing by default", () => {
		expect(parse({})).toEqual({ oidc: [] });
	});

	it("keeps the historical lenient Google behavior", () => {
		expect(parse({ GOOGLE_CLIENT_ID: "id" }).google).toBeUndefined();
		expect(
			parse({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }).google,
		).toEqual({ clientId: "id", clientSecret: "s" });
	});

	it.each([
		"GITHUB",
		"DISCORD",
		"FACEBOOK",
		"MICROSOFT",
	])("refuses a half-set %s pair", (prefix) => {
		expect(() => parse({ [`${prefix}_CLIENT_ID`]: "id" })).toThrow(
			ProviderConfigError,
		);
		expect(() => parse({ [`${prefix}_CLIENT_SECRET`]: "s" })).toThrow(
			/must be set together/,
		);
	});

	it("reads a secret from NAME_FILE and trims the trailing newline", () => {
		expect(
			parse({
				GITHUB_CLIENT_ID: "id",
				GITHUB_CLIENT_SECRET_FILE: "/run/secrets/github",
			}).github,
		).toEqual({ clientId: "id", clientSecret: "gh-secret" });
	});

	it.each([
		["a missing file", "/run/secrets/missing", /not a readable file/],
		["an empty file", "/run/secrets/empty", /file is empty/],
	])("refuses %s", (_label, path, message) => {
		expect(() =>
			parse({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET_FILE: path }),
		).toThrow(message);
	});

	it("accepts NAME and NAME_FILE only when they agree", () => {
		const base = {
			GITHUB_CLIENT_ID: "id",
			GITHUB_CLIENT_SECRET_FILE: "/run/secrets/github",
		};
		expect(
			parse({ ...base, GITHUB_CLIENT_SECRET: "gh-secret" }).github,
		).toBeDefined();
		expect(() => parse({ ...base, GITHUB_CLIENT_SECRET: "other" })).toThrow(
			/both set/,
		);
	});

	it("refuses control characters and oversized values", () => {
		expect(() =>
			parse({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "a\nb" }),
		).toThrow(/single line/);
		expect(() =>
			parse({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "x".repeat(5000) }),
		).toThrow(/too long/);
	});
});

describe("Microsoft tenant mode", () => {
	const base = { MICROSOFT_CLIENT_ID: "id", MICROSOFT_CLIENT_SECRET: "s" };
	const guid = "11111111-2222-3333-4444-555555555555";

	it.each([
		[guid, { mode: "tenant", id: guid }],
		[guid.toUpperCase(), { mode: "tenant", id: guid }],
		["organizations", { mode: "organizations" }],
		["Consumers", { mode: "consumers" }],
		["common", { mode: "common" }],
	])("accepts %s", (tenant, expected) => {
		expect(
			parse({ ...base, MICROSOFT_TENANT: tenant }).microsoft?.tenant,
		).toEqual(expected);
	});

	it.each([
		undefined,
		"",
		"contoso.onmicrosoft.com",
		"../common",
		`${guid}/v2.0`,
	])("refuses tenant %j", (tenant) => {
		expect(() => parse({ ...base, MICROSOFT_TENANT: tenant })).toThrow(
			/MICROSOFT_TENANT/,
		);
	});

	it("refuses a tenant without credentials", () => {
		expect(() => parse({ MICROSOFT_TENANT: "common" })).toThrow(
			/without MICROSOFT_CLIENT_ID/,
		);
	});
});

describe("Apple", () => {
	const base = {
		APPLE_CLIENT_ID: "app.example.web",
		APPLE_TEAM_ID: "ABCDE12345",
		APPLE_KEY_ID: "KEY1234567",
		APPLE_PRIVATE_KEY_FILE: "/run/secrets/apple.p8",
	};

	it("needs the whole set", () => {
		expect(parse(base).apple).toMatchObject({ teamId: "ABCDE12345" });
		for (const key of Object.keys(base))
			expect(() => parse({ ...base, [key]: undefined })).toThrow(key);
	});

	it.each(["APPLE_TEAM_ID", "APPLE_KEY_ID"])("validates %s", (key) => {
		expect(() => parse({ ...base, [key]: "short" })).toThrow(key);
	});
});

describe("generic OpenID Connect providers", () => {
	it("parses a provider with defaults", () => {
		const [provider] = parse(oidc).oidc;
		expect(provider).toEqual({
			id: "authentik",
			name: "authentik",
			icon: "key",
			issuer: "https://id.example.test/application/o/ditero/",
			discoveryUrl:
				"https://id.example.test/application/o/ditero/.well-known/openid-configuration",
			clientId: "ditero",
			clientSecret: "secret",
			scopes: ["openid", "email", "profile"],
			tokenAuth: "basic",
		});
	});

	it("reads every optional setting and a secret file", () => {
		const env = {
			...oidc,
			DITERO_OIDC_PROVIDERS: "authentik, work-sso",
			DITERO_OIDC_AUTHENTIK_CLIENT_SECRET: undefined,
			DITERO_OIDC_AUTHENTIK_CLIENT_SECRET_FILE: "/run/secrets/idp",
			DITERO_OIDC_AUTHENTIK_NAME: "Family SSO",
			DITERO_OIDC_AUTHENTIK_ICON: "shield",
			DITERO_OIDC_AUTHENTIK_SCOPES: "groups offline_access",
			DITERO_OIDC_AUTHENTIK_TOKEN_AUTH: "post",
			DITERO_OIDC_AUTHENTIK_DISCOVERY_URL: "https://id.example.test/disco",
			DITERO_OIDC_WORK_SSO_ISSUER: "https://sso.example.test",
			DITERO_OIDC_WORK_SSO_CLIENT_ID: "c",
			DITERO_OIDC_WORK_SSO_CLIENT_SECRET: "s",
		};
		const [first, second] = parse(env).oidc;
		expect(first).toMatchObject({
			name: "Family SSO",
			icon: "shield",
			clientSecret: "idp-secret",
			tokenAuth: "post",
			discoveryUrl: "https://id.example.test/disco",
			scopes: ["openid", "email", "profile", "groups", "offline_access"],
		});
		expect(second.id).toBe("work-sso");
		expect(second.discoveryUrl).toBe(
			"https://sso.example.test/.well-known/openid-configuration",
		);
	});

	it("allows http only for loopback issuers", () => {
		expect(
			parse({
				...oidc,
				DITERO_OIDC_AUTHENTIK_ISSUER: "http://127.0.0.1:5556/dex",
			}).oidc,
		).toHaveLength(1);
		expect(() =>
			parse({
				...oidc,
				DITERO_OIDC_AUTHENTIK_ISSUER: "http://id.example.test",
			}),
		).toThrow(/https/);
	});

	it.each([
		["reserved ID", { DITERO_OIDC_PROVIDERS: "google" }],
		["credential namespace", { DITERO_OIDC_PROVIDERS: "credential" }],
		["uppercase ID", { DITERO_OIDC_PROVIDERS: "Authentik" }],
		["underscore ID", { DITERO_OIDC_PROVIDERS: "my_idp" }],
		["traversal ID", { DITERO_OIDC_PROVIDERS: "../x" }],
		["empty entry", { DITERO_OIDC_PROVIDERS: "authentik,," }],
		["duplicate ID", { DITERO_OIDC_PROVIDERS: "authentik,authentik" }],
		[
			"too many providers",
			{
				DITERO_OIDC_PROVIDERS: Array.from(
					{ length: 9 },
					(_, i) => `p${i}`,
				).join(","),
			},
		],
		[
			"issuer with credentials",
			{ DITERO_OIDC_AUTHENTIK_ISSUER: "https://u:p@id.example.test" },
		],
		[
			"issuer with query",
			{ DITERO_OIDC_AUTHENTIK_ISSUER: "https://id.example.test/?a=1" },
		],
		[
			"javascript issuer",
			{ DITERO_OIDC_AUTHENTIK_ISSUER: "javascript:alert(1)" },
		],
		["bad icon", { DITERO_OIDC_AUTHENTIK_ICON: "<svg>" }],
		["bad scope", { DITERO_OIDC_AUTHENTIK_SCOPES: "ok bad;scope" }],
		[
			"too many scopes",
			{ DITERO_OIDC_AUTHENTIK_SCOPES: "a b c d e f g h i j k" },
		],
		["control character in name", { DITERO_OIDC_AUTHENTIK_NAME: "Evil\u0007" }],
		["long name", { DITERO_OIDC_AUTHENTIK_NAME: "n".repeat(41) }],
		["bad token auth", { DITERO_OIDC_AUTHENTIK_TOKEN_AUTH: "none" }],
		["missing client ID", { DITERO_OIDC_AUTHENTIK_CLIENT_ID: undefined }],
		["missing secret", { DITERO_OIDC_AUTHENTIK_CLIENT_SECRET: undefined }],
		["misspelled variable", { DITERO_OIDC_AUTHENTIK_CLIENT_SECERT: "x" }],
		["variable for an unlisted provider", { DITERO_OIDC_OTHER_CLIENT_ID: "x" }],
	])("refuses %s", (_label, override) => {
		expect(() => parse({ ...oidc, ...override })).toThrow(ProviderConfigError);
	});

	it("ignores unset leftovers from a Compose file", () => {
		expect(
			parse({ ...oidc, DITERO_OIDC_OTHER_CLIENT_ID: "" }).oidc,
		).toHaveLength(1);
	});
});

describe("public provider list", () => {
	it("does not compare secret files when only the shape is needed", () => {
		// The container entrypoint exports Google's secret and keeps the _FILE variable.
		const list = publicSignInProviders(
			readProviderSettings(
				{
					GOOGLE_CLIENT_ID: "id",
					GOOGLE_CLIENT_SECRET: "real-secret",
					GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/google",
				},
				structureOnlyIO,
			),
		);
		expect(list).toEqual([{ id: "google", name: "Google", icon: null }]);
	});

	it("lists built-ins in a fixed order, then OIDC providers, never a secret", () => {
		const list = publicSignInProviders(
			parse({
				...oidc,
				DITERO_OIDC_AUTHENTIK_NAME: "Family SSO",
				FACEBOOK_CLIENT_ID: "id",
				FACEBOOK_CLIENT_SECRET: "s",
				GOOGLE_CLIENT_ID: "id",
				GOOGLE_CLIENT_SECRET: "s",
			}),
		);
		expect(list).toEqual([
			{ id: "google", name: "Google", icon: null },
			{ id: "facebook", name: "Facebook", icon: null },
			{ id: "authentik", name: "Family SSO", icon: "key" },
		]);
		expect(JSON.stringify(list)).not.toContain("secret");
	});
});
