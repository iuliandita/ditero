// Zero JWT settings and payloads shared by the signing side (auth.ts, the
// native token route) and the verifying side (ctx.ts). Kept free of the auth
// instance so neither side pulls the other in.
import type { NativeSession } from "./native-auth/session.ts";

export const ZERO_TOKEN_TTL_SECONDS = 300;

// Issuer, audience and JWKS location all derive from one normalized base, so
// a trailing slash in BETTER_AUTH_URL cannot make signer and verifier disagree.
export function zeroAuthConfig(baseUrl = process.env.BETTER_AUTH_URL) {
	const issuer = (baseUrl || "http://localhost:3000").replace(/\/+$/, "");
	return {
		issuer,
		audience: `${issuer}/api/zero`,
		jwksUrl: `${issuer}/api/auth/jwks`,
	};
}

function cappedExp(issuedAt: number, expiresAt: Date): number {
	return Math.min(
		issuedAt + ZERO_TOKEN_TTL_SECONDS,
		Math.floor(expiresAt.getTime() / 1000),
	);
}

// The plugin adds sub (the user id) and iat; nothing else of the user is signed.
export function browserZeroPayload(session: {
	session: { id: string; expiresAt: Date };
}) {
	return {
		sid: session.session.id,
		authKind: "browser",
		exp: cappedExp(Math.floor(Date.now() / 1000), session.session.expiresAt),
	};
}

// Built only from a database-derived NativeSession, never from caller input.
export function nativeZeroPayload(session: NativeSession, nowMs = Date.now()) {
	const iat = Math.floor(nowMs / 1000);
	return {
		sub: session.userId,
		sid: session.sessionId,
		authKind: "native",
		did: session.deviceId,
		iat,
		exp: cappedExp(iat, session.expiresAt),
	};
}

export function zeroJwtOptions() {
	const { issuer, audience } = zeroAuthConfig();
	return {
		issuer,
		audience,
		expirationTime: `${ZERO_TOKEN_TTL_SECONDS}s`,
		definePayload: browserZeroPayload,
	};
}
