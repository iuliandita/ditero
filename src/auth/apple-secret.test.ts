import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { createAppleSecretSource } from "./apple-secret.ts";
import type { AppleSettings } from "./provider-env.ts";

const settings: AppleSettings = {
	clientId: "app.example.web",
	teamId: "ABCDE12345",
	keyId: "KEY1234567",
	privateKeyPath: "/keys/apple.p8",
};
const DAY = 24 * 60 * 60;
const { privateKey, publicKey } = generateKeyPairSync("ec", {
	namedCurve: "prime256v1",
});
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("Apple client secret", () => {
	it("is an ES256 JWT Apple can verify with the team, key and Services ID", async () => {
		const secret = createAppleSecretSource(
			settings,
			{ readFile: () => pem },
			() => 1_800_000_000_000,
		)();
		expect(decodeProtectedHeader(secret)).toMatchObject({
			alg: "ES256",
			kid: "KEY1234567",
		});
		const { payload } = await jwtVerify(
			secret,
			await importSPKI(
				publicKey.export({ type: "spki", format: "pem" }).toString(),
				"ES256",
			),
			{
				issuer: "ABCDE12345",
				audience: "https://appleid.apple.com",
				subject: "app.example.web",
				currentDate: new Date(1_800_000_100_000),
			},
		);
		// Apple rejects secrets valid for more than six months (15,777,000 s).
		expect(payload.exp).toBe(1_800_000_000 + 90 * DAY);
	});

	it("regenerates before expiry and picks up a rotated key file", () => {
		let now = 1_800_000_000_000;
		let content = pem;
		const next = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
			.privateKey.export({ type: "pkcs8", format: "pem" })
			.toString();
		const source = createAppleSecretSource(
			settings,
			{ readFile: () => content },
			() => now,
		);
		const first = source();
		content = next;
		now += (45 * DAY - 1) * 1000;
		expect(source()).toBe(first);
		now += 2000;
		const refreshed = source();
		expect(refreshed).not.toBe(first);
		expect(
			JSON.parse(Buffer.from(refreshed.split(".")[1], "base64url").toString())
				.iat,
		).toBe(Math.floor(now / 1000));
	});

	it.each([
		[
			"a missing file",
			() => {
				throw new Error("ENOENT");
			},
			/not a readable file/,
		],
		["a non-key file", () => "hello", /PKCS#8/],
		[
			"an RSA key",
			() =>
				generateKeyPairSync("rsa", { modulusLength: 2048 })
					.privateKey.export({ type: "pkcs8", format: "pem" })
					.toString(),
			/EC P-256/,
		],
	])("fails loudly for %s", (_label, readFile, message) => {
		expect(() => createAppleSecretSource(settings, { readFile })()).toThrow(
			message,
		);
	});
});
