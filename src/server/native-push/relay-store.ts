import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import type { Pool } from "pg";
import type { FieldKeyRing } from "../../security/field-encryption.ts";
import { decryptField, encryptField } from "../../security/field-encryption.ts";
import type { NativeSession } from "../native-auth/session.ts";
import type { RelayConfiguration } from "./relay-configuration.ts";
import {
	type allocateOffer,
	canonical,
	credentialHash,
	id,
	RelayInstanceError,
	type RelayRegistration,
	relayRegistration,
} from "./relay-contracts.ts";
import {
	signOffer,
	thumbprint,
	verifyRegistrationReceipt,
} from "./relay-proof.ts";
import { NativePushStore, nativePushConfigContext } from "./store.ts";
export type AuthorityRow = {
	id: string;
	user_id: string;
	session_id: string;
	device_id: string;
	registration_id: string;
	request_digest: string;
	config_ciphertext: string;
	offer_token: string;
	state: string;
	generation: number;
	credential_version: number;
	offer_expires: Date;
	receipt: string | null;
};
export function authorityContext(
	row: Pick<
		AuthorityRow,
		"registration_id" | "user_id" | "session_id" | "device_id"
	>,
): string {
	return nativePushConfigContext(row.registration_id, {
		userId: row.user_id,
		sessionId: row.session_id,
		deviceId: row.device_id,
	});
}
export function decodeAuthority(
	row: AuthorityRow,
	ring: FieldKeyRing,
): RelayRegistration {
	return relayRegistration.parse(
		JSON.parse(
			decryptField(row.config_ciphertext, authorityContext(row), ring)
				.plaintext,
		),
	);
}
export class NativeRelayStore extends NativePushStore {
	constructor(
		pool: Pool,
		private relayRing: FieldKeyRing,
		private trust: RelayConfiguration,
	) {
		super(pool, relayRing);
	}
	async offer(
		owner: NativeSession,
		input: ReturnType<typeof allocateOffer.parse>,
	) {
		return this.owned(
			owner,
			async (client) => {
				const digest = canonical(input);
				await client.query(
					"select pg_advisory_xact_lock(hashtextextended($1,0))",
					[`native-relay-offer:${input.operationId}`],
				);
				const previous = (
					await client.query<AuthorityRow>(
						"select * from native_relay_authority where operation_id=$1 for update",
						[input.operationId],
					)
				).rows[0];
				if (previous) {
					if (
						previous.user_id !== owner.userId ||
						previous.session_id !== owner.sessionId ||
						previous.device_id !== owner.deviceId ||
						previous.request_digest !== digest
					)
						throw new RelayInstanceError("operation-conflict");
					if (
						previous.state !== "issued" ||
						previous.offer_expires.getTime() <= Date.now()
					)
						throw new RelayInstanceError("offer-unavailable");
					return this.publicOffer(previous);
				}
				const pending = await client.query(
					"select id from native_relay_authority where session_id=$1 and state='issued' and offer_expires>clock_timestamp() for update",
					[owner.sessionId],
				);
				if (pending.rows.length) throw new RelayInstanceError("offer-pending");
				const pair = await generateKeyPair("ES256", { extractable: true });
				const senderKey = await exportJWK(pair.publicKey),
					senderPrivateKey = await exportJWK(pair.privateKey);
				const expires = Math.floor(Date.now() / 1000) + 300,
					sendCapability = id(),
					offerId = id(),
					targetId = id(),
					registrationId = randomUUID();
				const config = relayRegistration.parse({
					provider: "fcm-relay",
					relayOrigin: this.trust.origin,
					installationId: input.installationId,
					targetId,
					registrationId,
					offerId,
					offerExpires: expires,
					senderKey,
					senderPrivateKey,
					senderThumbprint: await thumbprint(
						senderKey as RelayRegistration["senderKey"],
					),
					deviceThumbprint: await thumbprint(input.deviceKey),
					sendCapability,
					sendCapabilityHash: credentialHash("send", sendCapability),
					generation: 1,
					credentialVersion: 1,
					fidHash: null,
				});
				const token = await signOffer(config, expires);
				const ciphertext = encryptField(
					JSON.stringify(config),
					nativePushConfigContext(registrationId, owner),
					this.relayRing,
				);
				const row = (
					await client.query<AuthorityRow>(
						"insert into native_relay_authority(id,operation_id,user_id,session_id,device_id,registration_id,request_digest,config_ciphertext,offer_token,state,offer_expires) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',to_timestamp($10)) returning *",
						[
							offerId,
							input.operationId,
							owner.userId,
							owner.sessionId,
							owner.deviceId,
							registrationId,
							digest,
							ciphertext,
							token,
							expires,
						],
					)
				).rows[0];
				return this.publicOffer(row);
			},
			true,
		);
	}
	private publicOffer(row: AuthorityRow) {
		const value = decodeAuthority(row, this.relayRing);
		return {
			offer: row.offer_token,
			offerId: row.id,
			relayOrigin: value.relayOrigin,
			installationId: value.installationId,
			targetId: value.targetId,
			registrationId: value.registrationId,
			senderKey: value.senderKey,
			sendCapability: value.sendCapability,
			expiresAt: row.offer_expires.toISOString(),
		};
	}
	async activate(owner: NativeSession, offerId: string, receipt: string) {
		return this.owned(
			owner,
			async (client) => {
				const row = (
					await client.query<AuthorityRow>(
						"select * from native_relay_authority where id=$1 and user_id=$2 and session_id=$3 and device_id=$4 for update",
						[offerId, owner.userId, owner.sessionId, owner.deviceId],
					)
				).rows[0];
				if (!row) throw new RelayInstanceError("offer-unavailable");
				const config = decodeAuthority(row, this.relayRing);
				const bindings = await verifyRegistrationReceipt(
					receipt,
					this.trust,
					config,
				);
				if (bindings.generation !== 1 || bindings.credentialVersion !== 1)
					throw new RelayInstanceError("receipt-stale");
				if (row.state === "active") {
					const live = await client.query(
						"select id from native_push_registration where id=$1 and session_id=$2 and provider='fcm-relay' for update",
						[row.registration_id, owner.sessionId],
					);
					if (live.rowCount !== 1 || row.receipt !== receipt)
						throw new RelayInstanceError("offer-consumed");
					return { registrationId: row.registration_id, provider: "fcm-relay" };
				}
				if (row.state !== "issued" || row.offer_expires.getTime() <= Date.now())
					throw new RelayInstanceError("offer-unavailable");
				await client.query(
					"delete from native_push_registration where session_id=$1",
					[owner.sessionId],
				);

				const activeConfig = { ...config, fidHash: bindings.fidHash };
				const activeCiphertext = encryptField(
					JSON.stringify(activeConfig),
					authorityContext(row),
					this.relayRing,
				);
				await client.query(
					"insert into native_push_registration(id,user_id,session_id,device_id,provider,config_ciphertext) values($1,$2,$3,$4,'fcm-relay',$5)",
					[
						row.registration_id,
						owner.userId,
						owner.sessionId,
						owner.deviceId,
						activeCiphertext,
					],
				);
				await client.query(
					"update native_relay_authority set state='active',receipt=$2,config_ciphertext=$3 where id=$1",
					[row.id, receipt, activeCiphertext],
				);
				return { registrationId: row.registration_id, provider: "fcm-relay" };
			},
			true,
		);
	}
	async update(
		owner: NativeSession,
		registrationId: string,
		expectedGeneration: number,
		receipt: string,
	) {
		return this.owned(
			owner,
			async (client) => {
				// Registration before recovery authority matches delivery and rotation lock order.
				const registration = await client.query(
					"select id from native_push_registration where id=$1 and user_id=$2 and session_id=$3 and device_id=$4 and provider='fcm-relay' for update",
					[registrationId, owner.userId, owner.sessionId, owner.deviceId],
				);
				if (registration.rowCount !== 1)
					throw new RelayInstanceError("registration-retired");
				const row = (
					await client.query<AuthorityRow>(
						"select * from native_relay_authority where registration_id=$1 and state='active' for update",
						[registrationId],
					)
				).rows[0];
				if (!row) throw new RelayInstanceError("generation-conflict");
				const config = decodeAuthority(row, this.relayRing),
					bindings = await verifyRegistrationReceipt(
						receipt,
						this.trust,
						config,
					);
				if (receipt === row.receipt)
					return { registrationId, generation: row.generation };
				if (row.generation !== expectedGeneration)
					throw new RelayInstanceError("generation-conflict");
				if (
					bindings.generation < config.generation ||
					bindings.generation > config.generation + 1 ||
					bindings.credentialVersion <= config.credentialVersion ||
					(bindings.generation === config.generation &&
						bindings.fidHash !== config.fidHash)
				)
					throw new RelayInstanceError("receipt-stale");
				const next = {
					...config,
					generation: bindings.generation,
					credentialVersion: bindings.credentialVersion,
					fidHash: bindings.fidHash,
				};
				const encrypted = encryptField(
					JSON.stringify(next),
					authorityContext(row),
					this.relayRing,
				);
				await client.query(
					"update native_push_registration set config_ciphertext=$2 where id=$1",
					[registrationId, encrypted],
				);
				await client.query(
					"update native_relay_authority set config_ciphertext=$2,generation=$3,credential_version=$4,receipt=$5 where id=$1",
					[row.id, encrypted, next.generation, next.credentialVersion, receipt],
				);
				return { registrationId, generation: next.generation };
			},
			true,
		);
	}
	async cancel(owner: NativeSession, offerId: string) {
		return this.owned(
			owner,
			async (client) => {
				const registration = (
					await client.query(
						"select registration_id from native_relay_authority where id=$1 and user_id=$2 and session_id=$3 and device_id=$4",
						[offerId, owner.userId, owner.sessionId, owner.deviceId],
					)
				).rows[0];
				if (!registration) throw new RelayInstanceError("offer-unavailable");
				await client.query("delete from native_push_registration where id=$1", [
					registration.registration_id,
				]);
				await client.query(
					"update native_relay_authority set state='retiring',next_attempt=clock_timestamp() where id=$1",
					[offerId],
				);
				return { cancelled: true };
			},
			true,
		);
	}
}
