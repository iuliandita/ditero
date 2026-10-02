import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
	APP_CHECK_JWKS,
	createAppCheckVerifier,
	type ProtectedFetch,
} from "../src/app-check.ts";

const projectNumber = "123456789";
const appId = `1:${projectNumber}:android:abcdef123456`;
describe("App Check identity", () => {
	it("uses only fixed bounded JWKS and validates approved project and application", async () => {
		const pair = await generateKeyPair("RS256", { extractable: true });
		const key = {
			...(await exportJWK(pair.publicKey)),
			kid: "test-key",
			alg: "RS256",
		};
		let requests = 0;
		const transport: ProtectedFetch = async (url, options) => {
			expect(url).toBe(APP_CHECK_JWKS);
			expect(options?.maxResponseBytes).toBe(16384);
			requests++;
			return Response.json({ keys: [key] });
		};
		const verify = createAppCheckVerifier(
			{ projectNumber, appIds: [appId] },
			transport,
		);
		const make = async (
			sub = appId,
			aud = `projects/${projectNumber}`,
			extra = {},
		) =>
			new SignJWT(extra)
				.setProtectedHeader({ alg: "RS256", kid: key.kid })
				.setSubject(sub)
				.setIssuer(`https://firebaseappcheck.googleapis.com/${projectNumber}`)
				.setAudience(aud)
				.setIssuedAt()
				.setExpirationTime("1h")
				.sign(pair.privateKey);
		expect(await verify(await make(), AbortSignal.timeout(1000))).toBe(appId);
		await expect(
			verify(
				await make("1:123456789:android:ffffffff"),
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow();
		await expect(
			verify(await make(appId, "projects/999"), AbortSignal.timeout(1000)),
		).rejects.toThrow();
		expect(requests).toBe(1);
	});
	it("distinguishes key-service outages from invalid token authentication", async () => {
		const pair = await generateKeyPair("RS256", { extractable: true });
		const key = { ...(await exportJWK(pair.publicKey)), kid: "test-key" };
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: key.kid })
			.setSubject(appId)
			.setIssuer(`https://firebaseappcheck.googleapis.com/${projectNumber}`)
			.setAudience(`projects/${projectNumber}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(pair.privateKey);
		const config = { projectNumber, appIds: [appId] };
		await expect(
			createAppCheckVerifier(config, async () => {
				throw new Error("network");
			})(token, AbortSignal.timeout(1000)),
		).rejects.toMatchObject({ status: 503, code: "attestation_unavailable" });
		await expect(
			createAppCheckVerifier(
				config,
				async () => new Response("outage", { status: 503 }),
			)(token, AbortSignal.timeout(1000)),
		).rejects.toMatchObject({ status: 503 });
		const valid = createAppCheckVerifier(config, async () =>
			Response.json({ keys: [key] }),
		);
		const bad = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: key.kid })
			.setSubject("unapproved")
			.setIssuer(`https://firebaseappcheck.googleapis.com/${projectNumber}`)
			.setAudience(`projects/${projectNumber}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(pair.privateKey);
		await expect(valid(bad, AbortSignal.timeout(1000))).rejects.toMatchObject({
			status: 401,
			code: "unauthorized",
		});
	});
	it("refuses embedded remote key hints and absent expiry", async () => {
		const pair = await generateKeyPair("RS256", { extractable: true });
		const key = { ...(await exportJWK(pair.publicKey)), kid: "test-key" };
		const verify = createAppCheckVerifier(
			{ projectNumber, appIds: [appId] },
			async () => Response.json({ keys: [key] }),
		);
		const make = (hint: boolean) =>
			new SignJWT({
				sub: appId,
				iss: `https://firebaseappcheck.googleapis.com/${projectNumber}`,
				aud: `projects/${projectNumber}`,
				iat: Math.floor(Date.now() / 1000),
				...(hint ? { exp: Math.floor(Date.now() / 1000) + 60 } : {}),
			})
				.setProtectedHeader({
					alg: "RS256",
					kid: key.kid,
					...(hint ? { jku: "https://untrusted.example.org/keys" } : {}),
				})
				.sign(pair.privateKey);
		await expect(
			verify(await make(true), AbortSignal.timeout(1000)),
		).rejects.toThrow();
		await expect(
			verify(await make(false), AbortSignal.timeout(1000)),
		).rejects.toThrow();
	});
});
