// Verify a Zero JWT against its JWKS and derive the request ctx. The signature
// only proves who minted the token; the database decides whether the session
// behind it is still live, so a revoked session or device stops working at once.
// createRemoteJWKSet fetches + caches the signing keys from the auth server.
import {
	createRemoteJWKSet,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import type { Pool } from "pg";
import { pool } from "../db/client.ts";
import { withUserContext } from "../db/user-context.ts";
import { ZERO_TOKEN_TTL_SECONDS, zeroAuthConfig } from "./zero-auth.ts";

const BEARER_JWT =
	/^Bearer ([A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048})$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type ZeroClaims =
	| { kind: "browser"; userId: string; sessionId: string }
	| { kind: "native"; userId: string; sessionId: string; deviceId: string };

const isId = (value: unknown): value is string =>
	typeof value === "string" && ID.test(value);

function readClaims(payload: JWTPayload): ZeroClaims | undefined {
	const { sub, sid, authKind, did, iat, exp } = payload;
	if (typeof iat !== "number" || typeof exp !== "number") return undefined;
	if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat)
		return undefined;
	if (exp - iat > ZERO_TOKEN_TTL_SECONDS) return undefined;
	if (!isId(sub) || !isId(sid)) return undefined;
	if (authKind === "browser") {
		if (Object.hasOwn(payload, "did")) return undefined;
		return { kind: "browser", userId: sub, sessionId: sid };
	}
	if (authKind === "native" && isId(did))
		return { kind: "native", userId: sub, sessionId: sid, deviceId: did };
	return undefined;
}

const BROWSER_SESSION = `select 1
	from session s
	join "user" u on u.id = s.user_id
	where s.id = $1
		and s.user_id = $2
		and s.expires_at > now()
		and u.deleted_at is null
		and not exists (select 1 from native_session_link l where l.session_id = s.id)`;

const NATIVE_SESSION = `select 1
	from session s
	join native_session_link l on l.session_id = s.id and l.user_id = s.user_id
	join user_device d on d.id = l.device_id and d.user_id = s.user_id
	join "user" u on u.id = s.user_id
	where s.id = $1
		and s.user_id = $2
		and d.id = $3
		and s.expires_at > now()
		and u.deleted_at is null
		and d.revoked_at is null`;

export type ZeroVerifierOptions = {
	pool: Pool;
	keys: JWTVerifyGetKey;
	issuer: string;
	audience: string;
	now?: () => Date;
};

export function createZeroVerifier(options: ZeroVerifierOptions) {
	return async function verify(
		header: string | null,
	): Promise<{ id: string } | undefined> {
		const token = header === null ? null : BEARER_JWT.exec(header)?.[1];
		if (!token) return undefined;
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, options.keys, {
				issuer: options.issuer,
				audience: options.audience,
				algorithms: ["EdDSA"],
				requiredClaims: ["exp", "iat", "sub"],
				maxTokenAge: ZERO_TOKEN_TTL_SECONDS,
				currentDate: options.now?.(),
			}));
		} catch {
			return undefined;
		}
		const claims = readClaims(payload);
		if (!claims) return undefined;
		// Database faults propagate: an outage must not read as a successful auth.
		const result = await withUserContext(
			options.pool,
			claims.userId,
			(client) =>
				claims.kind === "native"
					? client.query(NATIVE_SESSION, [
							claims.sessionId,
							claims.userId,
							claims.deviceId,
						])
					: client.query(BROWSER_SESSION, [claims.sessionId, claims.userId]),
		);
		return result.rows.length === 1 ? { id: claims.userId } : undefined;
	};
}

const zero = zeroAuthConfig();

export const ctxFromAuthHeader = createZeroVerifier({
	pool,
	keys: createRemoteJWKSet(new URL(zero.jwksUrl)),
	issuer: zero.issuer,
	audience: zero.audience,
});
