import { exportJWK, generateKeyPair } from "jose";
import type { Pool } from "pg";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { receipt, thumbprint } from "../../../apps/push-relay/src/proof.ts";
import { createFieldKeyRing } from "../../security/field-encryption.ts";
import type { NativeSession } from "../native-auth/session.ts";
import * as nativeAuth from "../native-auth/session.ts";
import type { RelayConfiguration } from "./relay-configuration.ts";
import {
	credentialHash,
	id,
	type PublicKey,
	RelayInstanceError,
	type RelayRegistration,
	relayRegistration,
} from "./relay-contracts.ts";
import { trustedReceipt, verifyRegistrationReceipt } from "./relay-proof.ts";
import { nativeRelayRoutes } from "./relay-routes.ts";
import { NativeRelayStore } from "./relay-store.ts";

const owner = {
	userId: "owner",
	sessionId: "native",
	deviceId: "device",
} as NativeSession;
let trust: RelayConfiguration,
	config: RelayRegistration,
	signer: { kid: string; privateKey: CryptoKey };
beforeAll(async () => {
	const service = await generateKeyPair("ES256", { extractable: true }),
		sender = await generateKeyPair("ES256", { extractable: true }),
		senderKey = (await exportJWK(sender.publicKey)) as PublicKey,
		sendCapability = id();
	signer = { kid: "fixture", privateKey: service.privateKey };
	trust = {
		origin: "https://relay.example.org",
		receiptKeys: { fixture: (await exportJWK(service.publicKey)) as PublicKey },
	};
	config = relayRegistration.parse({
		provider: "fcm-relay",
		relayOrigin: trust.origin,
		installationId: id(),
		targetId: id(),
		registrationId: "application-registration",
		offerId: id(),
		offerExpires: Math.floor(Date.now() / 1000) + 300,
		senderKey,
		senderPrivateKey: await exportJWK(sender.privateKey),
		senderThumbprint: await thumbprint(senderKey),
		deviceThumbprint: id(),
		sendCapability,
		sendCapabilityHash: credentialHash("send", sendCapability),
		generation: 1,
		credentialVersion: 1,
		fidHash: id(),
	});
});
afterEach(() => vi.restoreAllMocks());
function setup(authenticated = true) {
	const query = vi
		.fn()
		.mockRejectedValue(new Error("private database failure detail"));
	const pool = { query } as unknown as Pool;
	const routes = nativeRelayRoutes({
		pool,
		ring: createFieldKeyRing({
			current: Buffer.alloc(32, 7).toString("base64"),
		}),
		configuration: { "fcm-relay": trust },
		rateLimit: async () => true,
	});
	if (authenticated)
		vi.spyOn(nativeAuth, "authenticateNative").mockResolvedValue(owner);
	return { routes, query };
}
function request(body: unknown) {
	return new Request("http://localhost/api/native/push/relay/activate", {
		method: "POST",
		headers: {
			authorization: "Bearer fixture",
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}
async function checked(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.has("set-cookie")).toBe(false);
	expect(await response.json()).toEqual({ code });
}
test("an actual injected authentication database failure logs only sanitized text and returns500", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {}),
		{ routes, query } = setup(false);
	await checked(
		await routes.handle(
			request({ offerId: config.offerId, receipt: "unused" }),
		),
		500,
		"native-push-failed",
	);
	expect(query).toHaveBeenCalled();
	expect(log).toHaveBeenCalledExactlyOnceWith("native relay request failed");
});
test("unexpected registration storage/encryption failures stay server errors", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {}),
		{ routes } = setup();
	vi.spyOn(NativeRelayStore.prototype, "activate").mockRejectedValue(
		new Error("private ciphertext/key details"),
	);
	await checked(
		await routes.handle(
			request({ offerId: config.offerId, receipt: "unused" }),
		),
		500,
		"native-push-failed",
	);
	expect(log).toHaveBeenCalledExactlyOnceWith("native relay request failed");
});
test("malformed body is400 and known stale offer is409 without server error logging", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {}),
		{ routes } = setup(),
		activate = vi
			.spyOn(NativeRelayStore.prototype, "activate")
			.mockRejectedValue(new RelayInstanceError("offer-unavailable"));
	await checked(
		await routes.handle(request({ offerId: "invalid", receipt: "unused" })),
		400,
		"invalid-body",
	);
	expect(activate).not.toHaveBeenCalled();
	await checked(
		await routes.handle(
			request({ offerId: config.offerId, receipt: "unused" }),
		),
		409,
		"offer-unavailable",
	);
	expect(log).not.toHaveBeenCalled();
});
test("actual receipt codec and signed binding failures are typed400 without operational error logging", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {}),
		{ routes } = setup();
	const invalid = await receipt(
		signer,
		{
			...config,
			senderPrivateKey: undefined,
			sendCapability: undefined,
			provider: undefined,
			iss: undefined,
			aud: undefined,
			iat: undefined,
			deviceThumbprint: id(),
		},
		trust.origin,
	);
	const tokens = [
		"invalid-jwt",
		await receipt({ ...signer, kid: "untrusted" }, {}, trust.origin),
		invalid,
	];
	for (const token of tokens) {
		vi.spyOn(NativeRelayStore.prototype, "activate").mockImplementation(
			async () => {
				await verifyRegistrationReceipt(token, trust, config);
				return { registrationId: config.registrationId, provider: "fcm-relay" };
			},
		);
		await checked(
			await routes.handle(request({ offerId: config.offerId, receipt: token })),
			400,
			"invalid-receipt",
		);
	}
	await expect(trustedReceipt("invalid-jwt", trust)).rejects.toMatchObject({
		status: 400,
		code: "invalid-receipt",
	});
	expect(log).not.toHaveBeenCalled();
});

test("inherited receipt key names are refused as typed client errors", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {}),
		{ routes } = setup();
	for (const kid of ["toString", "constructor", "__proto__"]) {
		const token = await receipt({ ...signer, kid }, {}, trust.origin);
		vi.spyOn(NativeRelayStore.prototype, "activate").mockImplementation(
			async () => {
				await trustedReceipt(token, trust);
				return { registrationId: config.registrationId, provider: "fcm-relay" };
			},
		);
		await checked(
			await routes.handle(request({ offerId: config.offerId, receipt: token })),
			400,
			"invalid-receipt",
		);
	}
	expect(log).not.toHaveBeenCalled();
});
