import type { Pool } from "pg";
import {
	encryptField,
	type FieldKeyRing,
	reencryptField,
} from "../../security/field-encryption.ts";
import type { safeFetch } from "../../security/safe-http.ts";
import type { Network } from "../client-ip.ts";
import { relayRequest } from "../notifications/adapters/relay-push.ts";
import type { RelayConfiguration } from "./relay-configuration.ts";
import type { Body } from "./relay-contracts.ts";
import { operationId, verifyTargetStatusReceipt } from "./relay-proof.ts";
import {
	type AuthorityRow,
	authorityContext,
	decodeAuthority,
} from "./relay-store.ts";
export async function recoverRelayAuthorities(
	pool: Pool,
	ring: FieldKeyRing,
	trust: RelayConfiguration,
	options: {
		signal?: AbortSignal;
		fetch?: typeof safeFetch;
		allowedPrivateCIDRs?: readonly Network[];
	} = {},
): Promise<number> {
	const ids = (
		await pool.query<{ id: string }>(
			"select id from native_relay_authority where next_attempt<=clock_timestamp() order by next_attempt,id limit 20",
		)
	).rows;
	let acknowledged = 0;
	for (const { id: authorityId } of ids) {
		const client = await pool.connect();
		try {
			await client.query("begin");
			const snapshot = (
				await client.query<AuthorityRow>(
					"select * from native_relay_authority where id=$1",
					[authorityId],
				)
			).rows[0];
			if (!snapshot) {
				await client.query("commit");
				continue;
			}
			await client.query("select set_config('ditero.user_id',$1,true)", [
				snapshot.user_id,
			]);
			const user = await client.query(
				'select id from "user" where id=$1 and deleted_at is null for share',
				[snapshot.user_id],
			);
			const live = await client.query(
				"select s.id from session s join native_session_link l on l.session_id=s.id and l.user_id=s.user_id join user_device d on d.id=l.device_id and d.user_id=s.user_id where s.id=$1 and s.user_id=$2 and d.id=$3 and s.expires_at>clock_timestamp() and d.revoked_at is null for update of s,l,d",
				[snapshot.session_id, snapshot.user_id, snapshot.device_id],
			);
			const registration = await client.query(
				"select id from native_push_registration where id=$1 and provider='fcm-relay' for update",
				[snapshot.registration_id],
			);
			const row = (
				await client.query<AuthorityRow>(
					"select * from native_relay_authority where id=$1 and next_attempt<=clock_timestamp() for update skip locked",
					[authorityId],
				)
			).rows[0];
			if (!row) {
				await client.query("commit");
				continue;
			}
			const authorityLive = user.rowCount === 1 && live.rowCount === 1;
			if (
				row.state !== "retiring" &&
				authorityLive &&
				((row.state === "active" && registration.rowCount === 1) ||
					(row.state === "issued" && row.offer_expires.getTime() > Date.now()))
			) {
				await client.query(
					"update native_relay_authority set next_attempt=clock_timestamp()+interval '30 seconds' where id=$1",
					[row.id],
				);
				await client.query("commit");
				continue;
			}
			await client.query("delete from native_push_registration where id=$1", [
				row.registration_id,
			]);
			await client.query(
				"update native_relay_authority set state='retiring' where id=$1",
				[row.id],
			);
			await client.query("commit");
			// Local retirement commits first. The retained no-FK snapshot is now the sole recovery authority.
			await client.query("begin");
			const claimed = (
				await client.query<AuthorityRow>(
					"select * from native_relay_authority where id=$1 and state='retiring' and next_attempt<=clock_timestamp() for update skip locked",
					[row.id],
				)
			).rows[0];
			if (!claimed) {
				await client.query("commit");
				continue;
			}
			const config = decodeAuthority(claimed, ring);
			if (config.relayOrigin !== trust.origin) {
				await client.query(
					"update native_relay_authority set next_attempt=clock_timestamp()+interval '5 minutes' where id=$1",
					[claimed.id],
				);
				await client.query("commit");
				continue;
			}
			// Stable cleanup operation, independent of credential/proof refresh and replica ownership.
			const body: Body<"/v1/manage/retire"> = {
				installationId: config.installationId,
				targetId: config.targetId,
				registrationId: config.registrationId,
				operationId: operationId(config.targetId, config.generation, "retire"),
				generation: config.generation,
				sendCapability: config.sendCapability,
			};
			let final = false;
			let resynchronized = false;
			try {
				const result = await relayRequest(
					config,
					trust,
					"/v1/manage/retire",
					body,
					{
						signal: options.signal ?? AbortSignal.timeout(10000),
						deadlineMs: 10000,
						allowedPrivateCIDRs: options.allowedPrivateCIDRs ?? [],
						fetch: options.fetch,
					},
				);
				final =
					result.status === 200 &&
					result.body.kind === "retired" &&
					result.body.generation === config.generation;

				if (result.body.kind === "stale") {
					const statusBody: Body<"/v1/targets/status"> = {
						installationId: config.installationId,
						targetId: config.targetId,
						registrationId: config.registrationId,
						operationId: operationId(
							config.targetId,
							config.generation,
							"retirement-status",
						),
						sendCapability: config.sendCapability,
					};
					const response = await relayRequest(
						config,
						trust,
						"/v1/targets/status",
						statusBody,
						{
							signal: options.signal ?? AbortSignal.timeout(10000),
							deadlineMs: 10000,
							allowedPrivateCIDRs: options.allowedPrivateCIDRs ?? [],
							fetch: options.fetch,
						},
					);
					if (
						response.status === 200 &&
						response.body.kind === "target-status" &&
						typeof response.body.receipt === "string"
					) {
						const status = await verifyTargetStatusReceipt(
							response.body.receipt,
							trust,
							config,
							statusBody,
						);
						if (status.state === "retired") final = true;
						else if (
							status.generation > config.generation &&
							status.credentialVersion >= config.credentialVersion
						) {
							const next = {
								...config,
								generation: status.generation,
								credentialVersion: status.credentialVersion,
								fidHash: status.fidHash,
							};
							const ciphertext = encryptField(
								JSON.stringify(next),
								authorityContext(claimed),
								ring,
							);
							const updated = await client.query(
								"update native_relay_authority set config_ciphertext=$2,generation=$3,credential_version=$4,next_attempt=clock_timestamp() where id=$1 and state='retiring' and generation=$5 and config_ciphertext=$6",
								[
									claimed.id,
									ciphertext,
									next.generation,
									next.credentialVersion,
									claimed.generation,
									claimed.config_ciphertext,
								],
							);
							resynchronized = updated.rowCount === 1;
						}
					}
				}
				// An issued offer may still be submitted after an early 404. Expiry is part of the tombstone fence.
				if (
					result.status === 404 &&
					claimed.offer_expires.getTime() <= Date.now()
				)
					final = true;
			} catch {
				/* Retain sender authority until a bounded later attempt acknowledges retirement. */
			}
			if (final) {
				await client.query(
					"delete from native_relay_authority where id=$1 and generation=$2 and config_ciphertext=$3",
					[claimed.id, claimed.generation, claimed.config_ciphertext],
				);
				acknowledged++;
			} else if (!resynchronized)
				await client.query(
					"update native_relay_authority set attempts=attempts+1,next_attempt=clock_timestamp()+interval '60 seconds' where id=$1",
					[claimed.id],
				);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
	}
	return acknowledged;
}
export function startRelayRecovery(
	pool: Pool,
	ring: FieldKeyRing,
	trust: RelayConfiguration,
	allowedPrivateCIDRs: readonly Network[],
): () => void {
	let running = false;
	const controller = new AbortController();
	const tick = () => {
		if (running || controller.signal.aborted) return;
		running = true;
		void recoverRelayAuthorities(pool, ring, trust, {
			signal: controller.signal,
			allowedPrivateCIDRs,
		})
			.catch(() => console.error("native relay recovery failed"))
			.finally(() => {
				running = false;
			});
	};
	const timer = setInterval(tick, 30000);
	timer.unref();
	tick();
	return () => {
		clearInterval(timer);
		controller.abort();
	};
}
export async function backfillRelayAuthorities(
	pool: Pool,
	ring: FieldKeyRing,
	onBeforeRow?: (id: string) => Promise<void>,
): Promise<number> {
	let cursor = "",
		changed = 0;
	for (;;) {
		const ids = (
			await pool.query<{ id: string }>(
				"select id from native_relay_authority where id>$1 order by id limit 100",
				[cursor],
			)
		).rows;
		if (!ids.length) return changed;
		for (const { id: authorityId } of ids) {
			cursor = authorityId;
			await onBeforeRow?.(authorityId);
			const client = await pool.connect();
			try {
				await client.query("begin");
				const row = (
					await client.query<AuthorityRow>(
						"select * from native_relay_authority where id=$1 for update",
						[authorityId],
					)
				).rows[0];
				if (row) {
					const next = reencryptField(
						row.config_ciphertext,
						authorityContext(row),
						ring,
					);
					if (next !== row.config_ciphertext) {
						await client.query(
							"update native_relay_authority set config_ciphertext=$2 where id=$1",
							[authorityId, next],
						);
						changed++;
					}
				}
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw error;
			} finally {
				client.release();
			}
		}
	}
}
