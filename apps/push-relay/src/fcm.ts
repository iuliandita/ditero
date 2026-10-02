import { createSign } from "node:crypto";
import { safeFetch } from "../../../src/security/safe-http.ts";
import type { ProtectedFetch } from "./app-check.ts";
import type { Configuration } from "./configuration.ts";
import { LIMITS, type Outcome, type PushData } from "./contracts.ts";
export const OAUTH_URL = "https://oauth2.googleapis.com/token";
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
export type PushSender = (
	fid: string,
	data: PushData,
	priority: "normal" | "high",
	signal: AbortSignal,
) => Promise<Outcome>;
export function createFcmSender(
	config: Pick<Configuration, "projectId" | "clientEmail" | "privateKey">,
	transport: ProtectedFetch = safeFetch,
): PushSender {
	let cached: { token: string; until: number } | undefined;
	async function token(signal: AbortSignal): Promise<string> {
		if (cached && cached.until > Date.now() + 60000) return cached.token;
		const now = Math.floor(Date.now() / 1000);
		const encoded = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const input = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({ iss: config.clientEmail, scope: FCM_SCOPE, aud: OAUTH_URL, iat: now, exp: now + 3600 })}`;
		const sign = createSign("RSA-SHA256");
		sign.update(input);
		const assertion = `${input}.${sign.sign(config.privateKey).toString("base64url")}`;
		const response = await transport(OAUTH_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion,
			}).toString(),
			signal,
			maxResponseBytes: LIMITS.body,
			headersTimeoutMs: LIMITS.deadline,
		});
		const raw = await response.text();
		if (!response.ok || Buffer.byteLength(raw) > LIMITS.body)
			throw new Error("oauth");
		const value = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof value.access_token !== "string" ||
			!/^[\x21-\x7e]{1,4096}$/.test(value.access_token) ||
			value.token_type !== "Bearer" ||
			typeof value.expires_in !== "number" ||
			!Number.isInteger(value.expires_in) ||
			value.expires_in < 120 ||
			value.expires_in > 3600
		)
			throw new Error("oauth");
		cached = {
			token: value.access_token,
			until: Date.now() + value.expires_in * 1000,
		};
		return cached.token;
	}
	return async (fid, data, priority, signal) => {
		try {
			const response = await transport(
				`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${await token(signal)}`,
					},
					body: JSON.stringify({
						message: { fid, data, android: { priority, ttl: "300s" } },
					}),
					signal,
					maxResponseBytes: LIMITS.body,
					headersTimeoutMs: LIMITS.deadline,
				},
			);
			const raw = await response.text();
			if (Buffer.byteLength(raw) > LIMITS.body) return { kind: "retryable" };
			if (response.ok) {
				const body = JSON.parse(raw) as Record<string, unknown>;
				return typeof body.name === "string" &&
					body.name.startsWith(`projects/${config.projectId}/messages/`)
					? { kind: "accepted" }
					: { kind: "retryable" };
			}
			if (response.status === 401) cached = undefined;
			try {
				const value = JSON.parse(raw) as {
					error?: { details?: { "@type"?: string; errorCode?: string }[] };
				};
				if (
					response.status === 404 &&
					value.error?.details?.some(
						(item) =>
							item["@type"] ===
								"type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
							item.errorCode === "UNREGISTERED",
					)
				)
					return { kind: "stale" };
			} catch {
				/* Provider response is untrusted. */
			}
			return {
				kind:
					response.status === 429
						? "quota"
						: response.status === 401 || response.status >= 500
							? "retryable"
							: "permanent",
			};
		} catch {
			return { kind: "retryable" };
		}
	};
}
