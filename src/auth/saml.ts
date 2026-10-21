import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	DEFAULT_MAX_SAML_METADATA_SIZE,
	DigestAlgorithm,
	deriveSAMLIdentityProviderEntityID,
	type SAMLConfig,
	SignatureAlgorithm,
	type SSOOptions,
	type SSOUserResolution,
	type SSOUserResolutionInput,
} from "@better-auth/sso";
import { settingsSectionFromPath } from "../domain/native-settings.ts";
import type { PublicSsoProvider } from "../server/public-config.ts";

export const SAML_NAME_ID_PERSISTENT =
	"urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
export const SAML_ACS_PATH = "/sso/saml2/sp/acs/";
export const SAML_METADATA_PATH = "/sso/saml2/sp/metadata";
export const SAML_LINK_QUERY = "link";
export const SAML_BIND_COOKIE = "ditero.saml_bind";
const LINK_IDENTIFIER_PREFIX = "ditero-saml-link:";
export const LINK_INTENT_TTL_MS = 10 * 60 * 1000;
const METADATA_FETCH_TIMEOUT_MS = 10_000;
// Same shape NativeAuthorize accepts: 32 random bytes as base64url.
const NATIVE_GRANT_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 300;

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

export type SamlSettings = {
	idpMetadata: { kind: "xml"; xml: string } | { kind: "url"; url: string };
	baseURL: string;
	spEntityId: string;
	displayName: string;
	spKeyPair: { privateKey: string; cert: string } | null;
	encryptedAssertions: boolean;
	allowIdpInitiated: boolean;
	allowDeprecatedAlgorithms: boolean;
	emailInvites: boolean;
	clockSkewMs: number;
	attributes: {
		email?: string;
		name?: string;
		firstName?: string;
		lastName?: string;
	};
};

export type ResolvedSaml = {
	providerId: string;
	idpEntityId: string;
	spEntityId: string;
	acsURL: string;
	metadataURL: string;
	displayName: string;
	emailInvites: boolean;
	// Only over https: a SameSite=None cookie needs Secure, and the callback is a
	// cross-site POST that carries nothing else from the browser that began it.
	bindBrowser: boolean;
	allowDeprecatedAlgorithms: boolean;
	options: SSOOptions;
};

function setting(env: Env, name: string, read: ReadFile): string | undefined {
	const literal = env[name];
	const path = env[`${name}_FILE`];
	if (literal && path)
		throw new Error(`Set only one of ${name} and ${name}_FILE`);
	if (path) {
		let content: string;
		try {
			content = read(path);
		} catch {
			throw new Error(`${name}_FILE is not readable`);
		}
		if (!content.trim()) throw new Error(`${name}_FILE is empty`);
		return content;
	}
	return literal?.trim() ? literal : undefined;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
	const value = env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === "true" || value === "1") return true;
	if (value === "false" || value === "0") return false;
	throw new Error(`${name} must be true or false`);
}

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

