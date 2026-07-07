// Verify a Better Auth JWT against its JWKS and derive the request ctx.
// createRemoteJWKSet fetches + caches the signing keys from the auth server.
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
	new URL(`${process.env.BETTER_AUTH_URL}/api/auth/jwks`),
);

export async function ctxFromAuthHeader(
	h: string | null,
): Promise<{ id: string } | undefined> {
	const token = h?.replace(/^Bearer\s+/i, "");
	if (!token) return undefined;
	try {
		const { payload } = await jwtVerify(token, JWKS);
		return payload.sub ? { id: payload.sub } : undefined;
	} catch {
		return undefined;
	}
}
