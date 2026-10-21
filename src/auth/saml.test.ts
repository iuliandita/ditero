import { describe, expect, test } from "vitest";
import {
	isSamlAcsPath,
	loadIdpMetadata,
	parseSamlEnv,
	publicSsoProviders,
	relayStateFromURL,
	resolveSaml,
	resolveSamlUser,
	samlLinkIntent,
	samlProviderId,
	validReturnPath,
} from "./saml.ts";

const METADATA =
	'<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example.test/entity"><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>MIIB</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso"/></IDPSSODescriptor></EntityDescriptor>';
const BASE = {
	BETTER_AUTH_URL: "https://tasks.example.test",
	DITERO_SAML_IDP_METADATA: METADATA,
};
const KEY = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
const CERT = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
const noFiles = (path: string): string => {
	throw new Error(`unexpected read of ${path}`);
};

describe("parseSamlEnv", () => {
	test("is off without any SAML setting", () => {
		expect(parseSamlEnv({ BETTER_AUTH_URL: BASE.BETTER_AUTH_URL })).toBeNull();
		expect(parseSamlEnv({ DITERO_SAML_NAME: "  " })).toBeNull();
	});

	test("applies safe defaults", () => {
		expect(parseSamlEnv(BASE)).toMatchObject({
			spEntityId: "https://tasks.example.test/api/auth/sso/saml2/sp/metadata",
			displayName: "Single sign-on",
			allowIdpInitiated: false,
			allowDeprecatedAlgorithms: false,
			emailInvites: false,
			encryptedAssertions: false,
			clockSkewMs: 60_000,
			spKeyPair: null,
		});
	});

	test("reads secrets and metadata from _FILE paths", () => {
		const files: Record<string, string> = {
			"/run/s/meta": METADATA,
			"/run/s/key": KEY,
			"/run/s/cert": CERT,
		};
		const settings = parseSamlEnv(
			{
				BETTER_AUTH_URL: BASE.BETTER_AUTH_URL,
				DITERO_SAML_IDP_METADATA_FILE: "/run/s/meta",
				DITERO_SAML_SP_PRIVATE_KEY_FILE: "/run/s/key",
				DITERO_SAML_SP_CERT_FILE: "/run/s/cert",
			},
			(path) => files[path],
		);
		expect(settings?.idpMetadata).toEqual({ kind: "xml", xml: METADATA });
		expect(settings?.spKeyPair).toEqual({ privateKey: KEY, cert: CERT });
	});

	test.each<[string, Record<string, string>, RegExp]>([
		[
			"two metadata sources",
			{ DITERO_SAML_IDP_METADATA_URL: "https://idp.example.test/m" },
			/only one IdP metadata source/,
		],
		[
			"a literal and a file for one setting",
			{ DITERO_SAML_IDP_METADATA_FILE: "/x" },
			/only one of DITERO_SAML_IDP_METADATA and/,
		],
		[
			"a plain-http metadata URL",
			{
				DITERO_SAML_IDP_METADATA: "",
				DITERO_SAML_IDP_METADATA_URL: "http://idp.example.test/m",
			},
			/must be an https URL/,
		],
		[
			"a metadata URL with credentials",
			{
				DITERO_SAML_IDP_METADATA: "",
				DITERO_SAML_IDP_METADATA_URL: "https://user:pw@idp.example.test/m",
			},
			/credentials or a fragment/,
		],
		[
			"a private key without a certificate",
			{ DITERO_SAML_SP_PRIVATE_KEY: KEY },
			/set together/,
		],
		[
			"a key that is not PEM",
			{ DITERO_SAML_SP_PRIVATE_KEY: "nope", DITERO_SAML_SP_CERT: CERT },
			/not a PEM private key/,
		],
		[
			"a certificate that is not PEM",
			{ DITERO_SAML_SP_PRIVATE_KEY: KEY, DITERO_SAML_SP_CERT: "nope" },
			/not a PEM certificate/,
		],
		[
			"encrypted assertions without key material",
			{ DITERO_SAML_ENCRYPTED_ASSERTIONS: "true" },
			/needs DITERO_SAML_SP_PRIVATE_KEY/,
		],
		[
			"a non-boolean flag",
			{ DITERO_SAML_ALLOW_IDP_INITIATED: "yes please" },
			/true or false/,
		],
		[
			"a negative clock skew",
			{ DITERO_SAML_CLOCK_SKEW_SECONDS: "-1" },
			/integer from 0 to 300/,
		],
		[
			"a huge clock skew",
			{ DITERO_SAML_CLOCK_SKEW_SECONDS: "3600" },
			/integer from 0 to 300/,
		],
		[
			"a fractional clock skew",
			{ DITERO_SAML_CLOCK_SKEW_SECONDS: "1.5" },
			/integer from 0 to 300/,
		],
		[
			"a control character in the name",
			{ DITERO_SAML_NAME: "Corp\u0007" },
			/printable/,
		],
		["an over-long name", { DITERO_SAML_NAME: "x".repeat(41) }, /1-40/],
		[
			"a markup-bearing entity ID",
			{ DITERO_SAML_SP_ENTITY_ID: 'x"><evil/>' },
			/not a valid entity ID/,
		],
		[
			"a path on the public address",
			{ BETTER_AUTH_URL: "https://tasks.example.test/app" },
			/origin without a path/,
		],
		[
			"a plain-http public address",
			{ BETTER_AUTH_URL: "http://tasks.example.test" },
			/must be an https URL/,
		],
		[
			"a missing public address",
			{ BETTER_AUTH_URL: "" },
			/BETTER_AUTH_URL is required/,
		],
	])("rejects %s", (_name, extra, message) => {
		expect(() => parseSamlEnv({ ...BASE, ...extra }, noFiles)).toThrow(message);
	});

	test("rejects settings without a metadata source", () => {
		expect(() =>
			parseSamlEnv({
				BETTER_AUTH_URL: BASE.BETTER_AUTH_URL,
				DITERO_SAML_NAME: "Corp",
			}),
		).toThrow(/no IdP metadata source/);
	});

	test("rejects an oversized inline metadata document", () => {
		expect(() =>
			parseSamlEnv({ ...BASE, DITERO_SAML_IDP_METADATA: "x".repeat(200_000) }),
		).toThrow(/size limit/);
	});

	test("an unreadable or empty _FILE names the variable, not the path contents", () => {
		expect(() =>
			parseSamlEnv(
				{
					BETTER_AUTH_URL: BASE.BETTER_AUTH_URL,
					DITERO_SAML_IDP_METADATA_FILE: "/missing",
				},
				noFiles,
			),
		).toThrow("DITERO_SAML_IDP_METADATA_FILE is not readable");
		expect(() =>
			parseSamlEnv(
				{
					BETTER_AUTH_URL: BASE.BETTER_AUTH_URL,
					DITERO_SAML_IDP_METADATA_FILE: "/empty",
				},
				() => "  \n",
			),
		).toThrow("DITERO_SAML_IDP_METADATA_FILE is empty");
	});

	test("allows plain http only on loopback outside production", () => {
		const dev = { ...BASE, BETTER_AUTH_URL: "http://localhost:3000" };
		expect(parseSamlEnv(dev)?.baseURL).toBe("http://localhost:3000");
		expect(() => parseSamlEnv({ ...dev, NODE_ENV: "production" })).toThrow(
			/must be an https URL/,
		);
	});
});

