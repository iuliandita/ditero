import { readFileSync } from "node:fs";
import {
	BUILTIN_PROVIDER_IDS,
	BUILTIN_PROVIDER_NAMES,
	OIDC_ICONS,
	type OidcIcon,
	type SignInProviderOption,
} from "./provider-names.ts";

export type ProviderEnvironment = Record<string, string | undefined>;
export type ProviderIO = { readFile(path: string): string };

export const nodeProviderIO: ProviderIO = {
	readFile: (path) => readFileSync(path, "utf8"),
};

// Used where only the shape of the configuration matters (the public provider
// list): secret files are not opened on every /api/config request.
export const structureOnlyIO: ProviderIO = { readFile: () => "x" };

export type MicrosoftTenant =
	| { mode: "tenant"; id: string }
	| { mode: "organizations" | "consumers" | "common" };

// "credential" is the account row Better Auth keeps for email/password users;
// a provider with that ID would share its account namespace.
const RESERVED_OIDC_IDS = new Set<string>([
	...BUILTIN_PROVIDER_IDS,
	"credential",
	"email",
	"passkey",
	"oauth",
	"oidc",
]);

export const MAX_OIDC_PROVIDERS = 8;
const MAX_SECRET_BYTES = 4096;
const MAX_KEY_BYTES = 16384;
const OIDC_ID = /^[a-z][a-z0-9-]{0,31}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPLE_IDENTIFIER = /^[A-Z0-9]{10}$/;
const SCOPE_TOKEN = /^[A-Za-z0-9:._/-]{1,64}$/;
const OIDC_SUFFIXES = [
	"ISSUER",
	"DISCOVERY_URL",
	"CLIENT_ID",
	"CLIENT_SECRET",
	"CLIENT_SECRET_FILE",
	"NAME",
	"ICON",
	"SCOPES",
	"TOKEN_AUTH",
];

export type ClientCredentials = { clientId: string; clientSecret: string };

export type OidcSettings = {
	id: string;
	name: string;
	icon: OidcIcon;
	issuer: string;
	discoveryUrl: string;
	clientId: string;
	clientSecret: string;
	scopes: string[];
	tokenAuth: "basic" | "post";
};

export type AppleSettings = {
	clientId: string;
	teamId: string;
	keyId: string;
	privateKeyPath: string;
};

export type ProviderSettings = {
	google?: ClientCredentials;
	github?: ClientCredentials;
	discord?: ClientCredentials;
	facebook?: ClientCredentials;
	microsoft?: ClientCredentials & { tenant: MicrosoftTenant };
	apple?: AppleSettings;
	oidc: OidcSettings[];
};

export class ProviderConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderConfigError";
	}
}

function fail(message: string): never {
	throw new ProviderConfigError(message);
}

function present(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	return value === undefined || value === "" ? undefined : value;
}

function checkLine(name: string, value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") > maxBytes)
		fail(`${name}: value is too long`);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the hostile input being refused
	if (/[\u0000-\u001f\u007f]/.test(value))
		fail(`${name}: value must be a single line without control characters`);
	return value;
}

// NAME or NAME_FILE. The container entrypoint already copies a *_FILE secret
// into NAME for Google, so both being set is only an error when they disagree.
function secret(
	env: ProviderEnvironment,
	name: string,
	io: ProviderIO,
): string | undefined {
	const plain = present(env[name]);
	const path = present(env[`${name}_FILE`]);
	if (path === undefined) {
		return plain === undefined
			? undefined
			: checkLine(name, plain, MAX_SECRET_BYTES);
	}
	let text: string;
	try {
		text = io.readFile(path);
	} catch {
		fail(`${name}_FILE: not a readable file`);
	}
	const value = text.replace(/[\r\n]+$/, "");
	if (value === "") fail(`${name}_FILE: file is empty`);
	checkLine(`${name}_FILE`, value, MAX_SECRET_BYTES);
	if (io !== structureOnlyIO && plain !== undefined && plain !== value)
		fail(`${name} and ${name}_FILE are both set`);
	return value;
}

function required(env: ProviderEnvironment, name: string): string {
	const value = present(env[name]);
	if (value === undefined) fail(`${name} is required`);
	return checkLine(name, value, 512);
}

