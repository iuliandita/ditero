import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { createFirstPartyJWKSet } from "./zero-jwks.ts";

const issuer = "http://127.0.0.1:1";
const audience = `${issuer}/api/zero`;
const endpoint = `${issuer}/api/auth/jwks`;

async function signingKey(kid: string) {
	const pair = await generateKeyPair("EdDSA");
	return {
		privateKey: pair.privateKey,
		jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: "EdDSA" },
	};
}

async function token(key: Awaited<ReturnType<typeof signingKey>>) {
	return new SignJWT({ sid: "session-A", authKind: "browser" })
		.setProtectedHeader({ alg: "EdDSA", kid: key.jwk.kid })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject("user-A")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(key.privateKey);
}

function verify(
	value: string,
	keys: ReturnType<typeof createFirstPartyJWKSet>,
) {
	return jwtVerify(value, keys, { issuer, audience, algorithms: ["EdDSA"] });
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("verifies through the first-party handler without fetching the unreachable public origin", async () => {
	const key = await signingKey("first");
	const network = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Public origin is unreachable"));
	const handler = vi.fn(async (request: Request) => {
		expect(request.url).toBe(endpoint);
		expect(request.method).toBe("GET");
		return Response.json({ keys: [key.jwk] });
	});
	const keys = createFirstPartyJWKSet(new URL(endpoint), handler);
	const signed = await token(key);
	expect((await verify(signed, keys)).payload.sub).toBe("user-A");
	expect((await verify(signed, keys)).payload.sub).toBe("user-A");
	expect(handler).toHaveBeenCalledTimes(1);
	expect(network).not.toHaveBeenCalled();
});

it("still rejects an invalid signature with the accepted key id", async () => {
	const trusted = await signingKey("first");
	const forged = await signingKey("first");
	const keys = createFirstPartyJWKSet(new URL(endpoint), async () =>
		Response.json({ keys: [trusted.jwk] }),
	);
	await expect(verify(await token(forged), keys)).rejects.toMatchObject({
		code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
	});
});

it("refreshes a rotated signing key through the same handler after the default cooldown", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const first = await signingKey("first");
	const second = await signingKey("second");
	let published = [first.jwk];
	const handler = vi.fn(async () => Response.json({ keys: published }));
	const keys = createFirstPartyJWKSet(new URL(endpoint), handler);
	await verify(await token(first), keys);
	published = [first.jwk, second.jwk];
	vi.setSystemTime(Date.now() + 31_000);
	expect((await verify(await token(second), keys)).payload.sub).toBe("user-A");
	expect(handler).toHaveBeenCalledTimes(2);
});