function httpsURL(name: string, value: string, env: Env): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} is not a valid URL`);
	}
	const loopbackHTTP =
		url.protocol === "http:" &&
		isLoopback(url.hostname) &&
		env.NODE_ENV !== "production";
	if (url.protocol !== "https:" && !loopbackHTTP)
		throw new Error(`${name} must be an https URL`);
	if (url.username || url.password || url.hash)
		throw new Error(`${name} must not carry credentials or a fragment`);
	return url;
}

const SAML_ENV_PREFIX = "DITERO_SAML_";

// Returns null when SAML is not configured. Any other DITERO_SAML_* setting
// without an IdP metadata source is a half-finished configuration and fails
// loudly instead of silently leaving single sign-on off.
export function parseSamlEnv(
	env: Env,
	read: ReadFile = (path) => readFileSync(path, "utf8"),
): SamlSettings | null {
	const url = env.DITERO_SAML_IDP_METADATA_URL?.trim();
	const xml = setting(env, "DITERO_SAML_IDP_METADATA", read);
	const configured = Object.keys(env).some(
		(key) => key.startsWith(SAML_ENV_PREFIX) && env[key]?.trim(),
	);
	if (!url && !xml) {
		if (configured)
			throw new Error(
				"DITERO_SAML_* is set but no IdP metadata source is configured; set DITERO_SAML_IDP_METADATA_URL or DITERO_SAML_IDP_METADATA(_FILE)",
			);
		return null;
	}
	if (url && xml)
		throw new Error(
			"Set only one IdP metadata source: DITERO_SAML_IDP_METADATA_URL or DITERO_SAML_IDP_METADATA(_FILE)",
		);
	if (url) httpsURL("DITERO_SAML_IDP_METADATA_URL", url, env);
	if (xml && Buffer.byteLength(xml) > DEFAULT_MAX_SAML_METADATA_SIZE)
		throw new Error("DITERO_SAML_IDP_METADATA exceeds the metadata size limit");

	const baseURL = env.BETTER_AUTH_URL?.trim();
	if (!baseURL) throw new Error("BETTER_AUTH_URL is required for SAML");
	const base = httpsURL("BETTER_AUTH_URL", baseURL, env);
	if (base.pathname !== "/" || base.search)
		throw new Error("BETTER_AUTH_URL must be an origin without a path");

	const spEntityId =
		env.DITERO_SAML_SP_ENTITY_ID?.trim() ||
		`${base.origin}/api/auth${SAML_METADATA_PATH}`;
	if (spEntityId.length > 1024 || /[\s<>"']/.test(spEntityId))
		throw new Error("DITERO_SAML_SP_ENTITY_ID is not a valid entity ID");

	const privateKey = setting(env, "DITERO_SAML_SP_PRIVATE_KEY", read);
	const cert = setting(env, "DITERO_SAML_SP_CERT", read);
	if (Boolean(privateKey) !== Boolean(cert))
		throw new Error(
			"DITERO_SAML_SP_PRIVATE_KEY and DITERO_SAML_SP_CERT must be set together",
		);
	if (privateKey && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey))
		throw new Error("DITERO_SAML_SP_PRIVATE_KEY is not a PEM private key");
	if (cert && !/-----BEGIN CERTIFICATE-----/.test(cert))
		throw new Error("DITERO_SAML_SP_CERT is not a PEM certificate");
	const encryptedAssertions = flag(
		env,
		"DITERO_SAML_ENCRYPTED_ASSERTIONS",
		false,
	);
	if (encryptedAssertions && !privateKey)
		throw new Error(
			"DITERO_SAML_ENCRYPTED_ASSERTIONS needs DITERO_SAML_SP_PRIVATE_KEY and DITERO_SAML_SP_CERT",
		);

	const skewText = env.DITERO_SAML_CLOCK_SKEW_SECONDS?.trim();
	const skew = skewText ? Number(skewText) : DEFAULT_CLOCK_SKEW_SECONDS;
	if (!Number.isInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_SECONDS)
		throw new Error(
			`DITERO_SAML_CLOCK_SKEW_SECONDS must be an integer from 0 to ${MAX_CLOCK_SKEW_SECONDS}`,
		);

	const displayName = env.DITERO_SAML_NAME?.trim() || "Single sign-on";
	if (displayName.length > 40 || /\p{C}/u.test(displayName))
		throw new Error("DITERO_SAML_NAME must be 1-40 printable characters");

	const attribute = (name: string): string | undefined => {
		const value = env[name]?.trim();
		if (value && (value.length > 256 || /\p{C}/u.test(value)))
			throw new Error(`${name} is not a valid attribute name`);
		return value || undefined;
	};

	return {
		idpMetadata: url ? { kind: "url", url } : { kind: "xml", xml: xml ?? "" },
		baseURL: base.origin,
		spEntityId,
		displayName,
		spKeyPair: privateKey && cert ? { privateKey, cert } : null,
		encryptedAssertions,
		allowIdpInitiated: flag(env, "DITERO_SAML_ALLOW_IDP_INITIATED", false),
		allowDeprecatedAlgorithms: flag(
			env,
			"DITERO_SAML_ALLOW_DEPRECATED_ALGORITHMS",
			false,
		),
		emailInvites: flag(env, "DITERO_SAML_EMAIL_INVITES", false),
		clockSkewMs: skew * 1000,
		attributes: {
			email: attribute("DITERO_SAML_ATTRIBUTE_EMAIL"),
			name: attribute("DITERO_SAML_ATTRIBUTE_NAME"),
			firstName: attribute("DITERO_SAML_ATTRIBUTE_FIRST_NAME"),
			lastName: attribute("DITERO_SAML_ATTRIBUTE_LAST_NAME"),
		},
	};
}

export async function loadIdpMetadata(
	settings: SamlSettings,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	let xml: string;
	if (settings.idpMetadata.kind === "xml") xml = settings.idpMetadata.xml;
	else {
		let response: Response;
		try {
			response = await fetchImpl(settings.idpMetadata.url, {
				redirect: "manual",
				signal: AbortSignal.timeout(METADATA_FETCH_TIMEOUT_MS),
				headers: { accept: "application/samlmetadata+xml, application/xml" },
			});
		} catch {
			throw new Error("SAML IdP metadata URL is unreachable");
		}
		if (!response.ok)
			throw new Error(
				`SAML IdP metadata URL answered ${response.status}; redirects are not followed`,
			);
		xml = await response.text();
	}
	if (Buffer.byteLength(xml) > DEFAULT_MAX_SAML_METADATA_SIZE)
		throw new Error("SAML IdP metadata exceeds the size limit");
	if (!/<(?:[\w-]+:)?EntityDescriptor[\s>]/.test(xml))
		throw new Error("SAML IdP metadata is not an EntityDescriptor document");
	if (!/<(?:[\w-]+:)?X509Certificate>/.test(xml))
		throw new Error("SAML IdP metadata carries no signing certificate");
	return xml;
}

export function samlProviderId(idpEntityId: string): string {
	return `saml-${createHash("sha256").update(idpEntityId).digest("hex").slice(0, 16)}`;
}

// One request at a time carries the signed-in user who started an explicit
// link. The callback is a cross-site POST, so no session cookie reaches it.
export const samlLinkIntent = new AsyncLocalStorage<{ userId: string }>();

export function linkIdentifier(relayState: string): string {
	return `${LINK_IDENTIFIER_PREFIX}${relayState}`;
}

const MAX_RESPONSE_BASE64 = 400_000;
const WHITESPACE = /\s/;
const STRONG_ALGORITHMS: ReadonlySet<string> = new Set(
	[
		...Object.values(SignatureAlgorithm),
		...Object.values(DigestAlgorithm),
	].filter((uri) => !/sha1/i.test(uri)),
);

type Tag = { name: string; attributes: [name: string, value: string][] };

// Reads one start or end tag at `from` (the index of "<"), honouring quotes so a
// ">" inside an attribute value does not end it. Returns null for anything that
// is not plainly well formed; the caller treats that as a refusal.
function readTag(xml: string, from: number): { tag: Tag; end: number } | null {
	let i = from + 1;
	const limit = Math.min(xml.length, from + 8192);
	if (xml[i] === "/") i++;
	const nameStart = i;
	while (i < limit && !WHITESPACE.test(xml[i]) && !"/>".includes(xml[i])) i++;
	const name = xml.slice(nameStart, i);
	if (!name || name.includes("<") || name.includes("=")) return null;
	const attributes: Tag["attributes"] = [];
	for (;;) {
		while (i < limit && WHITESPACE.test(xml[i])) i++;
		if (i >= limit) return null;
		if (xml[i] === ">") return { tag: { name, attributes }, end: i + 1 };
		if (xml[i] === "/") {
			i++;
			continue;
		}
		const attributeStart = i;
		while (i < limit && !WHITESPACE.test(xml[i]) && !"=/>".includes(xml[i]))
			i++;
		const attributeName = xml.slice(attributeStart, i);
		while (i < limit && WHITESPACE.test(xml[i])) i++;
		if (!attributeName || xml[i] !== "=") return null;
		i++;
		while (i < limit && WHITESPACE.test(xml[i])) i++;
		const quote = xml[i];
		if (quote !== '"' && quote !== "'") return null;
		const valueEnd = xml.indexOf(quote, i + 1);
		if (valueEnd < 0 || valueEnd >= limit) return null;
		const value = xml.slice(i + 1, valueEnd);
		if (value.includes("<")) return null;
		attributes.push([attributeName, value]);
		i = valueEnd + 1;
	}
}

// The verifier's deprecated-algorithm switch only inspects a response-level
// signature, so an assertion signed with SHA-1 passes it. This is a bounded,
// linear scan placed in front of the verifier that fails closed: any signature
// or digest method that is not exactly one unprefixed Algorithm attribute with a
// SHA-2 URI, any DOCTYPE, comment, CDATA section or tag it cannot read, and any
// response too large to scan is refused. It never accepts anything the verifier
// would not.
export function hasUnapprovedAlgorithm(
	samlResponse: unknown,
	checkAlgorithms = true,
): boolean {
	if (typeof samlResponse !== "string") return true;
	const compact = samlResponse.replace(/\s+/g, "");
	if (compact.length > MAX_RESPONSE_BASE64) return true;
	const xml = Buffer.from(compact, "base64").toString("utf8");
	if (/<!(?:DOCTYPE|ENTITY|--|\[CDATA\[)/i.test(xml)) return true;
	if (!checkAlgorithms) return false;
	let at = xml.indexOf("<");
	while (at >= 0) {
		if (xml[at + 1] === "?") {
			const end = xml.indexOf("?>", at);
			if (end < 0) return true;
			at = xml.indexOf("<", end);
			continue;
		}
		const read = readTag(xml, at);
		if (!read) return true;
		const local = read.tag.name.split(":").pop();
		if (local === "SignatureMethod" || local === "DigestMethod") {
			const [only, ...rest] = read.tag.attributes.filter(
				([name]) => name === "Algorithm" || name.endsWith(":Algorithm"),
			);
			if (
				!only ||
				rest.length > 0 ||
				only[0] !== "Algorithm" ||
				!STRONG_ALGORITHMS.has(only[1])
			)
				return true;
		}
		at = xml.indexOf("<", read.end);
	}
	return false;
}

export function bindingCookieValue(cookieHeader: string | null): string | null {
	for (const part of (cookieHeader ?? "").split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === SAML_BIND_COOKIE) return rest.join("=") || null;
	}
	return null;
}

export function relayStateFromURL(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		return new URL(value).searchParams.get("RelayState");
	} catch {
		return null;
	}
}

export function isSamlAcsPath(pathname: string, providerId?: string): boolean {
	const prefix = `/api/auth${SAML_ACS_PATH}`;
	if (!pathname.startsWith(prefix)) return false;
	const id = pathname.slice(prefix.length).replace(/\/+$/, "");
	return providerId ? id === providerId : /^[\w-]+$/.test(id);
}

export function resolveSamlUser(
	resolved: Pick<ResolvedSaml, "providerId" | "idpEntityId">,
	input: SSOUserResolutionInput,
): SSOUserResolution {
	if (
		input.protocol !== "saml" ||
		input.providerId !== resolved.providerId ||
		input.accountKey.issuer !== resolved.idpEntityId ||
		!input.accountKey.accountId.trim()
	)
		return { action: "reject", code: "saml_identity_mismatch" };
	const link = samlLinkIntent.getStore();
	return link
		? { action: "link", userId: link.userId, profile: "preserve" }
		: { action: "continue" };
}

export async function resolveSaml(
	settings: SamlSettings,
	fetchImpl: typeof fetch = fetch,
): Promise<ResolvedSaml> {
	const metadata = await loadIdpMetadata(settings, fetchImpl);
	const keyPair = settings.spKeyPair;
	// The verifier insists the SP's signing flag equals what the IdP asks for.
	const idpWantsSignedRequests =
		/\bWantAuthnRequestsSigned\s*=\s*["'](?:true|1)["']/i.test(metadata);
	if (idpWantsSignedRequests && !keyPair)
		throw new Error(
			"The IdP requires signed AuthnRequests; set DITERO_SAML_SP_PRIVATE_KEY and DITERO_SAML_SP_CERT (or their _FILE forms)",
		);
	const samlConfig: SAMLConfig = {
		issuer: settings.spEntityId,
		audience: settings.spEntityId,
		entryPoint: "",
		callbackUrl: "/",
		idpInitiatedCallbackUrl: settings.allowIdpInitiated ? "/" : undefined,
		idpMetadata: { metadata },
		spMetadata: {
			entityID: settings.spEntityId,
			...(keyPair
				? {
						privateKey: keyPair.privateKey,
						encPrivateKey: settings.encryptedAssertions
							? keyPair.privateKey
							: undefined,
						isAssertionEncrypted: settings.encryptedAssertions,
					}
				: {}),
		},
		wantAssertionsSigned: true,
		authnRequestsSigned: idpWantsSignedRequests,
		identifierFormat: SAML_NAME_ID_PERSISTENT,
		privateKey: keyPair?.privateKey,
		mapping: {
			email: settings.attributes.email,
			name: settings.attributes.name,
			firstName: settings.attributes.firstName,
			lastName: settings.attributes.lastName,
		},
	};
	let idpEntityId: string;
	try {
		idpEntityId = deriveSAMLIdentityProviderEntityID(samlConfig);
	} catch {
		throw new Error("SAML IdP metadata could not be parsed");
	}
	if (!idpEntityId) throw new Error("SAML IdP metadata carries no entityID");
	const providerId = samlProviderId(idpEntityId);
	const apiBase = `${settings.baseURL}/api/auth`;
	const resolved: ResolvedSaml = {
		providerId,
		idpEntityId,
		spEntityId: settings.spEntityId,
		acsURL: `${apiBase}${SAML_ACS_PATH}${providerId}`,
		metadataURL: `${apiBase}${SAML_METADATA_PATH}?providerId=${providerId}`,
		displayName: settings.displayName,
		emailInvites: settings.emailInvites,
		bindBrowser: settings.baseURL.startsWith("https:"),
		allowDeprecatedAlgorithms: settings.allowDeprecatedAlgorithms,
		options: {},
	};
	resolved.options = {
		// The domain only routes a request that names no provider; it grants
		// nothing, and domain verification stays off for the same reason.
		defaultSSO: [
			{
				providerId,
				domain: new URL(settings.baseURL).hostname,
				samlConfig,
			},
		],
		providersLimit: 0,
		trustEmailVerified: false,
		organizationProvisioning: { disabled: true },
		resolveUser: (input) => resolveSamlUser(resolved, input),
		saml: {
			enableInResponseToValidation: true,
			allowIdpInitiated: settings.allowIdpInitiated,
			idpInitiatedCallbackUrl: settings.allowIdpInitiated ? "/" : undefined,
			requireTimestamps: true,
			clockSkew: settings.clockSkewMs,
			requestTTL: 5 * 60 * 1000,
			enableSingleLogout: false,
			algorithms: {
				onDeprecated: settings.allowDeprecatedAlgorithms ? "warn" : "reject",
			},
		},
	};
	return resolved;
}

export function publicSsoProviders(
	resolved: ResolvedSaml | null,
): PublicSsoProvider[] {
	return resolved
		? [
				{
					id: resolved.providerId,
					name: resolved.displayName,
					protocol: "saml",
				},
			]
		: [];
}

// Return paths come from the browser, so they are checked against the routes
// that legitimately start a sign-in rather than merely against the origin.
export function validReturnPath(
	value: unknown,
	origins: readonly string[],
): boolean {
	if (typeof value !== "string" || value.length > 2048) return false;
	if (/[\p{C}\\]/u.test(value)) return false;
	let url: URL;
	try {
		url = new URL(value, "http://relative.invalid");
	} catch {
		return false;
	}
	const relative = url.origin === "http://relative.invalid";
	if (relative && !value.startsWith("/")) return false;
	if (relative && value.startsWith("//")) return false;
	if (!relative && !origins.some((origin) => origin === url.origin))
		return false;
	if (url.username || url.password || url.hash) return false;
	const path = url.pathname;
	if (path === "/") return url.search === "";
	if (path === "/setup" || settingsSectionFromPath(path) !== null)
		return url.search === "";
	if (path === "/native/authorize") {
		const keys = [...url.searchParams.keys()];
		return (
			keys.length === 1 &&
			keys[0] === "grantId" &&
			NATIVE_GRANT_ID.test(url.searchParams.get("grantId") ?? "")
		);
	}
	return false;
}
