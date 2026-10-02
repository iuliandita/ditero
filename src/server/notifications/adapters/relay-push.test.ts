import { exportJWK, generateKeyPair } from "jose";
import { beforeAll, expect, test } from "vitest";
import {
	receipt,
	thumbprint,
	verifyProof,
} from "../../../../apps/push-relay/src/proof.ts";
import type { safeFetch } from "../../../security/safe-http.ts";
import type { RelayConfiguration } from "../../native-push/relay-configuration.ts";
import {
	type Body,
	credentialHash,
	id,
	type PublicKey,
	type RelayRegistration,
	relayRegistration,
	semanticDigest,
} from "../../native-push/relay-contracts.ts";
import { createRelayPushSender } from "./relay-push.ts";

let config: RelayRegistration,
	trust: RelayConfiguration,
	signer: { kid: string; privateKey: CryptoKey };
const data = {
	version: "1" as const,
	notificationId: "ef6d74a4-c983-4759-977b-59051d242bef",
	registrationId: "7a62a7bf-d9c5-4e65-ab65-7b2c9e045ab3",
};
beforeAll(async () => {
	const sender = await generateKeyPair("ES256", { extractable: true }),
		service = await generateKeyPair("ES256", { extractable: true }),
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
		registrationId: data.registrationId,
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
function context(fetch: typeof safeFetch) {
	return {
		signal: AbortSignal.timeout(10000),
		deadlineMs: 10000,
		allowedPrivateCIDRs: [],
		fetch,
	};
}
test("signed accepted replay binds request, scoped authority and original opaque payload", async () => {
	const bodies: Body<"/v1/send">[] = [];
	const fetch: typeof safeFetch = async (url, options = {}) => {
		expect(url).toBe(`${trust.origin}/v1/send`);
		expect(options.maxResponseBytes).toBe(16384);
		expect(options.headersTimeoutMs).toBe(10000);
		const body = JSON.parse(String(options.body)) as Body<"/v1/send">;
		bodies.push(body);
		await verifyProof(
			body.senderProof,
			config.senderKey,
			trust.origin,
			"/v1/send",
			body.operationId,
			semanticDigest(body),
		);
		return Response.json({
			kind: "accepted",
			receipt: await receipt(
				signer,
				{
					kind: "accepted",
					operationId: body.operationId,
					digest: semanticDigest(body),
					targetId: config.targetId,
					installationId: config.installationId,
					registrationId: config.registrationId,
					generation: 1,
					senderThumbprint: config.senderThumbprint,
					deviceThumbprint: config.deviceThumbprint,
					sendCapabilityHash: config.sendCapabilityHash,
				},
				trust.origin,
			),
		});
	};
	const send = createRelayPushSender(trust);
	expect((await send(config, data, context(fetch))).result.ok).toBe(true);
	expect((await send(config, data, context(fetch))).result.ok).toBe(true);
	expect(bodies[0].operationId).toBe(bodies[1].operationId);
	expect(bodies[0].senderProof).not.toBe(bodies[1].senderProof);
	expect(bodies[0].data).toEqual(data);
});
test("unsigned acceptance and wrong request receipt remain uncertain", async () => {
	const send = createRelayPushSender(trust);
	for (const response of [
		{ kind: "accepted" },
		{
			kind: "accepted",
			receipt: await receipt(
				signer,
				{ kind: "accepted", operationId: id() },
				trust.origin,
			),
		},
	]) {
		const result = await send(
			config,
			data,
			context(async () => Response.json(response)),
		);
		expect(result.result.ok).toBe(false);
		expect(result.expired).toBe(false);
	}
});
test("stale generations await update, quota retries, permanent refusals stop", async () => {
	for (const [kind, status, permanent] of [
		["stale", 409, false],
		["quota", 429, false],
		["permanent", 422, true],
	] as const) {
		const result = await createRelayPushSender(trust)(
			config,
			data,
			context(async () => Response.json({ kind }, { status })),
		);
		expect(result.result.ok).toBe(false);
		expect(result.expired).toBe(false);
		expect(Boolean(!result.result.ok && result.result.policyRejected)).toBe(
			permanent,
		);
	}
});
test("unconfigured or changed operator relay origin cannot issue HTTP", async () => {
	let calls = 0;
	const fetch: typeof safeFetch = async () => {
		calls++;
		return Response.json({ kind: "accepted" });
	};
	expect(
		(await createRelayPushSender(undefined)(config, data, context(fetch)))
			.result.ok,
	).toBe(false);
	expect(
		(
			await createRelayPushSender({
				...trust,
				origin: "https://other.example.org",
			})(config, data, context(fetch))
		).result.ok,
	).toBe(false);
	expect(calls).toBe(0);
});
test("oversized response and transport failure remain explicit at-least-once uncertainty", async () => {
	for (const fetch of [
		async () => new Response("x".repeat(16385)),
		async () => {
			throw new Error("network");
		},
	] as (typeof safeFetch)[]) {
		const outcome = await createRelayPushSender(trust)(
			config,
			data,
			context(fetch),
		);
		expect(outcome.result.ok).toBe(false);
		expect(outcome.expired).toBe(false);
		if (!outcome.result.ok)
			expect(outcome.result.error).toContain("retry may duplicate");
	}
});
