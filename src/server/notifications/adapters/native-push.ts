import { createSign } from "node:crypto";
import webPush from "web-push";
import type { ProviderResult } from "../../../domain/notification-retry.ts";
import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import type {
	PushConfiguration,
	PushRegistration,
} from "../../native-push/contracts.ts";
import { retryAfterSeconds } from "./retry-after.ts";
import type { AdapterContext } from "./types.ts";
import { permanent } from "./types.ts";

export type NativePushPayload = {
	version: "1";
	notificationId: string;
	registrationId: string;
};
export type NativePushResult = { result: ProviderResult; expired: boolean };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const MAX_BYTES = 16 * 1024;

// One sender owns one operator identity. It never accepts project authority from a device.
export function createNativePushSender(configuration: PushConfiguration) {
	let token: { value: string; expires: number } | null = null;
	async function sendRequest(
		url: string,
		body: string | Buffer,
		headers: HeadersInit,
		ctx: AdapterContext,
	) {
		return (ctx.fetch ?? safeFetch)(url, {
			method: "POST",
			body,
			headers,
			signal: ctx.signal,
			allowedPrivateCIDRs: ctx.allowedPrivateCIDRs,
			headersTimeoutMs: ctx.deadlineMs,
			maxResponseBytes: MAX_BYTES,
		});
	}
	async function accessToken(ctx: AdapterContext): Promise<string> {
		if (token && token.expires > Date.now() + 60_000) return token.value;
		const account = configuration.fcm;
		if (!account) throw new Error("disabled");
		const now = Math.floor(Date.now() / 1000);
		const encode = (value: unknown) =>
			Buffer.from(JSON.stringify(value)).toString("base64url");
		const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
		const signer = createSign("RSA-SHA256");
		signer.update(unsigned);
		const assertion = `${unsigned}.${signer.sign(account.privateKey).toString("base64url")}`;
		const response = await sendRequest(
			TOKEN_URL,
			new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion,
			}).toString(),
			{ "content-type": "application/x-www-form-urlencoded" },
			ctx,
		);
		if (!response.ok) throw new Error("oauth");
		const raw = await response.text();
		if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("oauth");
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
		token = {
			value: value.access_token,
			expires: Date.now() + value.expires_in * 1000,
		};
		return token.value;
	}
	return async (
		registration: PushRegistration,
		payload: NativePushPayload,
		ctx: AdapterContext,
		urgent = false,
	): Promise<NativePushResult> => {
		if (
			payload.version !== "1" ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(payload.notificationId) ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(payload.registrationId)
		)
			return {
				result: permanent("native push payload invalid"),
				expired: false,
			};
		const available = configuration[registration.provider];
		if (!available)
			return {
				result: permanent("native push provider disabled"),
				expired: false,
			};
		try {
			let response: Response;
			if (registration.provider === "unifiedpush") {
				const vapid = configuration.unifiedpush;
				if (!vapid)
					return {
						result: permanent("native push provider disabled"),
						expired: false,
					};
				// Only encryption/request construction comes from web-push. Its HTTP client is never called.
				const details = webPush.generateRequestDetails(
					registration,
					JSON.stringify(payload),
					{
						vapidDetails: vapid,
						contentEncoding: "aes128gcm",
						TTL: 300,
						urgency: urgent ? "high" : "normal",
					},
				);
				if (!details.body || details.endpoint !== registration.endpoint)
					throw new Error("request");
				response = await sendRequest(
					details.endpoint,
					details.body,
					details.headers,
					ctx,
				);
			} else {
				const account = configuration.fcm;
				if (!account)
					return {
						result: permanent("native push provider disabled"),
						expired: false,
					};
				const sendFcm = async () =>
					sendRequest(
						`https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
						JSON.stringify({
							message: {
								token: registration.token,
								data: payload,
								android: { priority: urgent ? "high" : "normal", ttl: "300s" },
							},
						}),
						{
							"content-type": "application/json",
							authorization: `Bearer ${await accessToken(ctx)}`,
						},
						ctx,
					);
				response = await sendFcm();
				if (response.status === 401) {
					token = null;
					response = await sendFcm();
				}
			}
			if (response.ok)
				return {
					result: { ok: true, status: response.status },
					expired: false,
				};
			let expired =
				registration.provider === "unifiedpush" &&
				(response.status === 404 || response.status === 410);
			if (registration.provider === "fcm") {
				if (response.status === 401) token = null;
				const raw = await response.text();
				if (Buffer.byteLength(raw) <= MAX_BYTES) {
					try {
						const body = JSON.parse(raw) as { error?: { details?: unknown[] } };
						expired =
							response.status === 404 &&
							!!body.error?.details?.some(
								(value) =>
									value !== null &&
									typeof value === "object" &&
									(value as Record<string, unknown>)["@type"] ===
										"type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
									(value as Record<string, unknown>).errorCode ===
										"UNREGISTERED",
							);
					} catch {
						/* Untrusted error bodies never reach logs. */
					}
				}
			}
			return {
				result: expired
					? {
							...permanent("native push registration expired"),
							status: response.status,
						}
					: {
							ok: false,
							status: response.status,
							error: "native push provider rejected request",
							retryAfterSec: retryAfterSeconds(
								response.headers.get("retry-after"),
							),
						},
				expired,
			};
		} catch (error) {
			return {
				result:
					error instanceof OutboundPolicyError
						? permanent("native push outbound policy refused request")
						: {
								ok: false,
								error: "native push transport or authorization failed",
							},
				expired: false,
			};
		}
	};
}
