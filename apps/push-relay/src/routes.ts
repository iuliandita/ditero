import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
	decryptField,
	encryptField,
} from "../../../src/security/field-encryption.ts";
import type { Configuration } from "./configuration.ts";
import {
	type Body,
	credentialHash,
	id,
	LIMITS,
	type Outcome,
	type Path,
	RelayError,
	schemas,
	semanticDigest,
} from "./contracts.ts";
import type { PushSender } from "./fcm.ts";
import { receipt, thumbprint, verifyOffer, verifyProof } from "./proof.ts";
import type { Operation, Store, Target } from "./store.ts";
export type Dependencies = {
	store: Store;
	configuration: Configuration;
	appCheck: (token: string | undefined, signal: AbortSignal) => Promise<string>;
	send: PushSender;
};
const context = (target: Target, field: string) =>
	`relay:${target.installation_id}:${target.id}:${field}`;
export function createRoutes(deps: Dependencies) {
	const { store, configuration: config } = deps;
	type Proof = Awaited<ReturnType<typeof verifyProof>>;
	const resumable = (outcome: Outcome | null) =>
		outcome?.kind === "retryable" || outcome?.kind === "quota";
	async function deviceAuth(
		body: Body,
		path: Path,
		digest: string,
		signal: AbortSignal,
		deviceKey: Parameters<typeof verifyProof>[1],
	): Promise<Proof> {
		await deps.appCheck("appCheck" in body ? body.appCheck : undefined, signal);
		return verifyProof(
			"deviceProof" in body ? body.deviceProof : undefined,
			deviceKey,
			config.origin,
			path,
			body.operationId,
			digest,
		);
	}
	async function senderAuth(
		body: Body,
		path: Path,
		digest: string,
		target: Target,
	): Promise<Proof> {
		return verifyProof(
			"senderProof" in body ? body.senderProof : undefined,
			target.sender_key,
			config.origin,
			path,
			body.operationId,
			digest,
		);
	}
	async function reserve(target: Target): Promise<boolean> {
		return store.quota([
			{ key: `target:${target.id}`, seconds: 3600, limit: 60 },
			{
				key: `installation:${target.installation_id}`,
				seconds: 86400,
				limit: 200,
			},
		]);
	}
	async function signedReceipt(
		target: Target,
		fidValue: string,
		deviceThumbprint: string,
		additional: Record<string, unknown> = {},
	): Promise<string> {
		return receipt(
			config.signer,
			{
				offerId: target.offer_id,
				offerExpires: Math.floor(target.offer_expires.getTime() / 1000),
				registrationId: target.registration_id,
				targetId: target.id,
				installationId: target.installation_id,
				senderKey: target.sender_key,
				senderThumbprint: target.sender_thumbprint,
				deviceThumbprint,
				relayOrigin: config.origin,
				fidHash: createHash("sha256")
					.update("ditero:push-relay:v1:fid:")
					.update(fidValue)
					.digest("base64url"),
				generation: target.generation,
				credentialVersion: target.credential_version,
				sendCapabilityHash: target.send_hash,
				...additional,
			},
			config.origin,
		);
	}
	async function submit(
		client: PoolClient,
		target: Target,
		operation: Operation,
		fidValue: string,
		notificationId: string,
		priority: "normal" | "high",
		signal: AbortSignal,
		successful: "issued" | "accepted",
		proof: Proof,
		quotaReserved = false,
	): Promise<Outcome> {
		if (!quotaReserved && !(await reserve(target)))
			return store.finish(client, operation, { kind: "quota" });
		await store.nonce(client, proof, operation.id, operation.digest);
		signal.throwIfAborted();
		const result = await deps.send(
			fidValue,
			{ version: "1", notificationId, registrationId: target.registration_id },
			priority,
			signal,
		);
		signal.throwIfAborted();
		if (result.kind === "stale")
			await store.retireInstallation(client, target.installation_id);
		let acceptedReceipt: string | undefined;
		if (result.kind === "accepted" && successful === "accepted") {
			const installation = (
				await client.query<{ device_thumbprint: string }>(
					"SELECT device_thumbprint FROM relay_installation WHERE id=$1",
					[target.installation_id],
				)
			).rows[0];
			acceptedReceipt = await signedReceipt(
				target,
				fidValue,
				installation.device_thumbprint,
				{
					kind: "accepted",
					operationId: operation.id,
					digest: operation.digest,
				},
			);
		}
		return store.finish(
			client,
			operation,
			result.kind === "accepted"
				? {
						kind: successful,
						generation: target.generation,
						credentialVersion: target.credential_version,
						...(acceptedReceipt ? { receipt: acceptedReceipt } : {}),
					}
				: result,
		);
	}
	async function enroll(
		body: Body<"/v1/enroll">,
		digest: string,
		signal: AbortSignal,
		ip: string,
	): Promise<Outcome> {
		const appId = await deps.appCheck(
			"appCheck" in body ? body.appCheck : undefined,
			signal,
		);
		const deviceThumbprint = await thumbprint(body.deviceKey);
		const senderThumbprint = await thumbprint(body.senderKey);
		const device = await verifyProof(
			body.deviceProof,
			body.deviceKey,
			config.origin,
			"/v1/enroll",
			body.operationId,
			digest,
		);
		const managementHash = credentialHash("management", body.managementSecret);
		const sendHash = credentialHash("send", body.sendCapability);
		const existing = await store.transaction(async (client) => {
			// This lock bounds capacity admission, including creation of new installations.
			await client.query("SELECT pg_advisory_xact_lock(492001)");
			const known = (
				await client.query<Target>("SELECT * FROM relay_target WHERE id=$1", [
					body.targetId,
				])
			).rows[0];
			if (known) {
				const locked = await store.lock(
					client,
					body.installationId,
					body.targetId,
				);
				if (
					locked.installation.device_thumbprint !== deviceThumbprint ||
					known.sender_thumbprint !== senderThumbprint ||
					known.registration_id !== body.registrationId ||
					known.offer_id !== body.offerId ||
					known.send_hash !== sendHash
				)
					throw new RelayError(404, "not_found");
				const previous = (
					await client.query<Operation>(
						"SELECT * FROM relay_operation WHERE id=$1 FOR UPDATE",
						[body.operationId],
					)
				).rows[0];
				if (previous) {
					if (
						previous.installation_id !== body.installationId ||
						previous.target_id !== body.targetId ||
						previous.path !== "/v1/enroll" ||
						previous.digest !== digest ||
						previous.authority_hash !== managementHash
					)
						throw new RelayError(409, "operation_conflict");
					if (
						previous.outcome &&
						(!resumable(previous.outcome) ||
							known.management_hash !== managementHash)
					)
						return previous;
				}
				if (known.management_hash !== managementHash)
					throw new RelayError(404, "not_found");
				await store.nonce(client, device, body.operationId, digest, false);
				if (!previous) await store.admit(client, known.id, "/v1/enroll");
				return store.operation(
					client,
					body,
					"/v1/enroll",
					digest,
					managementHash,
				);
			}
			const expires = await verifyOffer(body.offer, body.senderKey, {
				origin: config.origin,
				installationId: body.installationId,
				offerId: body.offerId,
				targetId: body.targetId,
				registrationId: body.registrationId,
				deviceThumbprint,
				sendCapabilityHash: sendHash,
			});
			const installed = (
				await client.query<{ id: string; device_thumbprint: string }>(
					"SELECT id,device_thumbprint FROM relay_installation WHERE id=$1 OR device_thumbprint=$2 FOR UPDATE",
					[body.installationId, deviceThumbprint],
				)
			).rows;
			if (
				installed.some(
					(row) =>
						row.id !== body.installationId ||
						row.device_thumbprint !== deviceThumbprint,
				)
			)
				throw new RelayError(409, "installation_conflict");
			const capacity = (
				await client.query<{ installations: string; targets: string }>(
					"SELECT (SELECT count(*) FROM relay_installation) installations,(SELECT count(*) FROM relay_target) targets",
				)
			).rows[0];
			if (
				(!installed.length && Number(capacity.installations) >= 10000) ||
				Number(capacity.targets) >= 50000
			)
				throw new RelayError(429, "capacity");
			const counts = (
				await client.query<{ confirmed: string; pending: string }>(
					"SELECT count(*) FILTER(WHERE state='confirmed') confirmed,count(*) FILTER(WHERE state='issued' OR pending_fid IS NOT NULL) pending FROM relay_target WHERE installation_id=$1",
					[body.installationId],
				)
			).rows[0];
			if (Number(counts.confirmed) >= 5 || Number(counts.pending) >= 2)
				throw new RelayError(429, "capacity");
			if (
				!(await store.quota([
					{ key: `enroll:app:${appId}`, seconds: 3600, limit: 10 },
					{
						key: `enroll:device:${deviceThumbprint}`,
						seconds: 3600,
						limit: 10,
					},
					{
						key: `enroll:ip:${createHash("sha256").update(ip).digest("base64url")}`,
						seconds: 3600,
						limit: 10,
					},
				]))
			)
				throw new RelayError(429, "quota");
			await client.query(
				"INSERT INTO relay_installation(id,device_key,device_thumbprint) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
				[body.installationId, body.deviceKey, deviceThumbprint],
			);
			const target = {
				id: body.targetId,
				installation_id: body.installationId,
			} as Target;
			const challenge = id();
			await client.query(
				"INSERT INTO relay_target(id,installation_id,registration_id,offer_id,offer_expires,sender_key,sender_thumbprint,send_hash,management_hash,state,fid_encrypted,challenge_encrypted) VALUES($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,'issued',$10,$11)",
				[
					body.targetId,
					body.installationId,
					body.registrationId,
					body.offerId,
					expires,
					body.senderKey,
					senderThumbprint,
					sendHash,
					managementHash,
					encryptField(body.fid, context(target, "fid"), config.encryption),
					encryptField(
						challenge,
						context(target, "challenge"),
						config.encryption,
					),
				],
			);
			await store.nonce(client, device, body.operationId, digest);
			return store.operation(
				client,
				body,
				"/v1/enroll",
				digest,
				managementHash,
			);
		}, signal);
		if (existing.outcome && !resumable(existing.outcome))
			return existing.outcome;
		// The encrypted challenge and target are durable before external submission.
		return store.transaction(async (client) => {
			const { target } = await store.lock(
				client,
				body.installationId,
				body.targetId,
			);
			const operation = await store.operation(
				client,
				body,
				"/v1/enroll",
				digest,
				managementHash,
			);
			if (operation.outcome && !resumable(operation.outcome))
				return operation.outcome;
			if (target.management_hash !== managementHash)
				return operation.outcome ?? { kind: "stale" };
			if (
				target.state !== "issued" ||
				target.offer_expires.getTime() <= Date.now() ||
				!target.challenge_encrypted
			)
				return store.finish(client, operation, { kind: "stale" });
			return submit(
				client,
				target,
				operation,
				decryptField(
					target.fid_encrypted,
					context(target, "fid"),
					config.encryption,
				).plaintext,
				decryptField(
					target.challenge_encrypted,
					context(target, "challenge"),
					config.encryption,
				).plaintext,
				"normal",
				signal,
				"issued",
				device,
			);
		}, signal);
	}
	async function manage(
		path: Exclude<Path, "/v1/enroll">,
		body: Body,
		digest: string,
		signal: AbortSignal,
	): Promise<Outcome> {
		let pendingSubmission = false;
		const outcome = await store.transaction<Outcome>(async (client) => {
			const { installation, target } = await store.lock(
				client,
				body.installationId,
				body.targetId,
			);
			if (target.registration_id !== body.registrationId)
				throw new RelayError(404, "not_found");
			const sender =
				path === "/v1/send" ||
				path === "/v1/targets/status" ||
				(path === "/v1/manage/retire" &&
					"sendCapability" in body &&
					Boolean(body.sendCapability));
			const proof = sender
				? await senderAuth(body, path, digest, target)
				: await deviceAuth(body, path, digest, signal, installation.device_key);
			await store.nonce(client, proof, body.operationId, digest, false);
			if (path === "/v1/targets/status") {
				const input = body as Body<"/v1/targets/status">;
				if (credentialHash("send", input.sendCapability) !== target.send_hash)
					throw new RelayError(404, "not_found");
				if (
					!(await store.quota([
						{ key: `status:${target.id}`, seconds: 3600, limit: 120 },
					]))
				)
					return { kind: "quota" };
				const signed = await signedReceipt(
					target,
					decryptField(
						target.fid_encrypted,
						context(target, "fid"),
						config.encryption,
					).plaintext,
					installation.device_thumbprint,
					{
						kind: "target-status",
						state: target.state,
						operationId: body.operationId,
						digest,
					},
				);
				return {
					kind: "target-status",
					state: target.state,
					generation: target.generation,
					credentialVersion: target.credential_version,
					receipt: signed,
				};
			}
			if (path === "/v1/operations/status") {
				const input = body as Body<"/v1/operations/status">;
				const op = (
					await client.query<Operation>(
						"SELECT * FROM relay_operation WHERE id=$1 AND installation_id=$2 AND target_id=$3 FOR UPDATE",
						[input.queriedOperationId, input.installationId, input.targetId],
					)
				).rows[0];
				const hash = credentialHash("management", input.managementSecret);
				if (
					!op ||
					(target.management_hash !== hash &&
						target.pending_management_hash !== hash &&
						op.authority_hash !== hash)
				)
					throw new RelayError(404, "not_found");
				return op.outcome ?? { kind: "retryable" };
			}
			const authority = sender
				? credentialHash("send", (body as Body<"/v1/send">).sendCapability)
				: credentialHash(
						"management",
						(body as Body<"/v1/confirm">).managementSecret,
					);
			const previous = (
				await client.query<Operation>(
					"SELECT * FROM relay_operation WHERE id=$1 FOR UPDATE",
					[body.operationId],
				)
			).rows[0];
			if (previous) {
				if (
					previous.target_id !== target.id ||
					previous.installation_id !== installation.id ||
					previous.path !== path ||
					previous.digest !== digest ||
					previous.authority_hash !== authority
				)
					throw new RelayError(409, "operation_conflict");
				if (previous.outcome && !resumable(previous.outcome))
					return previous.outcome;
			}
			const confirm = path === "/v1/confirm";
			const pendingConfirm = confirm && target.pending_fid !== null;
			const expectedAuthority = sender
				? target.send_hash
				: pendingConfirm
					? target.pending_management_hash
					: target.management_hash;
			if (authority !== expectedAuthority) {
				if (previous?.outcome) return previous.outcome;
				throw new RelayError(404, "not_found");
			}
			const generation = (body as Body<"/v1/send">).generation;
			if (
				generation !== target.generation + (pendingConfirm ? 1 : 0) ||
				target.state === "retired"
			)
				return { kind: "stale" };
			let reserved = false;
			if (path === "/v1/send") {
				const input = body as Body<"/v1/send">;
				if (
					target.state !== "confirmed" ||
					input.data.registrationId !== target.registration_id
				)
					return { kind: "stale" };
				if (!(await reserve(target)))
					return previous
						? store.finish(client, previous, { kind: "quota" })
						: { kind: "quota" };
				reserved = true;
			}
			if (!previous) await store.admit(client, target.id, path);
			if (path !== "/v1/send" && path !== "/v1/manage/replace-fid")
				await store.nonce(client, proof, body.operationId, digest);
			const operation = await store.operation(
				client,
				body,
				path,
				digest,
				authority,
			);
			if (path === "/v1/send") {
				const input = body as Body<"/v1/send">;
				if (
					target.state !== "confirmed" ||
					input.data.registrationId !== target.registration_id
				)
					return store.finish(client, operation, { kind: "stale" });
				return submit(
					client,
					target,
					operation,
					decryptField(
						target.fid_encrypted,
						context(target, "fid"),
						config.encryption,
					).plaintext,
					input.data.notificationId,
					input.priority,
					signal,
					"accepted",
					proof,
					reserved,
				);
			}
			if (path === "/v1/confirm") {
				const input = body as Body<"/v1/confirm">;
				const encrypted = pendingConfirm
					? target.pending_challenge
					: target.challenge_encrypted;
				const expires = pendingConfirm
					? target.pending_expires
					: target.offer_expires;
				if (
					(!pendingConfirm && target.state !== "issued") ||
					!encrypted ||
					!expires ||
					expires.getTime() <= Date.now() ||
					decryptField(
						encrypted,
						context(target, pendingConfirm ? "pending-challenge" : "challenge"),
						config.encryption,
					).plaintext !== input.challenge
				)
					return store.finish(client, operation, { kind: "stale" });
				const count = (
					await client.query<{ count: string }>(
						"SELECT count(*) FROM relay_target WHERE installation_id=$1 AND state='confirmed'",
						[target.installation_id],
					)
				).rows[0];
				if (!pendingConfirm && Number(count.count) >= 5)
					return store.finish(client, operation, { kind: "quota" });
				if (
					pendingConfirm &&
					target.pending_fid &&
					target.pending_management_hash
				) {
					target.fid_encrypted = encryptField(
						decryptField(
							target.pending_fid,
							context(target, "pending-fid"),
							config.encryption,
						).plaintext,
						context(target, "fid"),
						config.encryption,
					);
					target.management_hash = target.pending_management_hash;
					target.generation++;
					target.credential_version++;
				}
				target.state = "confirmed";
				target.receipt = await signedReceipt(
					target,
					decryptField(
						target.fid_encrypted,
						context(target, "fid"),
						config.encryption,
					).plaintext,
					installation.device_thumbprint,
				);
				await client.query(
					"UPDATE relay_target SET state='confirmed',fid_encrypted=$2,management_hash=$3,generation=$4,credential_version=$5,receipt=$6,challenge_encrypted=NULL,pending_fid=NULL,pending_management_hash=NULL,pending_challenge=NULL,pending_expires=NULL,pending_operation_id=NULL WHERE id=$1",
					[
						target.id,
						target.fid_encrypted,
						target.management_hash,
						target.generation,
						target.credential_version,
						target.receipt,
					],
				);
				return store.finish(client, operation, {
					kind: "confirmed",
					receipt: target.receipt,
					generation: target.generation,
					credentialVersion: target.credential_version,
				});
			}
			if (path === "/v1/manage/rotate") {
				if (target.state !== "confirmed" || target.pending_fid)
					return store.finish(client, operation, { kind: "stale" });
				const input = body as Body<"/v1/manage/rotate">;
				target.management_hash = credentialHash(
					"management",
					input.newManagementSecret,
				);
				target.credential_version++;
				target.receipt = await signedReceipt(
					target,
					decryptField(
						target.fid_encrypted,
						context(target, "fid"),
						config.encryption,
					).plaintext,
					installation.device_thumbprint,
				);
				await client.query(
					"UPDATE relay_target SET management_hash=$2,credential_version=$3,receipt=$4 WHERE id=$1",
					[
						target.id,
						target.management_hash,
						target.credential_version,
						target.receipt,
					],
				);
				return store.finish(client, operation, {
					kind: "rotated",
					receipt: target.receipt,
					generation: target.generation,
					credentialVersion: target.credential_version,
				});
			}
			if (path === "/v1/manage/replace-fid") {
				const input = body as Body<"/v1/manage/replace-fid">;
				if (
					target.state !== "confirmed" ||
					(target.pending_fid && target.pending_operation_id !== operation.id)
				)
					return store.finish(client, operation, { kind: "stale" });
				const pending = (
					await client.query<{ count: string }>(
						"SELECT count(*) FROM relay_target WHERE installation_id=$1 AND (state='issued' OR pending_fid IS NOT NULL)",
						[target.installation_id],
					)
				).rows[0];
				if (!target.pending_fid && Number(pending.count) >= 2)
					return store.finish(client, operation, { kind: "quota" });
				if (!target.pending_fid)
					await client.query(
						"UPDATE relay_target SET pending_fid=$2,pending_management_hash=$3,pending_challenge=$4,pending_expires=now()+interval '5 minutes',pending_operation_id=$5 WHERE id=$1",
						[
							target.id,
							encryptField(
								input.fid,
								context(target, "pending-fid"),
								config.encryption,
							),
							credentialHash("management", input.newManagementSecret),
							encryptField(
								id(),
								context(target, "pending-challenge"),
								config.encryption,
							),
							operation.id,
						],
					);
				pendingSubmission = true;
				return { kind: "issued", generation: target.generation + 1 };
			}
			if (path === "/v1/manage/retire") {
				await client.query(
					"UPDATE relay_target SET state='retired',retired_at=now(),challenge_encrypted=NULL,pending_fid=NULL,pending_management_hash=NULL,pending_challenge=NULL,pending_expires=NULL,pending_operation_id=NULL WHERE id=$1",
					[target.id],
				);
				return store.finish(client, operation, {
					kind: "retired",
					generation: target.generation,
				});
			}
			throw new RelayError(400, "invalid_request");
		}, signal);
		if (!pendingSubmission) return outcome;
		return store.transaction(async (client) => {
			const { target, installation } = await store.lock(
				client,
				body.installationId,
				body.targetId,
			);
			const proof = await deviceAuth(
				body,
				path,
				digest,
				signal,
				installation.device_key,
			);
			const authority = credentialHash(
				"management",
				(body as Body<"/v1/manage/replace-fid">).managementSecret,
			);
			const operation = await store.operation(
				client,
				body,
				path,
				digest,
				authority,
			);
			if (operation.outcome && !resumable(operation.outcome))
				return operation.outcome;
			if (
				!target.pending_fid ||
				!target.pending_challenge ||
				target.pending_operation_id !== operation.id ||
				!target.pending_expires ||
				target.pending_expires.getTime() <= Date.now() ||
				target.state !== "confirmed"
			)
				return store.finish(client, operation, { kind: "stale" });
			const result = await submit(
				client,
				target,
				operation,
				decryptField(
					target.pending_fid,
					context(target, "pending-fid"),
					config.encryption,
				).plaintext,
				decryptField(
					target.pending_challenge,
					context(target, "pending-challenge"),
					config.encryption,
				).plaintext,
				"normal",
				signal,
				"issued",
				proof,
			);
			if (result.kind === "issued")
				return store.finish(client, operation, {
					...result,
					generation: target.generation + 1,
				});
			return result;
		}, signal);
	}
	return async (request: Request, peerAddress: string): Promise<Response> => {
		const path = new URL(request.url).pathname;
		if (request.method !== "POST" || !Object.hasOwn(schemas, path))
			return Response.json({ error: "not_found" }, { status: 404 });
		const signal = AbortSignal.any([
			request.signal,
			AbortSignal.timeout(LIMITS.deadline),
		]);
		const execute = async (): Promise<Response> => {
			try {
				if (
					!/^application\/json(?:\s*;|$)/i.test(
						request.headers.get("content-type") ?? "",
					)
				)
					throw new RelayError(415, "invalid_request");
				const size = Number(request.headers.get("content-length") ?? 0);
				if (!Number.isFinite(size) || size < 0 || size > LIMITS.body)
					throw new RelayError(413, "invalid_request");
				const reader = request.body?.getReader();
				if (!reader) throw new RelayError(400, "invalid_request");
				const abortRead = () => {
					void reader.cancel();
				};
				signal.addEventListener("abort", abortRead, { once: true });
				const parts: Uint8Array[] = [];
				let length = 0;
				while (true) {
					signal.throwIfAborted();
					const read = await reader.read();
					if (read.done) break;
					length += read.value.length;
					if (length > LIMITS.body) {
						await reader.cancel();
						throw new RelayError(413, "invalid_request");
					}
					parts.push(read.value);
				}
				signal.removeEventListener("abort", abortRead);
				signal.throwIfAborted();
				let raw: unknown;
				try {
					raw = JSON.parse(Buffer.concat(parts).toString("utf8"));
				} catch {
					throw new RelayError(400, "invalid_request");
				}
				const parsed = schemas[path as Path].safeParse(raw);
				if (!parsed.success) throw new RelayError(400, "invalid_request");
				const body = parsed.data;
				const digest = semanticDigest(body);
				const result =
					path === "/v1/enroll"
						? await enroll(
								body as Body<"/v1/enroll">,
								digest,
								signal,
								peerAddress,
							)
						: await manage(
								path as Exclude<Path, "/v1/enroll">,
								body,
								digest,
								signal,
							);
				const status =
					result.kind === "quota"
						? 429
						: result.kind === "retryable"
							? 503
							: result.kind === "permanent"
								? 422
								: result.kind === "stale"
									? 409
									: 200;
				return Response.json(result, {
					status,
					headers: { "cache-control": "no-store" },
				});
			} catch (error) {
				if (error instanceof RelayError)
					return Response.json(
						{ error: error.code },
						{ status: error.status, headers: { "cache-control": "no-store" } },
					);
				return Response.json(
					{ error: signal.aborted ? "deadline" : "unavailable" },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			}
		};
		let abort: () => void = () => {};
		const interrupted = new Promise<never>((_resolve, reject) => {
			abort = () => reject(new Error("deadline"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
		try {
			return await Promise.race([execute(), interrupted]);
		} catch {
			return Response.json(
				{ error: "deadline" },
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
}