function credentials(
	env: ProviderEnvironment,
	prefix: string,
	io: ProviderIO,
	lenient = false,
): ClientCredentials | undefined {
	const clientId = present(env[`${prefix}_CLIENT_ID`]);
	const clientSecret = secret(env, `${prefix}_CLIENT_SECRET`, io);
	if (clientId === undefined && clientSecret === undefined) return undefined;
	if (clientId === undefined || clientSecret === undefined) {
		// Google predates strict parsing; a half-set pair has always meant "off".
		if (lenient) return undefined;
		fail(
			`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together`,
		);
	}
	return {
		clientId: checkLine(`${prefix}_CLIENT_ID`, clientId, 512),
		clientSecret,
	};
}

// Loopback http keeps local development and tests possible; everything else
// that carries a client secret or an authorization code must be https.
export function providerURL(name: string, raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		fail(`${name}: not a valid URL`);
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		fail(`${name}: must be an https URL (http is allowed for loopback only)`);
	if (url.username || url.password)
		fail(`${name}: must not contain credentials`);
	if (url.search || url.hash)
		fail(`${name}: must not contain a query or fragment`);
	return url;
}

function microsoftTenant(raw: string | undefined): MicrosoftTenant {
	const value = present(raw);
	if (value === undefined)
		fail(
			"MICROSOFT_TENANT is required: a tenant ID, organizations, consumers or common",
		);
	const mode = value.toLowerCase();
	if (mode === "organizations" || mode === "consumers" || mode === "common")
		return { mode };
	if (GUID.test(value)) return { mode: "tenant", id: value.toLowerCase() };
	return fail(
		"MICROSOFT_TENANT must be a tenant GUID, organizations, consumers or common",
	);
}

function appleSettings(env: ProviderEnvironment): AppleSettings | undefined {
	const keys = [
		"APPLE_CLIENT_ID",
		"APPLE_TEAM_ID",
		"APPLE_KEY_ID",
		"APPLE_PRIVATE_KEY_FILE",
	];
	if (keys.every((key) => present(env[key]) === undefined)) return undefined;
	const clientId = required(env, "APPLE_CLIENT_ID");
	const teamId = required(env, "APPLE_TEAM_ID");
	const keyId = required(env, "APPLE_KEY_ID");
	const privateKeyPath = required(env, "APPLE_PRIVATE_KEY_FILE");
	if (!APPLE_IDENTIFIER.test(teamId))
		fail("APPLE_TEAM_ID must be the 10-character Apple team ID");
	if (!APPLE_IDENTIFIER.test(keyId))
		fail("APPLE_KEY_ID must be the 10-character Apple key ID");
	return { clientId, teamId, keyId, privateKeyPath };
}

export function readApplePrivateKey(path: string, io: ProviderIO): string {
	let pem: string;
	try {
		pem = io.readFile(path);
	} catch {
		return fail("APPLE_PRIVATE_KEY_FILE: not a readable file");
	}
	if (Buffer.byteLength(pem, "utf8") > MAX_KEY_BYTES)
		fail("APPLE_PRIVATE_KEY_FILE: file is too large");
	if (!pem.includes("-----BEGIN PRIVATE KEY-----"))
		fail("APPLE_PRIVATE_KEY_FILE: expected the PKCS#8 .p8 key from Apple");
	return pem;
}

function oidcIds(env: ProviderEnvironment): string[] {
	const raw = present(env.DITERO_OIDC_PROVIDERS);
	if (raw === undefined) return [];
	const ids = raw.split(",").map((id) => id.trim());
	if (ids.some((id) => id === ""))
		fail("DITERO_OIDC_PROVIDERS: empty provider ID");
	if (ids.length > MAX_OIDC_PROVIDERS)
		fail(`DITERO_OIDC_PROVIDERS: at most ${MAX_OIDC_PROVIDERS} providers`);
	for (const id of ids) {
		if (!OIDC_ID.test(id))
			fail(
				`DITERO_OIDC_PROVIDERS: "${id}" must be lowercase letters, digits and hyphens, starting with a letter (max 32)`,
			);
		if (RESERVED_OIDC_IDS.has(id))
			fail(`DITERO_OIDC_PROVIDERS: "${id}" is a reserved provider ID`);
	}
	if (new Set(ids).size !== ids.length)
		fail("DITERO_OIDC_PROVIDERS: duplicate provider ID");
	return ids;
}

const envKey = (id: string) => id.toUpperCase().replaceAll("-", "_");

