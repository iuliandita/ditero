import { OutboundPolicyError, safeFetch } from "../../../security/safe-http.ts";
import type { RelayConfiguration } from "../../native-push/relay-configuration.ts";
import {
	type Body,
	type Path,
	type RelayRegistration,
	schemas,
	semanticDigest,
} from "../../native-push/relay-contracts.ts";
import {
	operationId,
	senderProof,
	trustedReceipt,
} from "../../native-push/relay-proof.ts";
import type { NativePushPayload, NativePushResult } from "./native-push.ts";
import { type AdapterContext, permanent } from "./types.ts";
export async function relayRequest(
	config: RelayRegistration,
	trust: RelayConfiguration,
	path: Path,
	body: Body,
	ctx: AdapterContext,
): Promise<{ status: number; body: Record<string, unknown> }> {
	if (config.relayOrigin !== trust.origin)
		throw new OutboundPolicyError("Relay origin changed");
	const parsed = schemas[path].parse(body) as Body;
	const proof = await senderProof(config, path, parsed);
	const signal = AbortSignal.any([
		ctx.signal,
		AbortSignal.timeout(Math.min(ctx.deadlineMs, 10000)),
	]);
	const response = await (ctx.fetch ?? safeFetch)(`${trust.origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...parsed, senderProof: proof }),
		signal,
		allowedPrivateCIDRs: ctx.allowedPrivateCIDRs,
		headersTimeoutMs: Math.min(ctx.deadlineMs, 10000),
		maxResponseBytes: 16384,
	});
	const text = await response.text();
	signal.throwIfAborted();
	if (Buffer.byteLength(text) > 16384)
		throw new Error("Relay response oversized");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid relay response");
	return { status: response.status, body: value as Record<string, unknown> };
}
export function createRelayPushSender(trust: RelayConfiguration | undefined) {
	return async (
		config: RelayRegistration,
		data: NativePushPayload,
		ctx: AdapterContext,
		urgent = false,
	): Promise<NativePushResult> => {
		if (!trust)
			return {
				result: permanent("native relay provider disabled"),
				expired: false,
			};
		const body: Body<"/v1/send"> = {
			installationId: config.installationId,
			targetId: config.targetId,
			registrationId: config.registrationId,
			operationId: operationId(
				config.targetId,
				config.generation,
				data.notificationId,
			),
			generation: config.generation,
			sendCapability: config.sendCapability,
			priority: urgent ? "high" : "normal",
			data,
		};
		try {
			const response = await relayRequest(config, trust, "/v1/send", body, ctx);
			if (
				response.status === 200 &&
				response.body.kind === "accepted" &&
				typeof response.body.receipt === "string"
			) {
				const receipt = await trustedReceipt(response.body.receipt, trust);
				for (const [key, value] of Object.entries({
					kind: "accepted",
					operationId: body.operationId,
					digest: semanticDigest(body),
					targetId: config.targetId,
					installationId: config.installationId,
					registrationId: config.registrationId,
					generation: config.generation,
					senderThumbprint: config.senderThumbprint,
					deviceThumbprint: config.deviceThumbprint,
					sendCapabilityHash: config.sendCapabilityHash,
				}))
					if (receipt[key] !== value)
						throw new Error("Accepted receipt mismatch");
				return { result: { ok: true, status: 202 }, expired: false };
			}
			if (response.body.kind === "stale")
				return {
					result: {
						ok: false,
						status: 503,
						error: "native relay awaiting verified generation update",
					},
					expired: false,
				};
			if (
				response.body.kind === "permanent" ||
				response.status === 401 ||
				response.status === 403
			)
				return {
					result: permanent("native relay registration refused"),
					expired: false,
				};
			if (response.body.kind === "quota" || response.status === 429)
				return {
					result: {
						ok: false,
						status: 429,
						error: "native relay quota exceeded",
					},
					expired: false,
				};
			return {
				result: {
					ok: false,
					status: 503,
					error:
						"native relay acceptance uncertain; retry may duplicate delivery",
				},
				expired: false,
			};
		} catch (error) {
			return {
				result:
					error instanceof OutboundPolicyError
						? permanent("native relay outbound policy refused request")
						: {
								ok: false,
								error:
									"native relay acceptance uncertain; retry may duplicate delivery",
							},
				expired: false,
			};
		}
	};
}