describe("loadIdpMetadata", () => {
	const urlSettings = () => {
		const settings = parseSamlEnv({
			BETTER_AUTH_URL: BASE.BETTER_AUTH_URL,
			DITERO_SAML_IDP_METADATA_URL: "https://idp.example.test/metadata",
		});
		if (!settings) throw new Error("expected settings");
		return settings;
	};
	const respond = (response: Response | Error) =>
		(async () => {
			if (response instanceof Error) throw response;
			return response;
		}) as unknown as typeof fetch;

	test("returns fetched metadata and does not follow redirects", async () => {
		let init: RequestInit | undefined;
		const xml = await loadIdpMetadata(urlSettings(), (async (
			_url: unknown,
			options?: RequestInit,
		) => {
			init = options;
			return new Response(METADATA);
		}) as unknown as typeof fetch);
		expect(xml).toBe(METADATA);
		expect(init?.redirect).toBe("manual");
	});

	test.each<[string, Response | Error, RegExp]>([
		[
			"a redirect",
			new Response(null, {
				status: 302,
				headers: { location: "https://evil.example/" },
			}),
			/answered 302/,
		],
		["a server error", new Response("no", { status: 500 }), /answered 500/],
		["a network failure", new Error("down"), /unreachable/],
		[
			"an HTML page",
			new Response("<html>login</html>"),
			/not an EntityDescriptor/,
		],
		[
			"metadata without a signing certificate",
			new Response('<EntityDescriptor entityID="x"></EntityDescriptor>'),
			/no signing certificate/,
		],
		[
			"an oversized document",
			new Response("<EntityDescriptor>".padEnd(200_000, "x")),
			/size limit/,
		],
	])("fails loudly on %s", async (_name, response, message) => {
		await expect(
			loadIdpMetadata(urlSettings(), respond(response)),
		).rejects.toThrow(message);
	});
});

