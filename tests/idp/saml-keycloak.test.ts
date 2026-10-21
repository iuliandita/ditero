import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	parseSamlEnv,
	type ResolvedSaml,
	resolveSaml,
	samlProviderId,
} from "../../src/auth/saml.ts";

// A real SAML identity provider (Keycloak) in a container, pinned by digest, on
// a loopback port. Metadata is fetched from its descriptor URL, and the browser
// journey (redirect, login form, POST binding) is played over HTTP, so the
// signatures, certificates and NameIDs are the IdP's own.
// Run: DOCKER_CONFIG=<anonymous config> bunx vitest run tests/idp/saml-keycloak.test.ts
const IMAGE =
	"quay.io/keycloak/keycloak@sha256:79c623a22abacf3fe6c00a5fb30f5b7843d717b234033b80995891c06116d244";
const REALM = "ditero";
const PASSWORD = randomBytes(18).toString("hex");
const CONTAINER = `ditero-saml-keycloak-${randomBytes(4).toString("hex")}`;
const BASE = "http://localhost:3000";
const work = mkdtempSync(join(tmpdir(), "ditero-keycloak-"));

const SP = {
	signed: "https://sp-signed.example.test/",
	unsigned: "https://sp-unsigned.example.test/",
	responseOnly: "https://sp-response-only.example.test/",
	shortLived: "https://sp-short-lived.example.test/",
	other: "https://sp-other.example.test/",
} as const;
type SpName = keyof typeof SP;

let idpOrigin = "";
let realmURL = "";
let providerId = "";

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

function docker(...args: string[]) {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
	return result.stdout;
}

function client(
	name: SpName,
	attributes: Record<string, string>,
): Record<string, unknown> {
	return {
		clientId: SP[name],
		protocol: "saml",
		enabled: true,
		redirectUris: [`${BASE}/api/auth/sso/saml2/sp/acs/*`],
		attributes: {
			"saml.client.signature": "false",
			"saml.force.post.binding": "true",
			"saml.authnstatement": "true",
			"saml.signature.algorithm": "RSA_SHA256",
			saml_name_id_format: "persistent",
			saml_assertion_consumer_url_post: `${BASE}/api/auth/sso/saml2/sp/acs/${providerId}`,
			saml_idp_initiated_sso_url_name: name,
			saml_idp_initiated_sso_relay_state: "",
			...attributes,
		},
		protocolMappers: [
			["email", "email", "email"],
			["givenName", "firstName", "givenName"],
			["surname", "lastName", "surname"],
		].map(([mapper, property, attribute]) => ({
			name: mapper,
			protocol: "saml",
			protocolMapper: "saml-user-property-mapper",
			config: {
				"user.attribute": property,
				"attribute.name": attribute,
				"attribute.nameformat": "Basic",
				"friendly.name": attribute,
			},
		})),
	};
}

beforeAll(async () => {
	const port = await freePort();
	idpOrigin = `http://127.0.0.1:${port}`;
	realmURL = `${idpOrigin}/realms/${REALM}`;
	providerId = samlProviderId(realmURL);
	const realm = {
		realm: REALM,
		enabled: true,
		sslRequired: "none",
		users: [
			{
				username: "alice",
				enabled: true,
				email: "alice@example.test",
				emailVerified: true,
				firstName: "Alice",
				lastName: "Example",
				credentials: [{ type: "password", value: PASSWORD, temporary: false }],
			},
		],
		clients: [
			client("signed", {
				"saml.assertion.signature": "true",
				"saml.server.signature": "false",
			}),
			client("unsigned", {
				"saml.assertion.signature": "false",
				"saml.server.signature": "false",
			}),
			client("responseOnly", {
				"saml.assertion.signature": "false",
				"saml.server.signature": "true",
			}),
			client("shortLived", {
				"saml.assertion.signature": "true",
				"saml.server.signature": "false",
				"saml.assertion.lifespan": "1",
			}),
			client("other", {
				"saml.assertion.signature": "true",
				"saml.server.signature": "false",
			}),
		],
	};
	chmodSync(work, 0o755);
	writeFileSync(join(work, "realm.json"), JSON.stringify(realm), {
		mode: 0o644,
	});
	docker(
		"run",
		"--detach",
		"--name",
		CONTAINER,
		"--publish",
		`127.0.0.1:${port}:8080`,
		"--volume",
		`${join(work, "realm.json")}:/opt/keycloak/data/import/realm.json:ro`,
		IMAGE,
		"start-dev",
		"--import-realm",
		"--hostname-strict=false",
	);
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			const response = await fetch(`${realmURL}/protocol/saml/descriptor`);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error(
		`Keycloak did not become ready: ${docker("logs", CONTAINER)}`,
	);
}, 180_000);

