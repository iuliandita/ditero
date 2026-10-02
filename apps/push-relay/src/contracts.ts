import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const LIMITS = {
	body: 16384,
	deadline: 10000,
	proof: 60,
	tolerance: 5,
	offer: 300,
	retention: 604800,
	prune: 500,
} as const;
export const opaque = z
	.string()
	.regex(/^[A-Za-z0-9_-]{43}$/)
	.refine(
		(value) =>
			Buffer.from(value, "base64url").length === 32 &&
			Buffer.from(value, "base64url").toString("base64url") === value,
	);
export const publicKey = z
	.object({
		kty: z.literal("EC"),
		crv: z.literal("P-256"),
		x: opaque,
		y: opaque,
	})
	.strict();
export const fid = z.string().regex(/^[A-Za-z0-9._:-]{1,4096}$/);
const jwt = z
	.string()
	.max(8192)
	.regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const appId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const base = {
	installationId: opaque,
	targetId: opaque,
	registrationId: appId,
	operationId: opaque,
};
const auth = { deviceProof: jwt.optional(), appCheck: jwt.optional() };
const senderAuth = { senderProof: jwt.optional() };
const eitherAuth = { ...auth, ...senderAuth };
const management = { managementSecret: opaque };
export const schemas = {
	"/v1/targets/status": z
		.object({ ...base, ...senderAuth, sendCapability: opaque })
		.strict(),
	"/v1/enroll": z
		.object({
			...base,
			...auth,
			...management,
			deviceKey: publicKey,
			senderKey: publicKey,
			sendCapability: opaque,
			offerId: opaque,
			offer: jwt,
			fid,
		})
		.strict(),
	"/v1/confirm": z
		.object({
			...base,
			...auth,
			...management,
			generation: z.number().int().positive(),
			challenge: opaque,
		})
		.strict(),
	"/v1/send": z
		.object({
			...base,
			...senderAuth,
			sendCapability: opaque,
			generation: z.number().int().positive(),
			priority: z.enum(["normal", "high"]),
			data: z
				.object({
					version: z.literal("1"),
					notificationId: appId,
					registrationId: appId,
				})
				.strict(),
		})
		.strict(),
	"/v1/manage/rotate": z
		.object({
			...base,
			...auth,
			...management,
			generation: z.number().int().positive(),
			newManagementSecret: opaque,
		})
		.strict(),
	"/v1/manage/replace-fid": z
		.object({
			...base,
			...auth,
			...management,
			generation: z.number().int().positive(),
			newManagementSecret: opaque,
			fid,
		})
		.strict(),
	"/v1/manage/retire": z
		.object({
			...base,
			...eitherAuth,
			managementSecret: opaque.optional(),
			sendCapability: opaque.optional(),
			generation: z.number().int().positive(),
		})
		.strict()
		.refine(
			(value) =>
				Boolean(value.managementSecret) !== Boolean(value.sendCapability),
		),
	"/v1/operations/status": z
		.object({ ...base, ...auth, ...management, queriedOperationId: opaque })
		.strict(),
} as const;
export type Path = keyof typeof schemas;
export type Body<P extends Path = Path> = z.infer<(typeof schemas)[P]>;
export type PublicKey = z.infer<typeof publicKey>;
export type PushData = {
	version: "1";
	notificationId: string;
	registrationId: string;
};
export type Outcome = {
	kind:
		| "accepted"
		| "issued"
		| "confirmed"
		| "rotated"
		| "retired"
		| "permanent"
		| "stale"
		| "quota"
		| "retryable"
		| "target-status";
	receipt?: string;
	state?: "issued" | "confirmed" | "retired";
	generation?: number;
	credentialVersion?: number;
};
export class RelayError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}
export function id(): string {
	return randomBytes(32).toString("base64url");
}
export function credentialHash(
	kind: "management" | "send",
	value: string,
): string {
	return createHash("sha256")
		.update(`ditero:push-relay:v1:${kind}:`)
		.update(value)
		.digest("base64url");
}
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function semanticDigest(body: Body): string {
	const {
		deviceProof: _device,
		senderProof: _sender,
		appCheck: _app,
		...semantic
	} = body as Body & {
		deviceProof?: string;
		senderProof?: string;
		appCheck?: string;
	};
	return createHash("sha256").update(canonical(semantic)).digest("base64url");
}