describe("resolveSaml", () => {
	test("derives the provider ID from the IdP entity ID", async () => {
		const settings = parseSamlEnv(BASE);
		if (!settings) throw new Error("expected settings");
		const resolved = await resolveSaml(settings);
		expect(resolved.idpEntityId).toBe("https://idp.example.test/entity");
		expect(resolved.providerId).toBe(samlProviderId(resolved.idpEntityId));
		expect(resolved.providerId).not.toBe(
			samlProviderId("https://other-idp.example.test/entity"),
		);
		expect(resolved.acsURL).toBe(
			`https://tasks.example.test/api/auth/sso/saml2/sp/acs/${resolved.providerId}`,
		);
		expect(publicSsoProviders(resolved)).toEqual([
			{ id: resolved.providerId, name: "Single sign-on", protocol: "saml" },
		]);
		expect(publicSsoProviders(null)).toEqual([]);
	});

	test("pins the policy the verifier enforces", async () => {
		const settings = parseSamlEnv(BASE);
		if (!settings) throw new Error("expected settings");
		const { options } = await resolveSaml(settings);
		expect(options).toMatchObject({
			providersLimit: 0,
			trustEmailVerified: false,
			organizationProvisioning: { disabled: true },
			saml: {
				enableInResponseToValidation: true,
				allowIdpInitiated: false,
				requireTimestamps: true,
				enableSingleLogout: false,
				algorithms: { onDeprecated: "reject" },
			},
		});
		expect(options.domainVerification).toBeUndefined();
		expect(options.defaultSSO?.[0].samlConfig).toMatchObject({
			wantAssertionsSigned: true,
			authnRequestsSigned: false,
			identifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
		});
	});

	test("the operator opt-ins widen exactly what they name", async () => {
		const settings = parseSamlEnv({
			...BASE,
			DITERO_SAML_ALLOW_IDP_INITIATED: "true",
			DITERO_SAML_ALLOW_DEPRECATED_ALGORITHMS: "true",
		});
		if (!settings) throw new Error("expected settings");
		const { options } = await resolveSaml(settings);
		expect(options.saml).toMatchObject({
			allowIdpInitiated: true,
			idpInitiatedCallbackUrl: "/",
			algorithms: { onDeprecated: "warn" },
		});
		expect(options.trustEmailVerified).toBe(false);
	});
});

