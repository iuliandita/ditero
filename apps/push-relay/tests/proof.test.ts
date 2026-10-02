import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { credentialHash, id, publicKey } from "../src/contracts.ts";
import {
	OFFER_TYPE,
	PROOF_TYPE,
	thumbprint,
	verifyOffer,
	verifyProof,
} from "../src/proof.ts";

const origin = "https://relay.example.org";
describe("relay cryptographic bindings", () => {
	it("binds method, path, operation, digest, audience and key", async () => {
		const pair = await generateKeyPair("ES256", { extractable: true });
		const key = publicKey.parse(await exportJWK(pair.publicKey));
		const operation = id();
		const digest = id();
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({
			aud: origin,
			iat: now,
			exp: now + 60,
			method: "POST",
			path: "/v1/send",
			operationId: operation,
			digest,
			nonce: id(),
		})
			.setProtectedHeader({
				alg: "ES256",
				typ: PROOF_TYPE,
				kid: await thumbprint(key),
			})
			.sign(pair.privateKey);
		expect(
			(await verifyProof(token, key, origin, "/v1/send", operation, digest))
				.key,
		).toBe(await thumbprint(key));
		for (const [path, op, hash] of [
			["/v1/confirm", operation, digest],
			["/v1/send", id(), digest],
			["/v1/send", operation, id()],
		])
			await expect(
				verifyProof(token, key, origin, path, op, hash),
			).rejects.toThrow("unauthorized");
		await expect(
			verifyProof(
				token,
				key,
				"https://other.example.org",
				"/v1/send",
				operation,
				digest,
			),
		).rejects.toThrow();
	});
	it("rejects private proof keys, embedded trust and overlong lifetimes", async () => {
		const pair = await generateKeyPair("ES256", { extractable: true });
		const key = publicKey.parse(await exportJWK(pair.publicKey));
		expect(publicKey.safeParse(await exportJWK(pair.privateKey)).success).toBe(
			false,
		);
		const now = Math.floor(Date.now() / 1000);
		const operation = id();
		const digest = id();
		const payload = {
			aud: origin,
			iat: now,
			exp: now + 61,
			method: "POST",
			path: "/v1/send",
			operationId: operation,
			digest,
			nonce: id(),
		};
		const token = await new SignJWT(payload)
			.setProtectedHeader({
				alg: "ES256",
				typ: PROOF_TYPE,
				kid: await thumbprint(key),
			})
			.sign(pair.privateKey);
		await expect(
			verifyProof(token, key, origin, "/v1/send", operation, digest),
		).rejects.toThrow();
		const embedded = await new SignJWT({ ...payload, exp: now + 60 })
			.setProtectedHeader({
				alg: "ES256",
				typ: PROOF_TYPE,
				kid: await thumbprint(key),
				jwk: key,
			})
			.sign(pair.privateKey);
		await expect(
			verifyProof(embedded, key, origin, "/v1/send", operation, digest),
		).rejects.toThrow();
	});
	it("verifies sender possession and all offer bindings", async () => {
		const pair = await generateKeyPair("ES256", { extractable: true });
		const key = publicKey.parse(await exportJWK(pair.publicKey));
		const now = Math.floor(Date.now() / 1000);
		const expected = {
			origin,
			installationId: id(),
			offerId: id(),
			targetId: id(),
			registrationId: id(),
			deviceThumbprint: id(),
			sendCapabilityHash: credentialHash("send", id()),
		};
		const { origin: _origin, ...bindings } = expected;
		const token = await new SignJWT({
			...bindings,
			aud: origin,
			iat: now,
			exp: now + 300,
			senderKey: key,
		})
			.setProtectedHeader({
				alg: "ES256",
				typ: OFFER_TYPE,
				kid: await thumbprint(key),
			})
			.sign(pair.privateKey);
		expect(await verifyOffer(token, key, expected)).toBe(now + 300);
		await expect(
			verifyOffer(token, key, { ...expected, registrationId: id() }),
		).rejects.toThrow();
	});
});
