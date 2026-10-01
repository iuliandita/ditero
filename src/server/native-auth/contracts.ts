// Wire contracts for the native sign-in handoff: strict request shapes, the
// PKCE (RFC 7636, S256 only) primitives, and the streamed body bound.
import { createHash } from "node:crypto";

export const GRANT_TTL_MINUTES = 5;
export const BODY_LIMIT_BYTES = 4096;
export const LABEL_MAX = 100;

export type SessionHandle = {
	id: string;
	token: string;
	userId: string;
	expiresAt: Date;
};

// Injected so the store never imports the auth instance.
export type Sessions = {
	createSession(userId: string): Promise<SessionHandle>;
	deleteSession(token: string): Promise<void>;
};

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9\-._~+/=]{1,512})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

// Exactly 32 bytes, in the one canonical unpadded encoding.
export function isCanonicalId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		BASE64URL_32.test(value) &&
		Buffer.from(value, "base64url").toString("base64url") === value
	);
}

export function isVerifier(value: unknown): value is string {
	return typeof value === "string" && VERIFIER.test(value);
}

export function s256Challenge(verifier: string): string {
	return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function normalizeLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const label = value.trim();
	if (label.length < 1 || label.length > LABEL_MAX || CONTROL.test(label))
		return null;
	return label;
}

function exactKeys(
	body: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const present = Object.keys(body);
	return (
		present.length === keys.length &&
		keys.every((key) => Object.hasOwn(body, key))
	);
}

export type CreateInput = { challenge: string; deviceLabel: string };
export type ApproveInput = { grantId: string };
export type ExchangeInput = { grantId: string; verifier: string };

export function parseCreate(body: Record<string, unknown>): CreateInput | null {
	if (!exactKeys(body, ["challenge", "deviceLabel"])) return null;
	const deviceLabel = normalizeLabel(body.deviceLabel);
	if (!isCanonicalId(body.challenge) || deviceLabel === null) return null;
	return { challenge: body.challenge, deviceLabel };
}

export function parseApprove(
	body: Record<string, unknown>,
): ApproveInput | null {
	if (!exactKeys(body, ["grantId"]) || !isCanonicalId(body.grantId))
		return null;
	return { grantId: body.grantId };
}

export function parseExchange(
	body: Record<string, unknown>,
): ExchangeInput | null {
	if (!exactKeys(body, ["grantId", "verifier"])) return null;
	if (!isCanonicalId(body.grantId) || !isVerifier(body.verifier)) return null;
	return { grantId: body.grantId, verifier: body.verifier };
}

// Cookie, Origin and Authorization mark a browser or an already-authenticated
// caller; the unauthenticated native endpoints refuse all three.
export function hasAmbientCredentials(headers: Headers): boolean {
	return (
		headers.has("origin") ||
		headers.has("cookie") ||
		headers.has("authorization")
	);
}

export function parseBearer(headers: Headers): string | null {
	const match = BEARER.exec(headers.get("authorization") ?? "");
	return match ? match[1] : null;
}

export type BodyResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; status: 400 | 413 | 415 };

// Streams with a running count, so an oversized or unbounded body is cut off
// instead of buffered.
export async function readJsonObject(
	request: Request,
	limit: number = BODY_LIMIT_BYTES,
): Promise<BodyResult> {
	const type = request.headers.get("content-type") ?? "";
	if (type.split(";")[0].trim().toLowerCase() !== "application/json")
		return { ok: false, status: 415 };
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		if (!/^\d+$/.test(declared)) return { ok: false, status: 400 };
		if (Number(declared) > limit) return { ok: false, status: 413 };
	}
	const chunks: Uint8Array[] = [];
	let total = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				await reader.cancel().catch(() => {});
				return { ok: false, status: 413 };
			}
			chunks.push(value);
		}
	}
	const bytes = Buffer.concat(chunks);
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		);
	} catch {
		return { ok: false, status: 400 };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return { ok: false, status: 400 };
	return { ok: true, value: parsed as Record<string, unknown> };
}