describe("resolveSamlUser", () => {
	const resolved = {
		providerId: "saml-aaaaaaaaaaaaaaaa",
		idpEntityId: "https://idp.example.test/entity",
	};
	const input = (overrides: Record<string, unknown> = {}) =>
		({
			protocol: "saml",
			providerId: resolved.providerId,
			accountKey: { issuer: resolved.idpEntityId, accountId: "name-id" },
			providerUser: {
				email: "a@example.test",
				emailVerified: false,
				name: "A",
			},
			providerAttributes: {},
			providerReference: {},
			...overrides,
		}) as never;

	test("continues for the pinned IdP", () => {
		expect(resolveSamlUser(resolved, input())).toEqual({ action: "continue" });
	});

	test.each<[string, Record<string, unknown>]>([
		[
			"another issuer",
			{ accountKey: { issuer: "https://evil.example", accountId: "n" } },
		],
		["another provider", { providerId: "saml-bbbbbbbbbbbbbbbb" }],
		[
			"a blank NameID",
			{ accountKey: { issuer: resolved.idpEntityId, accountId: "  " } },
		],
		["a non-SAML protocol", { protocol: "oidc" }],
	])("rejects %s", (_name, overrides) => {
		expect(resolveSamlUser(resolved, input(overrides))).toMatchObject({
			action: "reject",
		});
	});

	test("links to the user bound to this request only", () => {
		expect(
			samlLinkIntent.run({ userId: "u1" }, () =>
				resolveSamlUser(resolved, input()),
			),
		).toEqual({ action: "link", userId: "u1", profile: "preserve" });
		expect(resolveSamlUser(resolved, input())).toEqual({ action: "continue" });
	});
});

describe("validReturnPath", () => {
	const origins = ["https://tasks.example.test", "http://localhost:5173"];
	const grant = `${"A".repeat(42)}A`;

	test.each([
		"/",
		"/setup",
		"/settings/security",
		"/settings/danger",
		`/native/authorize?grantId=${grant}`,
		"https://tasks.example.test/",
		`https://tasks.example.test/native/authorize?grantId=${grant}`,
		"http://localhost:5173/settings/security",
	])("accepts %s", (value) => {
		expect(validReturnPath(value, origins)).toBe(true);
	});

	test.each<[string, unknown]>([
		["another origin", "https://evil.example/"],
		["a look-alike origin", "https://tasks.example.test.evil.example/"],
		["a protocol-relative URL", "//evil.example/"],
		["a backslash trick", "/\\evil.example"],
		["a tab inside", "/\tsettings"],
		["a relative path", "settings/security"],
		["a javascript URL", "javascript:alert(1)"],
		["a data URL", "data:text/html,x"],
		["an unknown app route", "/lists/abc"],
		["the API", "/api/auth/get-session"],
		["a traversal", "/settings/../api/auth/token"],
		["a query on a plain route", "/?next=https://evil.example"],
		["a fragment", "/#x"],
		["credentials", "https://u:p@tasks.example.test/"],
		["a malformed grant", "/native/authorize?grantId=short"],
		["an extra grant parameter", `/native/authorize?grantId=${grant}&next=x`],
		[
			"a repeated grant parameter",
			`/native/authorize?grantId=${grant}&grantId=${grant}`,
		],
		["a non-string", { toString: () => "/" }],
		["an over-long value", `/${"a".repeat(3000)}`],
	])("rejects %s", (_name, value) => {
		expect(validReturnPath(value, origins)).toBe(false);
	});
});

describe("request helpers", () => {
	test("isSamlAcsPath matches only the callback of the given provider", () => {
		const prefix = "/api/auth/sso/saml2/sp/acs/";
		expect(isSamlAcsPath(`${prefix}saml-1`, "saml-1")).toBe(true);
		expect(isSamlAcsPath(`${prefix}saml-1/`, "saml-1")).toBe(true);
		expect(isSamlAcsPath(`${prefix}saml-2`, "saml-1")).toBe(false);
		expect(isSamlAcsPath(`${prefix}saml-1/extra`, "saml-1")).toBe(false);
		expect(isSamlAcsPath(`${prefix}saml-1`)).toBe(true);
		expect(isSamlAcsPath("/api/auth/sso/saml2/sp/metadata", "saml-1")).toBe(
			false,
		);
	});

	test("relayStateFromURL reads the state the IdP will echo", () => {
		expect(
			relayStateFromURL(
				"https://idp.example.test/sso?SAMLRequest=a&RelayState=xyz",
			),
		).toBe("xyz");
		expect(relayStateFromURL("https://idp.example.test/sso")).toBeNull();
		expect(relayStateFromURL("not a url")).toBeNull();
		expect(relayStateFromURL(undefined)).toBeNull();
	});
});
