import { calculateJwkThumbprint, importJWK, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
	LIMITS,
	opaque,
	type PublicKey,
	publicKey,
	RelayError,
} from "./contracts.ts";

export const PROOF_TYPE = "ditero-relay-proof+jwt";
export const OFFER_TYPE = "ditero-relay-offer+jwt";
export const RECEIPT_TYPE = "ditero-relay-receipt+jwt";
export async function thumbprint(key: PublicKey): Promise<string> {
	return calculateJwkThumbprint(publicKey.parse(key));
}
const claims = z
	.object({
		aud: z.string(),
		iat: z.number().int(),
		exp: z.number().int(),
		method: z.literal("POST"),
		path: z.string(),
		operationId: opaque,
		digest: opaque,
		nonce: opaque,
	})
	.strict();
export async function verifyProof(
	token: string | undefined,
	key: PublicKey,
	origin: string,
	path: string,
	operationId: string,
	digest: string,
): Promise<{ key: string; nonce: string }> {
	if (!token) throw new RelayError(401, "unauthorized");
	try {
		const kid = await thumbprint(key);
		const verified = await jwtVerify(token, await importJWK(key, "ES256"), {
			algorithms: ["ES256"],
			audience: origin,
			typ: PROOF_TYPE,
			maxTokenAge: LIMITS.proof,
			clockTolerance: LIMITS.tolerance,
		});
		const header = z
			.object({
				alg: z.literal("ES256"),
				typ: z.literal(PROOF_TYPE),
				kid: z.literal(kid),
			})
			.strict()
			.parse(verified.protectedHeader);
		const value = claims.parse(verified.payload);
		const now = Math.floor(Date.now() / 1000);
		if (
			!header ||
			value.aud !== origin ||
			value.method !== "POST" ||
			value.path !== path ||
			value.operationId !== operationId ||
			value.digest !== digest ||
			value.exp <= value.iat ||
			value.exp - value.iat > LIMITS.proof ||
			value.iat > now + LIMITS.tolerance
		)
			throw new Error("claims");
		return { key: kid, nonce: value.nonce };
	} catch {
		throw new RelayError(401, "unauthorized");
	}
}
export const offerClaims = z
	.object({
		aud: z.string(),
		iat: z.number().int(),
		exp: z.number().int(),
		installationId: opaque,
		offerId: opaque,
		targetId: opaque,
		registrationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		senderKey: publicKey,
		deviceThumbprint: opaque,
		sendCapabilityHash: opaque,
	})
	.strict();
export async function verifyOffer(
	token: string,
	senderKey: PublicKey,
	expected: {
		origin: string;
		installationId: string;
		offerId: string;
		targetId: string;
		registrationId: string;
		deviceThumbprint: string;
		sendCapabilityHash: string;
	},
): Promise<number> {
	try {
		const kid = await thumbprint(senderKey);
		const verified = await jwtVerify(
			token,
			await importJWK(senderKey, "ES256"),
			{
				algorithms: ["ES256"],
				audience: expected.origin,
				typ: OFFER_TYPE,
				clockTolerance: 0,
			},
		);
		z.object({
			alg: z.literal("ES256"),
			typ: z.literal(OFFER_TYPE),
			kid: z.literal(kid),
		})
			.strict()
			.parse(verified.protectedHeader);
		const value = offerClaims.parse(verified.payload);
		if (
			value.exp - value.iat > LIMITS.offer ||
			value.exp <= value.iat ||
			value.iat > Math.floor(Date.now() / 1000) ||
			value.installationId !== expected.installationId ||
			value.offerId !== expected.offerId ||
			value.targetId !== expected.targetId ||
			value.registrationId !== expected.registrationId ||
			value.deviceThumbprint !== expected.deviceThumbprint ||
			value.sendCapabilityHash !== expected.sendCapabilityHash ||
			(await thumbprint(value.senderKey)) !== kid
		)
			throw new Error("offer");
		return value.exp;
	} catch {
		throw new RelayError(401, "unauthorized");
	}
}
export type ReceiptSigner = { kid: string; privateKey: CryptoKey };
export async function receipt(
	signer: ReceiptSigner,
	bindings: Record<string, unknown>,
	origin: string,
): Promise<string> {
	return new SignJWT(bindings)
		.setProtectedHeader({ alg: "ES256", typ: RECEIPT_TYPE, kid: signer.kid })
		.setIssuer(origin)
		.setAudience(origin)
		.setIssuedAt()
		.sign(signer.privateKey);
}
