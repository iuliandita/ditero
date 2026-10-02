import { createHash } from "node:crypto";
import {
	decodeProtectedHeader,
	errors,
	importJWK,
	jwtVerify,
	SignJWT,
} from "jose";
import { z } from "zod";
import { opaque, publicKey } from "../../../apps/push-relay/src/contracts.ts";
import {
	OFFER_TYPE,
	PROOF_TYPE,
	RECEIPT_TYPE,
	thumbprint,
} from "../../../apps/push-relay/src/proof.ts";
import type { RelayConfiguration } from "./relay-configuration.ts";
import {
	type Body,
	id,
	type Path,
	RelayInstanceError,
	type RelayRegistration,
	semanticDigest,
} from "./relay-contracts.ts";

export { thumbprint };
export function operationId(
	target: string,
	generation: number,
	outbox: string,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(["ditero:relay:send:v1", target, generation, outbox]),
		)
		.digest("base64url");
}
export async function signOffer(
	config: RelayRegistration,
	expires: number,
): Promise<string> {
	return new SignJWT({
		offerId: config.offerId,
		targetId: config.targetId,
		installationId: config.installationId,
		registrationId: config.registrationId,
		senderKey: config.senderKey,
		deviceThumbprint: config.deviceThumbprint,
		sendCapabilityHash: config.sendCapabilityHash,
	})
		.setProtectedHeader({
			alg: "ES256",
			typ: OFFER_TYPE,
			kid: config.senderThumbprint,
		})
		.setAudience(config.relayOrigin)
		.setIssuedAt(expires - 300)
		.setExpirationTime(expires)
		.sign(await importJWK(config.senderPrivateKey, "ES256"));
}
export async function senderProof(
	config: RelayRegistration,
	path: Path,
	body: Body,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		method: "POST",
		path,
		operationId: body.operationId,
		digest: semanticDigest(body),
		nonce: id(),
	})
		.setProtectedHeader({
			alg: "ES256",
			typ: PROOF_TYPE,
			kid: config.senderThumbprint,
		})
		.setAudience(config.relayOrigin)
		.setIssuedAt(now)
		.setExpirationTime(now + 60)
		.sign(await importJWK(config.senderPrivateKey, "ES256"));
}
export async function trustedReceipt(
	token: string,
	config: RelayConfiguration,
): Promise<Record<string, unknown>> {
	try {
		let header: ReturnType<typeof decodeProtectedHeader>;
		try {
			header = decodeProtectedHeader(token);
		} catch {
			throw new RelayInstanceError("invalid-receipt", 400);
		}
		const parsed = z
			.object({
				alg: z.literal("ES256"),
				typ: z.literal(RECEIPT_TYPE),
				kid: z.string(),
			})
			.strict()
			.parse(header);
		const key = Object.hasOwn(config.receiptKeys, parsed.kid)
			? config.receiptKeys[parsed.kid]
			: undefined;
		if (!key) throw new RelayInstanceError("invalid-receipt", 400);
		const result = await jwtVerify(token, await importJWK(key, "ES256"), {
			algorithms: ["ES256"],
			typ: RECEIPT_TYPE,
			issuer: config.origin,
			audience: config.origin,
			clockTolerance: 0,
		});
		if (
			typeof result.payload.iat !== "number" ||
			result.payload.iat > Math.floor(Date.now() / 1000)
		)
			throw new RelayInstanceError("invalid-receipt", 400);
		return result.payload;
	} catch (error) {
		if (error instanceof z.ZodError || error instanceof errors.JOSEError)
			throw new RelayInstanceError("invalid-receipt", 400);
		throw error;
	}
}
const registrationReceipt = z
	.object({
		iss: z.string(),
		aud: z.string(),
		iat: z.number().int(),
		offerId: opaque,
		offerExpires: z.number().int(),
		registrationId: z.string(),
		targetId: opaque,
		installationId: opaque,
		senderKey: publicKey,
		senderThumbprint: opaque,
		deviceThumbprint: opaque,
		relayOrigin: z.string(),
		fidHash: opaque,
		generation: z.number().int().positive(),
		credentialVersion: z.number().int().positive(),
		sendCapabilityHash: opaque,
	})
	.strict();
export async function verifyRegistrationReceipt(
	token: string,
	trust: RelayConfiguration,
	expected: RelayRegistration,
) {
	try {
		const value = registrationReceipt.parse(await trustedReceipt(token, trust));
		for (const key of [
			"offerId",
			"offerExpires",
			"registrationId",
			"targetId",
			"installationId",
			"senderThumbprint",
			"deviceThumbprint",
			"relayOrigin",
			"sendCapabilityHash",
		] as const)
			if (value[key] !== expected[key])
				throw new RelayInstanceError("invalid-receipt", 400);
		if ((await thumbprint(value.senderKey)) !== expected.senderThumbprint)
			throw new RelayInstanceError("invalid-receipt", 400);
		return value;
	} catch (error) {
		if (error instanceof z.ZodError || error instanceof errors.JOSEError)
			throw new RelayInstanceError("invalid-receipt", 400);
		throw error;
	}
}

export async function verifyTargetStatusReceipt(
	token: string,
	trust: RelayConfiguration,
	expected: RelayRegistration,
	body: Body,
) {
	try {
		const value = registrationReceipt
			.extend({
				kind: z.literal("target-status"),
				state: z.enum(["issued", "confirmed", "retired"]),
				operationId: opaque,
				digest: opaque,
			})
			.parse(await trustedReceipt(token, trust));
		for (const key of [
			"offerId",
			"offerExpires",
			"registrationId",
			"targetId",
			"installationId",
			"senderThumbprint",
			"deviceThumbprint",
			"relayOrigin",
			"sendCapabilityHash",
		] as const)
			if (value[key] !== expected[key])
				throw new RelayInstanceError("invalid-receipt", 400);
		if (
			(await thumbprint(value.senderKey)) !== expected.senderThumbprint ||
			value.operationId !== body.operationId ||
			value.digest !== semanticDigest(body)
		)
			throw new RelayInstanceError("invalid-receipt", 400);
		return value;
	} catch (error) {
		if (error instanceof z.ZodError || error instanceof errors.JOSEError)
			throw new RelayInstanceError("invalid-receipt", 400);
		throw error;
	}
}
