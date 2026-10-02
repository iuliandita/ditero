import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { expect, test } from "vitest";
import { receipt } from "../../../apps/push-relay/src/proof.ts";
import { relayConfiguration } from "./relay-configuration.ts";
import {
	type Body,
	id,
	type PublicKey,
	schemas,
	semanticDigest,
} from "./relay-contracts.ts";
import { operationId, trustedReceipt } from "./relay-proof.ts";

test("no partial or insecure relay configuration and no discovery by default", async () => {
	expect(relayConfiguration({})).toBeUndefined();
	expect(() =>
		relayConfiguration({
			DITERO_NATIVE_PUSH_RELAY_ORIGIN: "https://relay.example.org",
		}),
	).toThrow();
	const directory = mkdtempSync(join(tmpdir(), "relay-config-")),
		file = join(directory, "keys.json");
	try {
		const keys = await generateKeyPair("ES256", { extractable: true });
		writeFileSync(
			file,
			JSON.stringify({ fixture: await exportJWK(keys.publicKey) }),
			{ mode: 0o600 },
		);
		const env = {
			DITERO_NATIVE_PUSH_RELAY_ORIGIN: "https://relay.example.org",
			DITERO_NATIVE_PUSH_RELAY_RECEIPT_KEYS_FILE: file,
		};
		expect(relayConfiguration(env)?.origin).toBe(
			env.DITERO_NATIVE_PUSH_RELAY_ORIGIN,
		);
		for (const origin of [
			"http://relay.example.org",
			"https://relay.example.org/path",
			"https://user@relay.example.org",
			"https://relay.example.org/",
		])
			expect(() =>
				relayConfiguration({ ...env, DITERO_NATIVE_PUSH_RELAY_ORIGIN: origin }),
			).toThrow();
	} finally {
		rmSync(directory, { recursive: true });
	}
});
test("canonical operation identity binds generation and keeps original UUID payload", () => {
	const notification = "ccf04645-9d2d-4b73-bba1-2d4d8da477aa",
		target = id();
	expect(operationId(target, 1, notification)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(operationId(target, 1, notification)).not.toBe(
		operationId(target, 2, notification),
	);
	const body: Body<"/v1/send"> = {
		installationId: id(),
		targetId: target,
		registrationId: notification,
		operationId: id(),
		sendCapability: id(),
		generation: 1,
		priority: "normal",
		data: {
			version: "1",
			registrationId: notification,
			notificationId: notification,
		},
	};
	expect(schemas["/v1/send"].safeParse(body).success).toBe(true);
	expect(semanticDigest(body)).toBe(
		semanticDigest({ ...body, senderProof: "refreshed" }),
	);
	expect(semanticDigest(body)).not.toBe(
		semanticDigest({ ...body, generation: 2 }),
	);
	expect(
		schemas["/v1/send"].safeParse({
			...body,
			data: { ...body.data, title: "private" },
		}).success,
	).toBe(false);
});
test("receipt trusts only pinned key, exact issuer and audience", async () => {
	const key = await generateKeyPair("ES256", { extractable: true }),
		other = await generateKeyPair("ES256", { extractable: true });
	const trust = {
		origin: "https://relay.example.org",
		receiptKeys: { fixture: (await exportJWK(key.publicKey)) as PublicKey },
	};
	const bindings = { nonce: randomBytes(32).toString("base64url") };
	const token = await receipt(
		{ kid: "fixture", privateKey: key.privateKey },
		bindings,
		trust.origin,
	);
	expect(await trustedReceipt(token, trust)).toMatchObject(bindings);
	await expect(
		trustedReceipt(
			await receipt(
				{ kid: "untrusted", privateKey: key.privateKey },
				bindings,
				trust.origin,
			),
			trust,
		),
	).rejects.toThrow();
	await expect(
		trustedReceipt(
			await receipt(
				{ kid: "fixture", privateKey: other.privateKey },
				bindings,
				trust.origin,
			),
			trust,
		),
	).rejects.toThrow();
	await expect(
		trustedReceipt(token, { ...trust, origin: "https://other.example.org" }),
	).rejects.toThrow();
});
