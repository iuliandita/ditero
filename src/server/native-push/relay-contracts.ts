import { z } from "zod";
import { opaque, publicKey } from "../../../apps/push-relay/src/contracts.ts";

export type {
	Body,
	Path,
	PublicKey,
	PushData,
} from "../../../apps/push-relay/src/contracts.ts";
export {
	canonical,
	credentialHash,
	id,
	LIMITS,
	schemas,
	semanticDigest,
} from "../../../apps/push-relay/src/contracts.ts";
export const allocateOffer = z
	.object({ operationId: opaque, installationId: opaque, deviceKey: publicKey })
	.strict();
export const activateOffer = z
	.object({ offerId: opaque, receipt: z.string().max(8192) })
	.strict();
export const updateReceipt = z
	.object({
		registrationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		expectedGeneration: z.number().int().positive(),
		receipt: z.string().max(8192),
	})
	.strict();
export const relayRegistration = z
	.object({
		provider: z.literal("fcm-relay"),
		relayOrigin: z.string(),
		installationId: opaque,
		targetId: opaque,
		registrationId: z.string(),
		offerId: opaque,
		offerExpires: z.number().int(),
		senderKey: publicKey,
		senderPrivateKey: z
			.object({
				kty: z.literal("EC"),
				crv: z.literal("P-256"),
				x: opaque,
				y: opaque,
				d: opaque,
			})
			.strict(),
		senderThumbprint: opaque,
		deviceThumbprint: opaque,
		sendCapability: opaque,
		sendCapabilityHash: opaque,
		generation: z.number().int().positive(),
		credentialVersion: z.number().int().positive(),
		fidHash: z.string().nullable(),
	})
	.strict();
export type RelayRegistration = z.infer<typeof relayRegistration>;
export class RelayInstanceError extends Error {
	constructor(
		readonly code: string,
		readonly status = 409,
	) {
		super(code);
	}
}