afterAll(() => {
	spawnSync("docker", ["rm", "--force", CONTAINER]);
	rmSync(work, { recursive: true, force: true });
});

type Harness = {
	resolved: ResolvedSaml;
	handler: (request: Request) => Promise<Response>;
	store: Record<"user" | "session" | "account" | "verification", unknown[]>;
};

async function ditero(
	sp: SpName,
	extra: Record<string, string> = {},
): Promise<Harness> {
	const settings = parseSamlEnv({
		BETTER_AUTH_URL: BASE,
		NODE_ENV: "test",
		DITERO_SAML_IDP_METADATA_URL: `${realmURL}/protocol/saml/descriptor`,
		DITERO_SAML_SP_ENTITY_ID: SP[sp],
		DITERO_SAML_CLOCK_SKEW_SECONDS: "0",
		...extra,
	});
	if (!settings) throw new Error("SAML settings missing");
	const resolved = await resolveSaml(settings);
	const store = {
		user: [] as unknown[],
		session: [] as unknown[],
		account: [] as unknown[],
		verification: [] as unknown[],
	};
	const auth = betterAuth({
		baseURL: BASE,
		secret: "keycloak-interop-test-secret-0123456789",
		database: memoryAdapter(store),
		trustedOrigins: [BASE],
		plugins: [sso(resolved.options)],
	});
	return { resolved, handler: (request) => auth.handler(request), store };
}

function attributes(tag: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g))
		found[match[1].toLowerCase()] = match[2];
	return found;
}

function decode(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&#x2b;", "+")
		.replaceAll("&#x3d;", "=")
		.replaceAll("&#x2f;", "/")
		.replaceAll("&quot;", '"');
}

// Plays the browser against Keycloak: follow redirects, submit the login form,
// and stop at the auto-submitting POST-binding page.
async function browse(
	start: string,
	jar = new Map<string, string>(),
): Promise<{
	samlResponse: string;
	relayState: string | null;
	action: string;
}> {
	let url = start;
	let init: RequestInit = {};
	for (let hop = 0; hop < 12; hop++) {
		const response = await fetch(url, {
			...init,
			redirect: "manual",
			headers: {
				...(init.headers as Record<string, string> | undefined),
				cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
			},
		});
		for (const cookie of response.headers.getSetCookie()) {
			const [pair] = cookie.split(";", 1);
			const index = pair.indexOf("=");
			jar.set(pair.slice(0, index), pair.slice(index + 1));
		}
		if (response.status >= 300 && response.status < 400) {
			url = new URL(response.headers.get("location") ?? "", url).href;
			init = {};
			continue;
		}
		const html = await response.text();
		const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map((match) =>
			attributes(match[0]),
		);
		const saml = inputs.find((input) => input.name === "samlresponse");
		if (saml) {
			const form = /<form\b[^>]*>/i.exec(html)?.[0] ?? "";
			return {
				samlResponse: decode(saml.value),
				relayState:
					decode(
						inputs.find((input) => input.name === "relaystate")?.value ?? "",
					) || null,
				action: decode(attributes(form).action ?? ""),
			};
		}
		const form = /<form\b[^>]*id="kc-form-login"[^>]*>/i.exec(html)?.[0];
		if (!form) throw new Error(`unexpected Keycloak page at ${url}`);
		url = new URL(decode(attributes(form).action), url).href;
		init = {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				username: "alice",
				password: PASSWORD,
				credentialId: "",
			}),
		};
	}
	throw new Error("Keycloak journey did not finish");
}

async function spInitiated(harness: Harness, callbackURL = "/") {
	const response = await harness.handler(
		new Request(`${BASE}/api/auth/sign-in/sso`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: BASE },
			body: JSON.stringify({
				providerId: harness.resolved.providerId,
				callbackURL,
				errorCallbackURL: callbackURL,
			}),
		}),
	);
	expect(response.status).toBe(200);
	const { url } = (await response.json()) as { url: string };
	expect(url.startsWith(`${realmURL}/protocol/saml`)).toBe(true);
	return browse(url);
}

function postAcs(
	harness: Harness,
	acs: string,
	samlResponse: string,
	relayState: string | null,
) {
	const form = new URLSearchParams({ SAMLResponse: samlResponse });
	if (relayState) form.set("RelayState", relayState);
	return harness.handler(
		new Request(acs, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: idpOrigin,
			},
			body: form,
		}),
	);
}

const signedIn = (response: Response) =>
	response.status === 302 &&
	response.headers
		.getSetCookie()
		.some((cookie) => cookie.startsWith("better-auth.session_token="));

function expectRefused(response: Response, harness: Harness) {
	expect(signedIn(response)).toBe(false);
	if (response.status === 302)
		expect(response.headers.get("location")).toMatch(/error=/);
	else expect(response.status).toBeGreaterThanOrEqual(400);
	expect(harness.store.user).toHaveLength(0);
}

