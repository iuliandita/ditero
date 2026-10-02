import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFieldKeyRing } from "../../../src/security/field-encryption.ts";
import type { Configuration } from "../src/configuration.ts";
import {
	type Body,
	credentialHash,
	id,
	type Outcome,
	type Path,
	type PushData,
	publicKey,
	semanticDigest,
} from "../src/contracts.ts";
import { OFFER_TYPE, PROOF_TYPE, thumbprint } from "../src/proof.ts";
import { prune } from "../src/prune.ts";
import { createRoutes } from "../src/routes.ts";
import { Store } from "../src/store.ts";

const origin = "https://relay.example.org";
const appCheck = "e30.e30.AA";
const runtimeUrl = process.env.RELAY_TEST_DATABASE_URL;
const adminUrl = process.env.RELAY_TEST_ADMIN_DATABASE_URL;
describe.skipIf(!runtimeUrl || !adminUrl)(
	"isolated relay PostgreSQL and mounted HTTP",
	() => {
		let store: Store;
		let admin: Pool;
		let server: Server;
		let serverOrigin: string;
		let config: Configuration;
		let device: Awaited<ReturnType<typeof generateKeyPair>>;
		let sender: Awaited<ReturnType<typeof generateKeyPair>>;
		let installationId: string;
		let targetId: string;
		let registrationId: string;
		let secret: string;
		let capability: string;
		let offerId: string;
		let sent: { fid: string; data: PushData; priority: string }[];
		let providerOutcome: Outcome;
		let providerPause: Promise<void> | undefined;
		beforeAll(async () => {
			store = new Store(runtimeUrl as string);
			admin = new Pool({ connectionString: adminUrl, max: 1 });
			await store.assertRuntimeAuthority();
			const signing = await generateKeyPair("ES256", { extractable: true });
			const key = publicKey.parse(await exportJWK(signing.publicKey));
			config = {
				origin,
				projectNumber: "123456789",
				projectId: "relay-fixture",
				appIds: ["1:123456789:android:abcdef"],
				clientEmail: "fixture@relay-fixture.iam.gserviceaccount.com",
				privateKey: "unused",
				encryption: createFieldKeyRing({
					current: Buffer.alloc(32, 9).toString("base64"),
				}),
				signer: { kid: "receipt-key", privateKey: signing.privateKey },
				receiptVerificationKeys: [{ ...key, kid: "receipt-key" }],
			};
			const routes = createRoutes({
				store,
				configuration: config,
				appCheck: async (token) => {
					if (token !== appCheck) throw new Error("attestation");
					return config.appIds[0];
				},
				send: async (fid, data, priority) => {
					sent.push({ fid, data, priority });
					if (providerPause) await providerPause;
					return providerOutcome;
				},
			});
			server = createServer(async (incoming, outgoing) => {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				const request = new Request(`${serverOrigin}${incoming.url}`, {
					method: incoming.method,
					headers: incoming.headers as Record<string, string>,
					body: Buffer.concat(chunks),
				});
				const response = await routes(
					request,
					incoming.socket.remoteAddress ?? "unknown",
				);
				outgoing.writeHead(
					response.status,
					Object.fromEntries(response.headers.entries()),
				);
				outgoing.end(await response.text());
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("fixture address");
			serverOrigin = `http://127.0.0.1:${address.port}`;
		});
		afterAll(async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await store.close();
			await admin.end();
		});
		beforeEach(async () => {
			await admin.query(
				"TRUNCATE relay_nonce,relay_quota,relay_operation,relay_target,relay_installation",
			);
			device = await generateKeyPair("ES256", { extractable: true });
			sender = await generateKeyPair("ES256", { extractable: true });
			installationId = id();
			targetId = id();
			registrationId = crypto.randomUUID();
			secret = id();
			capability = id();
			offerId = id();
			sent = [];
			providerOutcome = { kind: "accepted" };
			providerPause = undefined;
		});
		async function proof(
			pair: typeof device,
			path: Path,
			body: Body,
			nonce = id(),
		): Promise<string> {
			const now = Math.floor(Date.now() / 1000);
			const key = publicKey.parse(await exportJWK(pair.publicKey));
			return new SignJWT({
				aud: origin,
				iat: now,
				exp: now + 60,
				method: "POST",
				path,
				operationId: body.operationId,
				digest: semanticDigest(body),
				nonce,
			})
				.setProtectedHeader({
					alg: "ES256",
					typ: PROOF_TYPE,
					kid: await thumbprint(key),
				})
				.sign(pair.privateKey);
		}
		async function request(
			path: Path,
			body: Body,
			who: "device" | "sender" | "both" = "device",
		) {
			const wrapped: Body & {
				deviceProof?: string;
				senderProof?: string;
				appCheck?: string;
			} = { ...body, ...(who !== "sender" ? { appCheck } : {}) };
			if (who !== "sender")
				wrapped.deviceProof = await proof(device, path, body);
			if (who !== "device")
				wrapped.senderProof = await proof(sender, path, body);
			const response = await fetch(`${serverOrigin}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(wrapped),
			});
			return {
				status: response.status,
				body: (await response.json()) as Outcome & { error?: string },
			};
		}
		const common = () => ({
			installationId,
			targetId,
			registrationId,
			operationId: id(),
		});
		async function enrollment() {
			const senderKey = publicKey.parse(await exportJWK(sender.publicKey));
			const deviceKey = publicKey.parse(await exportJWK(device.publicKey));
			const now = Math.floor(Date.now() / 1000);
			const offer = await new SignJWT({
				aud: origin,
				iat: now,
				exp: now + 300,
				installationId,
				offerId,
				targetId,
				registrationId,
				senderKey,
				deviceThumbprint: await thumbprint(deviceKey),
				sendCapabilityHash: credentialHash("send", capability),
			})
				.setProtectedHeader({
					alg: "ES256",
					typ: OFFER_TYPE,
					kid: await thumbprint(senderKey),
				})
				.sign(sender.privateKey);
			const body: Body<"/v1/enroll"> = {
				...common(),
				managementSecret: secret,
				deviceKey,
				senderKey,
				sendCapability: capability,
				offerId,
				offer,
				fid: "original-fid",
			};
			return { body, result: await request("/v1/enroll", body) };
		}
		async function confirmed() {
			const enrolled = await enrollment();
			expect(enrolled.result.status).toBe(200);
			const challenge = sent[0].data.notificationId;
			const confirmedBody: Body<"/v1/confirm"> = {
				...common(),
				managementSecret: secret,
				generation: 1,
				challenge,
			};
			const result = await request("/v1/confirm", confirmedBody);
			expect(result.status).toBe(200);
			expect(result.body.kind).toBe("confirmed");
			return { enrolled, confirmedBody, result };
		}
		it("rejects administrative/schema authority and prevents runtime migrations", async () => {
			const unsafe = new Store(adminUrl as string);
			try {
				await expect(unsafe.assertRuntimeAuthority()).rejects.toThrow(
					"excessive",
				);
			} finally {
				await unsafe.close();
			}
			await expect(
				store.pool.query("CREATE TABLE forbidden(id text)"),
			).rejects.toThrow();
			await expect(
				store.pool.query("UPDATE relay_schema_version SET version=2"),
			).rejects.toThrow();
		});
		it("persists encrypted challenge before send and never returns it or plaintext credentials", async () => {
			const { result, body } = await enrollment();
			expect(result.status).toBe(200);
			expect(result.body.kind).toBe("issued");
			expect(sent[0]).toMatchObject({
				fid: "original-fid",
				priority: "normal",
				data: { version: "1", registrationId },
			});
			const row = (
				await admin.query("SELECT * FROM relay_target WHERE id=$1", [targetId])
			).rows[0];
			expect(row.fid_encrypted).not.toContain("original-fid");
			expect(row.challenge_encrypted).not.toContain(
				sent[0].data.notificationId,
			);
			expect(JSON.stringify(row)).not.toContain(secret);
			expect(JSON.stringify(result.body)).not.toContain(
				sent[0].data.notificationId,
			);
			const retry = await request("/v1/enroll", body);
			expect(retry.body).toEqual(result.body);
			expect(sent).toHaveLength(1);
		});
		it("requires actual delivered challenge, current device proof and App Check", async () => {
			await enrollment();
			const incorrect = await request("/v1/confirm", {
				...common(),
				managementSecret: secret,
				generation: 1,
				challenge: id(),
			});
			expect(incorrect.body.kind).toBe("stale");
			const valid = await request("/v1/confirm", {
				...common(),
				managementSecret: secret,
				generation: 1,
				challenge: sent[0].data.notificationId,
			});
			expect(valid.body.kind).toBe("confirmed");
			const decoded = JSON.parse(
				Buffer.from(
					(valid.body.receipt as string).split(".")[1],
					"base64url",
				).toString(),
			);
			expect(decoded).toMatchObject({
				targetId,
				registrationId,
				offerId,
				generation: 1,
				relayOrigin: origin,
			});
		});
		it("serializes exact operation replay and rejects digest substitution", async () => {
			await confirmed();
			const body: Body<"/v1/send"> = {
				...common(),
				generation: 1,
				sendCapability: capability,
				priority: "high",
				data: {
					version: "1",
					notificationId: crypto.randomUUID(),
					registrationId,
				},
			};
			const results = await Promise.all([
				request("/v1/send", body, "sender"),
				request("/v1/send", body, "sender"),
			]);
			expect(
				JSON.parse(
					Buffer.from(
						(results[0].body.receipt as string).split(".")[1],
						"base64url",
					).toString(),
				),
			).toMatchObject({
				kind: "accepted",
				operationId: body.operationId,
				digest: semanticDigest(body),
				targetId,
				installationId,
				registrationId,
				generation: 1,
			});
			expect(results[0].body.receipt).toBe(results[1].body.receipt);
			expect(results.map((result) => result.body.kind)).toEqual([
				"accepted",
				"accepted",
			]);
			expect(sent).toHaveLength(2);
			const different = await request(
				"/v1/send",
				{ ...body, data: { ...body.data, notificationId: id() } },
				"sender",
			);
			expect(different.status).toBe(409);
			expect(sent).toHaveLength(2);
		});
		it("recovers only rotation's exact outcome with predecessor credentials and preserves delivery generation", async () => {
			await confirmed();
			const oldSecret = secret;
			const newSecret = id();
			const rotate: Body<"/v1/manage/rotate"> = {
				...common(),
				generation: 1,
				managementSecret: oldSecret,
				newManagementSecret: newSecret,
			};
			const first = await request("/v1/manage/rotate", rotate);
			expect(first.body).toMatchObject({
				kind: "rotated",
				generation: 1,
				credentialVersion: 2,
			});
			expect((await request("/v1/manage/rotate", rotate)).body).toEqual(
				first.body,
			);
			expect(
				(
					await request("/v1/operations/status", {
						...common(),
						managementSecret: oldSecret,
						queriedOperationId: rotate.operationId,
					})
				).body,
			).toEqual(first.body);
			expect(
				(
					await request("/v1/manage/retire", {
						...common(),
						generation: 1,
						managementSecret: oldSecret,
					})
				).status,
			).toBe(404);
			expect(
				(await request("/v1/manage/rotate", { ...rotate, operationId: id() }))
					.status,
			).toBe(404);
			secret = newSecret;
			expect(
				(
					await request(
						"/v1/send",
						{
							...common(),
							generation: 1,
							sendCapability: capability,
							priority: "normal",
							data: { version: "1", notificationId: id(), registrationId },
						},
						"sender",
					)
				).body.kind,
			).toBe("accepted");
		});
		it("stages replacement, challenges the new FID, then fences old-generation send and retirement", async () => {
			await confirmed();
			const newSecret = id();
			const replace: Body<"/v1/manage/replace-fid"> = {
				...common(),
				generation: 1,
				managementSecret: secret,
				newManagementSecret: newSecret,
				fid: "replacement-fid",
			};
			const result = await request("/v1/manage/replace-fid", replace);
			expect(result.body).toMatchObject({ kind: "issued", generation: 2 });
			expect(sent[1].fid).toBe("replacement-fid");
			expect(
				(
					await admin.query(
						"SELECT generation,management_hash FROM relay_target WHERE id=$1",
						[targetId],
					)
				).rows[0],
			).toMatchObject({
				generation: 1,
				management_hash: credentialHash("management", secret),
			});
			expect(
				(
					await request("/v1/confirm", {
						...common(),
						generation: 2,
						managementSecret: newSecret,
						challenge: sent[1].data.notificationId,
					})
				).body,
			).toMatchObject({
				kind: "confirmed",
				generation: 2,
				credentialVersion: 2,
			});
			secret = newSecret;
			expect(
				(
					await request("/v1/manage/retire", {
						...common(),
						generation: 1,
						managementSecret: secret,
					})
				).body.kind,
			).toBe("stale");
			expect(
				(
					await request(
						"/v1/send",
						{
							...common(),
							generation: 1,
							sendCapability: capability,
							priority: "normal",
							data: { version: "1", notificationId: id(), registrationId },
						},
						"sender",
					)
				).body.kind,
			).toBe("stale");
			expect(
				(
					await request(
						"/v1/send",
						{
							...common(),
							generation: 2,
							sendCapability: capability,
							priority: "normal",
							data: { version: "1", notificationId: id(), registrationId },
						},
						"sender",
					)
				).body.kind,
			).toBe("accepted");
			expect(sent[2].fid).toBe("replacement-fid");
		});
		it("holds target generation through provider submission before retirement commits", async () => {
			await confirmed();
			let release: () => void = () => {};
			providerPause = new Promise((resolve) => {
				release = resolve;
			});
			const send = request(
				"/v1/send",
				{
					...common(),
					generation: 1,
					sendCapability: capability,
					priority: "normal",
					data: { version: "1", notificationId: id(), registrationId },
				},
				"sender",
			);
			for (let count = 0; count < 100 && sent.length < 2; count++)
				await sleep(5);
			expect(sent).toHaveLength(2);
			let retired = false;
			const retire = request("/v1/manage/retire", {
				...common(),
				generation: 1,
				managementSecret: secret,
			}).then((result) => {
				retired = true;
				return result;
			});
			await sleep(25);
			expect(retired).toBe(false);
			release();
			expect((await send).body.kind).toBe("accepted");
			expect((await retire).body.kind).toBe("retired");
		});
		it("retries recoverable provider failure, retires all linked targets on UNREGISTERED and reserves quotas", async () => {
			await confirmed();
			providerOutcome = { kind: "retryable" };
			const body: Body<"/v1/send"> = {
				...common(),
				generation: 1,
				sendCapability: capability,
				priority: "normal",
				data: { version: "1", notificationId: id(), registrationId },
			};
			expect((await request("/v1/send", body, "sender")).status).toBe(503);
			expect((await request("/v1/send", body, "sender")).status).toBe(503);
			expect(sent).toHaveLength(3);
			expect(
				(
					await admin.query("SELECT count FROM relay_quota WHERE key=$1", [
						`target:${targetId}`,
					])
				).rows[0].count,
			).toBe(3);
			providerOutcome = { kind: "accepted" };
			const recovered = await request("/v1/send", body, "sender");
			expect(recovered.body.kind).toBe("accepted");
			expect((await request("/v1/send", body, "sender")).body).toEqual(
				recovered.body,
			);
			expect(sent).toHaveLength(4);
			providerOutcome = { kind: "stale" };
			expect(
				(await request("/v1/send", { ...body, operationId: id() }, "sender"))
					.body.kind,
			).toBe("stale");
			expect(
				(
					await admin.query("SELECT state FROM relay_target WHERE id=$1", [
						targetId,
					])
				).rows[0].state,
			).toBe("retired");
		});
		it("enforces target quota without provider attempt and leaves idle active installations intact", async () => {
			await confirmed();
			await admin.query("UPDATE relay_quota SET count=60 WHERE key=$1", [
				`target:${targetId}`,
			]);
			const result = await request(
				"/v1/send",
				{
					...common(),
					generation: 1,
					sendCapability: capability,
					priority: "normal",
					data: { version: "1", notificationId: id(), registrationId },
				},
				"sender",
			);
			expect(result.status).toBe(429);
			expect(sent).toHaveLength(1);
			await admin.query(
				"UPDATE relay_installation SET created_at=now()-interval '90 days'",
			);
			await admin.query(
				"UPDATE relay_operation SET created_at=now()-interval '8 days'",
			);
			await prune(store);
			expect(
				(
					await admin.query("SELECT state FROM relay_target WHERE id=$1", [
						targetId,
					])
				).rows[0].state,
			).toBe("confirmed");
			expect(
				(await admin.query("SELECT count(*) FROM relay_operation")).rows[0]
					.count,
			).toBe("0");
		});
		it("rejects copied offers, substituted device keys and enrollment operation mutation", async () => {
			const enrolled = await enrollment();
			const altered = await request("/v1/enroll", {
				...enrolled.body,
				operationId: id(),
				targetId: id(),
			});
			expect(altered.status).toBe(401);
			const changed = await request("/v1/enroll", {
				...enrolled.body,
				fid: "substituted-fid",
			});
			expect(changed.status).toBe(409);
			const another = await generateKeyPair("ES256", { extractable: true });
			device = another;
			const wrongDevice = await request("/v1/enroll", {
				...enrolled.body,
				operationId: id(),
				targetId: id(),
				deviceKey: publicKey.parse(await exportJWK(another.publicKey)),
			});
			expect(wrongDevice.status).toBe(401);
			expect(sent).toHaveLength(1);
		});
		it("rejects a proof nonce reused for a different operation", async () => {
			await confirmed();
			const nonce = id();
			const body: Body<"/v1/send"> = {
				...common(),
				generation: 1,
				sendCapability: capability,
				priority: "normal",
				data: { version: "1", notificationId: id(), registrationId },
			};
			const post = async (value: typeof body) => {
				const response = await fetch(`${serverOrigin}/v1/send`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						...value,
						senderProof: await proof(sender, "/v1/send", value, nonce),
					}),
				});
				return response.status;
			};
			expect(await post(body)).toBe(200);
			expect(await post({ ...body, operationId: id() })).toBe(409);
			expect(sent).toHaveLength(2);
		});
		it("bounds one retention transaction to 500 mutations", async () => {
			await confirmed();
			await admin.query(
				"INSERT INTO relay_nonce(key_thumbprint,nonce,operation_id,digest,expires_at) SELECT 'expired',n::text,'operation','digest',now()-interval '1 minute' FROM generate_series(1,600)n",
			);
			await prune(store);
			expect(
				Number(
					(
						await admin.query(
							"SELECT count(*) FROM relay_nonce WHERE key_thumbprint='expired'",
						)
					).rows[0].count,
				),
			).toBe(100);
			expect(
				(
					await admin.query("SELECT state FROM relay_target WHERE id=$1", [
						targetId,
					])
				).rows[0].state,
			).toBe("confirmed");
		});
		it("retires every linked target after installation UNREGISTERED", async () => {
			await confirmed();
			targetId = id();
			registrationId = crypto.randomUUID();
			offerId = id();
			secret = id();
			capability = id();
			sender = await generateKeyPair("ES256", { extractable: true });
			const enrolled = await enrollment();
			expect(enrolled.result.status).toBe(200);
			const challenge = sent.at(-1)?.data.notificationId as string;
			expect(
				(
					await request("/v1/confirm", {
						...common(),
						generation: 1,
						managementSecret: secret,
						challenge,
					})
				).status,
			).toBe(200);
			providerOutcome = { kind: "stale" };
			expect(
				(
					await request(
						"/v1/send",
						{
							...common(),
							generation: 1,
							sendCapability: capability,
							priority: "normal",
							data: { version: "1", notificationId: id(), registrationId },
						},
						"sender",
					)
				).body.kind,
			).toBe("stale");
			expect(
				(
					await admin.query(
						"SELECT count(*) FROM relay_target WHERE state='retired'",
					)
				).rows[0].count,
			).toBe("2");
		});
		it("does not allocate metadata for quota-exhausted sends and recovers the same request after capacity returns", async () => {
			await confirmed();
			await admin.query("UPDATE relay_quota SET count=60 WHERE key=$1", [
				`target:${targetId}`,
			]);
			const before = (
				await admin.query(
					"SELECT (SELECT count(*) FROM relay_operation) operations,(SELECT count(*) FROM relay_nonce) nonces",
				)
			).rows[0];
			const body: Body<"/v1/send"> = {
				...common(),
				generation: 1,
				sendCapability: capability,
				priority: "normal",
				data: { version: "1", notificationId: id(), registrationId },
			};
			for (let count = 0; count < 40; count++)
				expect(
					(
						await request(
							"/v1/send",
							{ ...body, operationId: count === 0 ? body.operationId : id() },
							"sender",
						)
					).status,
				).toBe(429);
			expect(
				(
					await admin.query(
						"SELECT (SELECT count(*) FROM relay_operation) operations,(SELECT count(*) FROM relay_nonce) nonces",
					)
				).rows[0],
			).toEqual(before);
			await admin.query(
				"UPDATE relay_quota SET window_start=now()-interval '2 hours' WHERE key=$1",
				[`target:${targetId}`],
			);
			expect((await request("/v1/send", body, "sender")).body.kind).toBe(
				"accepted",
			);
			expect(
				(
					await request("/v1/manage/retire", {
						...common(),
						generation: 1,
						managementSecret: secret,
					})
				).body.kind,
			).toBe("retired");
		});
		it.each([
			"retryable",
			"quota",
		] as const)("retries the same durable replacement challenge after %s without changing generation early", async (kind) => {
			await confirmed();
			providerOutcome = { kind };
			const newSecret = id();
			const body: Body<"/v1/manage/replace-fid"> = {
				...common(),
				managementSecret: secret,
				newManagementSecret: newSecret,
				generation: 1,
				fid: "replacement-fid",
			};
			expect((await request("/v1/manage/replace-fid", body)).body.kind).toBe(
				kind,
			);
			const challenge = sent.at(-1)?.data.notificationId;
			providerOutcome = { kind: "accepted" };
			expect(
				(await request("/v1/manage/replace-fid", body)).body,
			).toMatchObject({ kind: "issued", generation: 2 });
			expect(sent.at(-1)?.data.notificationId).toBe(challenge);
			expect((await request("/v1/manage/replace-fid", body)).body.kind).toBe(
				"issued",
			);
			expect(sent).toHaveLength(3);
			expect(
				(
					await request("/v1/confirm", {
						...common(),
						managementSecret: newSecret,
						generation: 2,
						challenge: challenge as string,
					})
				).body.kind,
			).toBe("confirmed");
		});
		it("retries enrollment on the same operation and recovers the captured result after rotation", async () => {
			providerOutcome = { kind: "retryable" };
			const enrolled = await enrollment();
			expect(enrolled.result.status).toBe(503);
			const challenge = sent[0].data.notificationId;
			providerOutcome = { kind: "accepted" };
			const issued = await request("/v1/enroll", enrolled.body);
			expect(issued.body.kind).toBe("issued");
			expect(sent[1].data.notificationId).toBe(challenge);
			expect(
				(
					await request("/v1/confirm", {
						...common(),
						managementSecret: secret,
						generation: 1,
						challenge,
					})
				).body.kind,
			).toBe("confirmed");
			expect(
				(
					await request("/v1/manage/rotate", {
						...common(),
						managementSecret: secret,
						newManagementSecret: id(),
						generation: 1,
					})
				).body.kind,
			).toBe("rotated");
			expect((await request("/v1/enroll", enrolled.body)).body).toEqual(
				issued.body,
			);
			expect(sent).toHaveLength(2);
		});
		it("recovers a lost replacement receipt with sender status and retires only the verified current generation", async () => {
			await confirmed();
			const newSecret = id();
			expect(
				(
					await request("/v1/manage/replace-fid", {
						...common(),
						managementSecret: secret,
						newManagementSecret: newSecret,
						generation: 1,
						fid: "replacement-fid",
					})
				).status,
			).toBe(200);
			expect(
				(
					await request("/v1/confirm", {
						...common(),
						managementSecret: newSecret,
						generation: 2,
						challenge: sent[1].data.notificationId,
					})
				).status,
			).toBe(200);
			const before = (
				await admin.query(
					"SELECT (SELECT count(*) FROM relay_operation) operations,(SELECT count(*) FROM relay_nonce) nonces",
				)
			).rows[0];
			const status = await request(
				"/v1/targets/status",
				{ ...common(), sendCapability: capability },
				"sender",
			);
			expect(status.body).toMatchObject({
				kind: "target-status",
				state: "confirmed",
				generation: 2,
			});
			expect(
				JSON.parse(
					Buffer.from(
						(status.body.receipt as string).split(".")[1],
						"base64url",
					).toString(),
				),
			).toMatchObject({
				kind: "target-status",
				state: "confirmed",
				targetId,
				installationId,
				registrationId,
				generation: 2,
				sendCapabilityHash: credentialHash("send", capability),
			});
			expect(
				(
					await admin.query(
						"SELECT (SELECT count(*) FROM relay_operation) operations,(SELECT count(*) FROM relay_nonce) nonces",
					)
				).rows[0],
			).toEqual(before);
			expect(
				(
					await request(
						"/v1/manage/retire",
						{ ...common(), sendCapability: capability, generation: 1 },
						"sender",
					)
				).body.kind,
			).toBe("stale");
			expect(
				(
					await request(
						"/v1/manage/retire",
						{
							...common(),
							sendCapability: capability,
							generation: status.body.generation as number,
						},
						"sender",
					)
				).body.kind,
			).toBe("retired");
			expect(
				(
					await request(
						"/v1/targets/status",
						{ ...common(), sendCapability: capability },
						"sender",
					)
				).body.state,
			).toBe("retired");
		});
		it("preserves retirement when retained operation admission is full", async () => {
			await confirmed();
			const existing = Number(
				(
					await admin.query(
						"SELECT count(*) FROM relay_operation WHERE target_id=$1",
						[targetId],
					)
				).rows[0].count,
			);
			const operations = Array.from({ length: 2048 - existing }, () => id());
			await admin.query(
				"INSERT INTO relay_operation(id,installation_id,target_id,path,digest,authority_hash,outcome) SELECT operation,$2,$3,'/v1/manage/rotate',$4,$5,'{\"kind\":\"rotated\"}'::jsonb FROM unnest($1::text[]) operation",
				[
					operations,
					installationId,
					targetId,
					id(),
					credentialHash("management", secret),
				],
			);
			const before = (await admin.query("SELECT count(*) FROM relay_nonce"))
				.rows[0].count;
			expect(
				(
					await request("/v1/manage/rotate", {
						...common(),
						managementSecret: secret,
						newManagementSecret: id(),
						generation: 1,
					})
				).status,
			).toBe(429);
			expect(
				(await admin.query("SELECT count(*) FROM relay_nonce")).rows[0].count,
			).toBe(before);
			expect(
				(
					await request("/v1/manage/retire", {
						...common(),
						managementSecret: secret,
						generation: 1,
					})
				).body.kind,
			).toBe("retired");
			expect(
				(
					await admin.query(
						"SELECT count(*) FROM relay_operation WHERE target_id=$1",
						[targetId],
					)
				).rows[0].count,
			).toBe("2049");
		});
		it("unknown targets are neutral and bad payloads never reach the provider", async () => {
			const missing = await request("/v1/manage/retire", {
				...common(),
				generation: 1,
				managementSecret: secret,
			});
			expect(missing).toEqual({ status: 404, body: { error: "not_found" } });
			const response = await fetch(`${serverOrigin}/v1/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...common(),
					generation: 1,
					sendCapability: capability,
					priority: "normal",
					data: {
						version: "1",
						notificationId: id(),
						registrationId,
						title: "forbidden",
					},
				}),
			});
			expect(response.status).toBe(400);
			expect(sent).toHaveLength(0);
		});
	},
);