function rejectUnlistedOidcVariables(
	env: ProviderEnvironment,
	ids: string[],
): void {
	const known = new Set(ids.map(envKey));
	for (const name of Object.keys(env)) {
		if (!name.startsWith("DITERO_OIDC_") || name === "DITERO_OIDC_PROVIDERS")
			continue;
		if (present(env[name]) === undefined) continue;
		const body = name.slice("DITERO_OIDC_".length);
		const suffix = OIDC_SUFFIXES.find((candidate) =>
			body.endsWith(`_${candidate}`),
		);
		const key =
			suffix === undefined ? undefined : body.slice(0, -suffix.length - 1);
		if (key === undefined || !known.has(key))
			fail(
				`${name}: not a recognised setting for a provider listed in DITERO_OIDC_PROVIDERS`,
			);
	}
}

function oidcSettings(
	env: ProviderEnvironment,
	id: string,
	io: ProviderIO,
): OidcSettings {
	const prefix = `DITERO_OIDC_${envKey(id)}`;
	const issuer = required(env, `${prefix}_ISSUER`);
	providerURL(`${prefix}_ISSUER`, issuer);
	const discoveryRaw = present(env[`${prefix}_DISCOVERY_URL`]);
	const discoveryUrl = discoveryRaw
		? providerURL(`${prefix}_DISCOVERY_URL`, discoveryRaw).href
		: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
	const clientId = required(env, `${prefix}_CLIENT_ID`);
	const clientSecret = secret(env, `${prefix}_CLIENT_SECRET`, io);
	if (clientSecret === undefined)
		fail(
			`${prefix}_CLIENT_SECRET is required (or set ${prefix}_CLIENT_SECRET_FILE)`,
		);
	const name = present(env[`${prefix}_NAME`]) ?? id;
	if ([...name].length > 40) fail(`${prefix}_NAME: at most 40 characters`);
	checkLine(`${prefix}_NAME`, name, 160);
	const icon = present(env[`${prefix}_ICON`]) ?? "key";
	if (!(OIDC_ICONS as readonly string[]).includes(icon))
		fail(`${prefix}_ICON: one of ${OIDC_ICONS.join(", ")}`);
	const extra = (present(env[`${prefix}_SCOPES`]) ?? "")
		.split(/\s+/)
		.filter(Boolean);
	if (extra.length > 10) fail(`${prefix}_SCOPES: at most 10 scopes`);
	for (const scope of extra)
		if (!SCOPE_TOKEN.test(scope))
			fail(`${prefix}_SCOPES: "${scope}" is not a valid scope`);
	const tokenAuth = present(env[`${prefix}_TOKEN_AUTH`]) ?? "basic";
	if (tokenAuth !== "basic" && tokenAuth !== "post")
		fail(`${prefix}_TOKEN_AUTH: basic or post`);
	return {
		id,
		name,
		icon: icon as OidcIcon,
		issuer,
		discoveryUrl,
		clientId,
		clientSecret,
		scopes: [...new Set(["openid", "email", "profile", ...extra])],
		tokenAuth,
	};
}

export function readProviderSettings(
	env: ProviderEnvironment,
	io: ProviderIO = nodeProviderIO,
): ProviderSettings {
	const ids = oidcIds(env);
	rejectUnlistedOidcVariables(env, ids);
	const settings: ProviderSettings = {
		oidc: ids.map((id) => oidcSettings(env, id, io)),
	};
	const google = credentials(env, "GOOGLE", io, true);
	if (google) settings.google = google;
	const github = credentials(env, "GITHUB", io);
	if (github) settings.github = github;
	const discord = credentials(env, "DISCORD", io);
	if (discord) settings.discord = discord;
	const facebook = credentials(env, "FACEBOOK", io);
	if (facebook) settings.facebook = facebook;
	const microsoft = credentials(env, "MICROSOFT", io);
	if (microsoft)
		settings.microsoft = {
			...microsoft,
			tenant: microsoftTenant(env.MICROSOFT_TENANT),
		};
	else if (present(env.MICROSOFT_TENANT) !== undefined)
		fail(
			"MICROSOFT_TENANT is set without MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET",
		);
	const apple = appleSettings(env);
	if (apple) settings.apple = apple;
	return settings;
}

export type PublicSignInProvider = SignInProviderOption;

export function publicSignInProviders(
	settings: ProviderSettings,
): PublicSignInProvider[] {
	const builtin = BUILTIN_PROVIDER_IDS.filter((id) => settings[id]).map(
		(id) => ({ id, name: BUILTIN_PROVIDER_NAMES[id], icon: null }),
	);
	const oidc = settings.oidc.map(({ id, name, icon }) => ({ id, name, icon }));
	return [...builtin, ...oidc];
}
