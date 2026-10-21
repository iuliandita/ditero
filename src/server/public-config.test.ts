import { describe, expect, it } from "vitest";
import {
	DEFAULT_ZERO_URL,
	publicConfig,
	zeroPublicURL,
} from "./public-config.ts";

describe("zeroPublicURL", () => {
	it("defaults when unset", () => {
		expect(zeroPublicURL({})).toBe(DEFAULT_ZERO_URL);
	});

	it("defaults when empty, so a blank compose value is not dialled", () => {
		expect(zeroPublicURL({ PUBLIC_ZERO_URL: "" })).toBe(DEFAULT_ZERO_URL);
	});

	it("honours a deployment's own origin", () => {
		expect(
			zeroPublicURL({ PUBLIC_ZERO_URL: "https://sync.example.test" }),
		).toBe("https://sync.example.test");
	});
});

describe("publicConfig", () => {
	it("serves the zero URL the client dials", () => {
		expect(
			publicConfig({ PUBLIC_ZERO_URL: "https://sync.example.test" }),
		).toEqual({
			zeroURL: "https://sync.example.test",
			socialProviders: [],
			oidcProviders: [],
		});
	});

	it("lists every configured provider with display data and no credentials", () => {
		const config = publicConfig({
			GOOGLE_CLIENT_ID: "id",
			GOOGLE_CLIENT_SECRET: "google-secret",
			GITHUB_CLIENT_ID: "id",
			GITHUB_CLIENT_SECRET: "github-secret",
			DITERO_OIDC_PROVIDERS: "family",
			DITERO_OIDC_FAMILY_ISSUER: "https://id.example.test",
			DITERO_OIDC_FAMILY_CLIENT_ID: "ditero",
			DITERO_OIDC_FAMILY_CLIENT_SECRET: "oidc-secret",
			DITERO_OIDC_FAMILY_NAME: "Family SSO",
			DITERO_OIDC_FAMILY_ICON: "shield",
		});
		expect(config).toEqual({
			zeroURL: DEFAULT_ZERO_URL,
			socialProviders: ["google", "github", "family"],
			oidcProviders: [{ id: "family", name: "Family SSO", icon: "shield" }],
		});
		expect(JSON.stringify(config)).not.toMatch(/secret/);
	});

	it.each([
		[{}, []],
		[{ GOOGLE_CLIENT_ID: "id" }, []],
		[{ GOOGLE_CLIENT_SECRET: "secret" }, []],
		[{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" }, []],
		[{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }, ["google"]],
	])("publishes only provider names for %j", (env, socialProviders) => {
		expect(publicConfig({ ...env, BETTER_AUTH_SECRET: "private" })).toEqual({
			zeroURL: DEFAULT_ZERO_URL,
			socialProviders,
			oidcProviders: [],
		});
	});
});
