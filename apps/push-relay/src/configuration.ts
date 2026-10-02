import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { importJWK } from "jose";
import { z } from "zod";
import {
	createFieldKeyRing,
	type FieldKeyRing,
} from "../../../src/security/field-encryption.ts";
import { type PublicKey, publicKey } from "./contracts.ts";
import type { ReceiptSigner } from "./proof.ts";

const configSchema = z
	.object({
		origin: z.string().url(),
		projectNumber: z.string().regex(/^[0-9]{1,30}$/),
		projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
		appIds: z
			.array(z.string().regex(/^1:[0-9]+:android:[a-fA-F0-9]+$/))
			.min(1)
			.max(20),
		clientEmail: z.string().max(320),
		privateKey: z.string().max(16384),
		encryptionKey: z.string(),
		nextEncryptionKey: z.string().optional(),
		receiptKey: publicKey
			.extend({ d: z.string(), kid: z.string().min(1).max(128) })
			.strict(),
		receiptVerificationKeys: z
			.array(publicKey.extend({ kid: z.string().min(1).max(128) }).strict())
			.min(1)
			.max(5),
	})
	.strict();
export type Configuration = {
	origin: string;
	projectNumber: string;
	projectId: string;
	appIds: string[];
	clientEmail: string;
	privateKey: string;
	encryption: FieldKeyRing;
	signer: ReceiptSigner;
	receiptVerificationKeys: (PublicKey & { kid: string })[];
};
export async function loadConfiguration(file: string): Promise<Configuration> {
	const stat = statSync(file);
	if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0)
		throw new Error("Relay configuration must be a private bounded file");
	const value = configSchema.parse(JSON.parse(readFileSync(file, "utf8")));
	const origin = new URL(value.origin);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== value.origin ||
		origin.username ||
		origin.password
	)
		throw new Error("Relay origin must be an HTTPS origin");
	if (
		!value.appIds.every((app) =>
			app.startsWith(`1:${value.projectNumber}:android:`),
		) ||
		!value.clientEmail.endsWith(
			`@${value.projectId}.iam.gserviceaccount.com`,
		) ||
		createPrivateKey(value.privateKey).asymmetricKeyType !== "rsa"
	)
		throw new Error("Relay Google identity is invalid");
	const { kid, ...jwk } = value.receiptKey;
	const matching = value.receiptVerificationKeys.find((key) => key.kid === kid);
	if (
		!matching ||
		matching.x !== jwk.x ||
		matching.y !== jwk.y ||
		new Set(value.receiptVerificationKeys.map((key) => key.kid)).size !==
			value.receiptVerificationKeys.length
	)
		throw new Error("Relay receipt keyring is invalid");
	return {
		...value,
		encryption: createFieldKeyRing({
			current: value.encryptionKey,
			next: value.nextEncryptionKey,
		}),
		signer: { kid, privateKey: (await importJWK(jwk, "ES256")) as CryptoKey },
	};
}
