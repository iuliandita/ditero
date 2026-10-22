import type { GenericOAuthConfig } from "better-auth/plugins";
import { decodeJwt } from "jose";
import type { OidcSettings } from "./provider-env.ts";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

type Discovery = { issuer: string; userinfo_endpoint?: string };
type Claims = Record<string, unknown>;

async function fetchJSON(
	url: string,
	init: RequestInit = {},
): Promise<Claims | null> {
	try {
		const response = await fetch(url, {
			...init,
			redirect: "error",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const text = await response.text();
		if (text.length > MAX_BODY_BYTES) return null;
		const body: unknown = JSON.parse(text);
		return typeof body === "object" && body !== null && !Array.isArray(body)
			? (body as Claims)
			: null;
	} catch {
		return null;
	}
}

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

// OIDC Core 5.7: email_verified is a boolean, but some servers send "true".
const flag = (value: unknown): boolean => value === true || value === "true";

export type OidcAccountSubject = (issuer: string, sub: string) => string;

// The account row is keyed by the issuer and the subject together, never the
// email: a renamed or re-pointed issuer cannot silently inherit another
// issuer's accounts.
export const oidcAccountSubject: OidcAccountSubject = (issuer, sub) =>
	`${issuer}#${sub}`;

export function oidcConfig(settings: OidcSettings): GenericOAuthConfig {
	let discovery: { value: Discovery; at: number } | undefined;
	const metadata = async (): Promise<Discovery | null> => {
		if (discovery && Date.now() - discovery.at < DISCOVERY_TTL_MS)
			return discovery.value;
		const body = await fetchJSON(settings.discoveryUrl);
		if (!body || body.issuer !== settings.issuer) return null;
		discovery = {
			value: {
				issuer: settings.issuer,
				userinfo_endpoint: str(body.userinfo_endpoint),
			},
			at: Date.now(),
		};
		return discovery.value;
	};
	return {
		providerId: settings.id,
		name: settings.name,
		discoveryUrl: settings.discoveryUrl,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		scopes: settings.scopes,
		pkce: true,
		authentication: settings.tokenAuth,
		requireIdTokenVerification: true,
		accountSubject: ({ profile }) => {
			const sub = str(profile.sub);
			if (!sub) throw new Error("OpenID Connect profile has no subject");
			return oidcAccountSubject(settings.issuer, sub);
		},
		// Better Auth has already verified the ID token signature, audience, expiry
		// and nonce against the issuer's JWKS before this runs. What remains is
		// pinning the issuer to the configured one and choosing identity claims.
		getUserInfo: async (tokens) => {
			if (!tokens.idToken) return null;
			let claims: Claims;
			try {
				claims = decodeJwt(tokens.idToken);
			} catch {
				return null;
			}
			const sub = str(claims.sub);
			if (!sub || claims.iss !== settings.issuer) return null;
			let profile = claims;
			if (!str(claims.email)) {
				// Not every IdP puts the email in the ID token. Userinfo is only
				// accepted for the same subject (OIDC Core 5.3.2).
				const found = await metadata();
				if (found?.userinfo_endpoint && tokens.accessToken) {
					const info = await fetchJSON(found.userinfo_endpoint, {
						headers: { authorization: `Bearer ${tokens.accessToken}` },
					});
					if (info && info.sub === sub) profile = { ...claims, ...info };
				}
			}
			const email = str(profile.email);
			return {
				id: sub,
				sub,
				name:
					str(profile.name) ??
					str(profile.preferred_username) ??
					email?.split("@")[0] ??
					settings.name,
				email,
				emailVerified: flag(profile.email_verified),
				image: str(profile.picture),
			};
		},
	};
}

export function oidcConfigs(settings: OidcSettings[]): GenericOAuthConfig[] {
	return settings.map(oidcConfig);
}
