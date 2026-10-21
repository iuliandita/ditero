import { createPrivateKey, sign } from "node:crypto";
import {
	type AppleSettings,
	ProviderConfigError,
	type ProviderIO,
	readApplePrivateKey,
} from "./provider-env.ts";

// Apple rejects client secrets that live longer than six months. A fresh one
// is minted well before the previous one could expire, so a key file that is
// replaced (rotated) is also picked up without a restart.
export const APPLE_SECRET_TTL_SECONDS = 90 * 24 * 60 * 60;
export const APPLE_SECRET_REFRESH_SECONDS = 45 * 24 * 60 * 60;

const base64url = (input: Buffer | string) =>
	Buffer.from(input).toString("base64url");

export function createAppleSecretSource(
	settings: AppleSettings,
	io: ProviderIO,
	now: () => number = () => Date.now(),
): () => string {
	let cached: { secret: string; issuedAt: number } | undefined;
	const mint = (issuedAt: number): string => {
		const key = createPrivateKey(
			readApplePrivateKey(settings.privateKeyPath, io),
		);
		if (
			key.asymmetricKeyType !== "ec" ||
			key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
		)
			throw new ProviderConfigError(
				"APPLE_PRIVATE_KEY_FILE: expected an EC P-256 key",
			);
		const header = base64url(
			JSON.stringify({ alg: "ES256", kid: settings.keyId, typ: "JWT" }),
		);
		const payload = base64url(
			JSON.stringify({
				iss: settings.teamId,
				iat: issuedAt,
				exp: issuedAt + APPLE_SECRET_TTL_SECONDS,
				aud: "https://appleid.apple.com",
				sub: settings.clientId,
			}),
		);
		const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
			key,
			dsaEncoding: "ieee-p1363",
		});
		return `${header}.${payload}.${base64url(signature)}`;
	};
	return () => {
		const seconds = Math.floor(now() / 1000);
		if (!cached || seconds - cached.issuedAt >= APPLE_SECRET_REFRESH_SECONDS)
			cached = { secret: mint(seconds), issuedAt: seconds };
		return cached.secret;
	};
}
