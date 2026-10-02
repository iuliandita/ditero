import { createLocalJWKSet, jwtVerify } from "jose";
import { safeFetch } from "../../../src/security/safe-http.ts";
import { LIMITS, RelayError } from "./contracts.ts";
export const APP_CHECK_JWKS = "https://firebaseappcheck.googleapis.com/v1/jwks";
export type ProtectedFetch = typeof safeFetch;
export function createAppCheckVerifier(
	config: { projectNumber: string; appIds: string[] },
	transport: ProtectedFetch = safeFetch,
) {
	let cached: ReturnType<typeof createLocalJWKSet> | undefined;
	let until = 0;
	let inFlight: Promise<void> | undefined;
	async function refresh(signal: AbortSignal) {
		if (!inFlight)
			inFlight = (async () => {
				const response = await transport(APP_CHECK_JWKS, {
					signal,
					maxResponseBytes: LIMITS.body,
					headersTimeoutMs: LIMITS.deadline,
				});
				if (!response.ok) throw new Error("jwks");
				const raw = await response.text();
				if (Buffer.byteLength(raw) > LIMITS.body) throw new Error("jwks");
				const data: unknown = JSON.parse(raw);
				if (
					!data ||
					typeof data !== "object" ||
					!("keys" in data) ||
					!Array.isArray(data.keys) ||
					data.keys.length < 1 ||
					data.keys.length > 20 ||
					!data.keys.every(
						(key) =>
							key &&
							key.kty === "RSA" &&
							typeof key.kid === "string" &&
							typeof key.n === "string" &&
							typeof key.e === "string" &&
							!key.d &&
							(!key.alg || key.alg === "RS256"),
					)
				)
					throw new Error("jwks");
				cached = createLocalJWKSet({ keys: data.keys });
				until = Date.now() + 3600000;
			})().finally(() => {
				inFlight = undefined;
			});
		await inFlight;
	}
	return async (
		token: string | undefined,
		signal: AbortSignal,
	): Promise<string> => {
		if (!token) throw new RelayError(401, "unauthorized");
		try {
			if (!cached || until <= Date.now()) await refresh(signal);
		} catch {
			throw new RelayError(503, "attestation_unavailable");
		}
		if (!cached) throw new RelayError(503, "attestation_unavailable");
		try {
			const result = await jwtVerify(token, cached, {
				algorithms: ["RS256"],
				issuer: `https://firebaseappcheck.googleapis.com/${config.projectNumber}`,
				audience: `projects/${config.projectNumber}`,
				clockTolerance: 5,
			});
			const now = Math.floor(Date.now() / 1000);
			if (
				result.protectedHeader.jku ||
				result.protectedHeader.jwk ||
				result.protectedHeader.x5u ||
				typeof result.payload.exp !== "number" ||
				typeof result.payload.iat !== "number" ||
				result.payload.exp <= result.payload.iat ||
				result.payload.iat > now + 5 ||
				!result.payload.sub ||
				!config.appIds.includes(result.payload.sub)
			)
				throw new Error("identity");
			return result.payload.sub;
		} catch {
			throw new RelayError(401, "unauthorized");
		}
	};
}
