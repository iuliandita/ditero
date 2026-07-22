// Inbound signature verification for the provider listeners. Pure: no I/O, no
// env, no clock -- `now` is injected so the replay windows are testable.
//
// rawBody is bytes, never a string: Discord and Slack sign the exact octets they
// sent, and a caller holding a parsed object (or a re-serialized string) would
// verify against bytes the provider never signed.
import {
	createHash,
	createHmac,
	createPublicKey,
	timingSafeEqual,
	verify,
} from "node:crypto";

// Slack's documented replay window.
export const SLACK_MAX_SKEW_MS = 300_000;

// Discord documents no window, but its signature covers the timestamp, so the
// check costs nothing and there is no reason for the two listeners to differ.
export const DISCORD_MAX_SKEW_MS = SLACK_MAX_SKEW_MS;

// SPKI prefix for a raw 32-byte Ed25519 public key; node:crypto has no raw
// import for this curve.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// timingSafeEqual throws on a length mismatch, and returning early on length
// would itself be a (fast, observable) oracle. Comparing fixed-width digests
// instead keeps every path the same shape whatever the inputs are.
export function constantTimeEquals(a: string, b: string): boolean {
	const left = createHash("sha256").update(a, "utf8").digest();
	const right = createHash("sha256").update(b, "utf8").digest();
	return timingSafeEqual(left, right);
}

function fromHex(value: string, byteLength: number): Buffer | null {
	if (value.length !== byteLength * 2 || !/^[0-9a-fA-F]+$/.test(value)) {
		return null;
	}
	return Buffer.from(value, "hex");
}

export function verifyDiscordSignature(
	publicKey: string,
	signature: string,
	timestamp: string,
	rawBody: Uint8Array,
	now: number,
): boolean {
	try {
		if (!publicKey || !signature || !/^\d{1,15}$/.test(timestamp)) return false;
		if (!Number.isFinite(now)) return false;
		// Both directions: a future timestamp is as much a replay signal as a stale one.
		if (Math.abs(now - Number(timestamp) * 1000) > DISCORD_MAX_SKEW_MS) {
			return false;
		}
		const keyBytes = fromHex(publicKey, 32);
		const signatureBytes = fromHex(signature, 64);
		if (!keyBytes || !signatureBytes) return false;

		const key = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]),
			format: "der",
			type: "spki",
		});
		const message = Buffer.concat([
			Buffer.from(timestamp, "utf8"),
			Buffer.from(rawBody),
		]);
		return verify(null, message, key, signatureBytes);
	} catch {
		return false;
	}
}

export function verifySlackSignature(
	secret: string,
	signature: string,
	timestamp: string,
	rawBody: Uint8Array,
	now: number,
): boolean {
	try {
		if (!secret || !signature || !/^\d{1,15}$/.test(timestamp)) return false;
		if (!Number.isFinite(now)) return false;
		// Both directions: a future timestamp is as much a replay signal as a stale one.
		if (Math.abs(now - Number(timestamp) * 1000) > SLACK_MAX_SKEW_MS) {
			return false;
		}

		const base = Buffer.concat([
			Buffer.from(`v0:${timestamp}:`, "utf8"),
			Buffer.from(rawBody),
		]);
		const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
		return constantTimeEquals(expected, signature);
	} catch {
		return false;
	}
}

export function verifyTelegramSecret(
	expected: string,
	header: string,
): boolean {
	try {
		if (!expected || !header) return false;
		return constantTimeEquals(expected, header);
	} catch {
		return false;
	}
}