describe("SAML against a real Keycloak container", () => {
	test("accepts the IdP's signed assertion and keys the account on its NameID", async () => {
		const harness = await ditero("signed");
		expect(harness.resolved.idpEntityId).toBe(realmURL);
		expect(harness.resolved.providerId).toBe(providerId);
		const journey = await spInitiated(harness);
		const response = await postAcs(
			harness,
			journey.action,
			journey.samlResponse,
			journey.relayState,
		);
		expect(signedIn(response)).toBe(true);
		expect(harness.store.user).toHaveLength(1);
		expect(harness.store.user[0]).toMatchObject({
			email: "alice@example.test",
			emailVerified: false,
		});
		expect(harness.store.account).toHaveLength(1);
		expect(harness.store.account[0]).toMatchObject({ providerId });
		const [account] = harness.store.account as { accountId: string }[];
		// Persistent, opaque and not the email.
		expect(account.accountId).not.toContain("@");
		expect(account.accountId.length).toBeGreaterThan(8);
		// A second journey resolves the same account.
		const again = await spInitiated(harness);
		expect(
			signedIn(
				await postAcs(
					harness,
					again.action,
					again.samlResponse,
					again.relayState,
				),
			),
		).toBe(true);
		expect(harness.store.user).toHaveLength(1);
		expect(harness.store.account).toHaveLength(1);
	}, 60_000);

	test("refuses the same response submitted twice", async () => {
		const harness = await ditero("signed");
		const journey = await spInitiated(harness);
		const first = await postAcs(
			harness,
			journey.action,
			journey.samlResponse,
			journey.relayState,
		);
		expect(signedIn(first)).toBe(true);
		const replay = await postAcs(
			harness,
			journey.action,
			journey.samlResponse,
			journey.relayState,
		);
		expect(signedIn(replay)).toBe(false);
		expect(harness.store.user).toHaveLength(1);
	}, 60_000);

	test("refuses a real response with an invented RelayState", async () => {
		const harness = await ditero("signed");
		const journey = await spInitiated(harness);
		expectRefused(
			await postAcs(
				harness,
				journey.action,
				journey.samlResponse,
				"forged-state",
			),
			harness,
		);
	}, 60_000);

	test("refuses an IdP-initiated login while it is disabled, accepts it when enabled", async () => {
		const disabled = await ditero("signed");
		const unsolicited = await browse(
			`${realmURL}/protocol/saml/clients/signed`,
		);
		expect(unsolicited.relayState).toBeNull();
		expectRefused(
			await postAcs(
				disabled,
				unsolicited.action,
				unsolicited.samlResponse,
				null,
			),
			disabled,
		);
		const enabled = await ditero("signed", {
			DITERO_SAML_ALLOW_IDP_INITIATED: "true",
		});
		const again = await browse(`${realmURL}/protocol/saml/clients/signed`);
		const response = await postAcs(
			enabled,
			again.action,
			again.samlResponse,
			null,
		);
		expect(signedIn(response)).toBe(true);
		const location = new URL(response.headers.get("location") ?? "", BASE);
		expect(location.origin).toBe(BASE);
		expect(location.pathname).toBe("/");
	}, 60_000);

	test("refuses an assertion the IdP left unsigned", async () => {
		const harness = await ditero("unsigned");
		const journey = await spInitiated(harness);
		expectRefused(
			await postAcs(
				harness,
				journey.action,
				journey.samlResponse,
				journey.relayState,
			),
			harness,
		);
	}, 60_000);

	test("refuses a response signed only at the message level", async () => {
		const harness = await ditero("responseOnly");
		const journey = await spInitiated(harness);
		expectRefused(
			await postAcs(
				harness,
				journey.action,
				journey.samlResponse,
				journey.relayState,
			),
			harness,
		);
	}, 60_000);

	test("refuses an assertion issued for another audience", async () => {
		// Keycloak issues for client `other`; this instance is a different SP.
		const harness = await ditero("signed", {
			DITERO_SAML_ALLOW_IDP_INITIATED: "true",
		});
		const stray = await browse(`${realmURL}/protocol/saml/clients/other`);
		expectRefused(
			await postAcs(harness, stray.action, stray.samlResponse, null),
			harness,
		);
	}, 60_000);

	test("refuses an assertion after its NotOnOrAfter", async () => {
		const harness = await ditero("shortLived");
		const journey = await spInitiated(harness);
		await new Promise((resolve) => setTimeout(resolve, 3_500));
		expectRefused(
			await postAcs(
				harness,
				journey.action,
				journey.samlResponse,
				journey.relayState,
			),
			harness,
		);
	}, 60_000);
});
