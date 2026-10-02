import { Pool, type PoolClient } from "pg";
import type { Body, Outcome, Path, PublicKey } from "./contracts.ts";
import { RelayError } from "./contracts.ts";
export type Installation = {
	id: string;
	device_key: PublicKey;
	device_thumbprint: string;
};
export type Target = {
	id: string;
	registration_id: string;
	installation_id: string;
	offer_id: string;
	offer_expires: Date;
	sender_key: PublicKey;
	sender_thumbprint: string;
	send_hash: string;
	management_hash: string;
	credential_version: number;
	generation: number;
	state: "issued" | "confirmed" | "retired";
	fid_encrypted: string;
	challenge_encrypted: string | null;
	pending_fid: string | null;
	pending_management_hash: string | null;
	pending_challenge: string | null;
	pending_expires: Date | null;
	pending_operation_id: string | null;
	receipt: string | null;
};
export type Operation = {
	id: string;
	installation_id: string;
	target_id: string;
	path: Path;
	digest: string;
	authority_hash: string;
	outcome: Outcome | null;
};
export class Store {
	readonly pool: Pool;
	readonly quotaPool: Pool;
	constructor(url: string) {
		this.pool = new Pool({
			connectionString: url,
			max: 10,
			connectionTimeoutMillis: 2000,
			statement_timeout: 10000,
			lock_timeout: 2000,
		});
		this.quotaPool = new Pool({
			connectionString: url,
			max: 2,
			connectionTimeoutMillis: 2000,
			statement_timeout: 2000,
			lock_timeout: 2000,
		});
	}
	async ready(): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const query = {
				text: "SELECT version FROM relay_schema_version",
				query_timeout: 1000,
			};
			const result = await Promise.race([
				this.pool.query<{ version: number }>(query),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("readiness timeout")),
						2000,
					);
				}),
			]);
			return result.rows.length === 1 && result.rows[0].version === 1;
		} catch {
			return false;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async assertRuntimeAuthority(): Promise<void> {
		const result = await this.pool.query<{ unsafe: boolean }>(
			`SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR has_schema_privilege(current_user,'public','CREATE') OR has_database_privilege(current_user,current_database(),'CREATE') OR has_table_privilege(current_user,'relay_schema_version','INSERT,UPDATE,DELETE') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid)) AS unsafe FROM pg_roles r WHERE r.rolname=current_user`,
		);
		if (result.rows[0]?.unsafe !== false)
			throw new Error("Relay runtime database authority is excessive");
		const version = await this.pool.query(
			"SELECT version FROM relay_schema_version",
		);
		if (version.rows.length !== 1 || version.rows[0].version !== 1)
			throw new Error("Relay schema is unsupported");
	}
	async transaction<T>(
		work: (client: PoolClient) => Promise<T>,
		signal?: AbortSignal,
		pool: Pool = this.pool,
	): Promise<T> {
		signal?.throwIfAborted();
		const client = await pool.connect();
		try {
			signal?.throwIfAborted();
			await client.query("BEGIN");
			await client.query("SET LOCAL statement_timeout='10s'");
			await client.query("SET LOCAL lock_timeout='2s'");
			const result = await work(client);
			signal?.throwIfAborted();
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}
	async lock(
		client: PoolClient,
		installationId: string,
		registrationId: string,
	): Promise<{ installation: Installation; target: Target }> {
		const installation = (
			await client.query<Installation>(
				"SELECT * FROM relay_installation WHERE id=$1 FOR UPDATE",
				[installationId],
			)
		).rows[0];
		if (!installation) throw new RelayError(404, "not_found");
		const target = (
			await client.query<Target>(
				"SELECT * FROM relay_target WHERE id=$1 AND installation_id=$2 FOR UPDATE",
				[registrationId, installationId],
			)
		).rows[0];
		if (!target) throw new RelayError(404, "not_found");
		return { installation, target };
	}
	async operation(
		client: PoolClient,
		body: Body,
		path: Path,
		digest: string,
		authority: string,
	): Promise<Operation> {
		await client.query(
			"INSERT INTO relay_operation(id,installation_id,target_id,path,digest,authority_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
			[
				body.operationId,
				body.installationId,
				body.targetId,
				path,
				digest,
				authority,
			],
		);
		const operation = (
			await client.query<Operation>(
				"SELECT * FROM relay_operation WHERE id=$1 FOR UPDATE",
				[body.operationId],
			)
		).rows[0];
		if (
			!operation ||
			operation.target_id !== body.targetId ||
			operation.installation_id !== body.installationId ||
			operation.path !== path ||
			operation.digest !== digest ||
			operation.authority_hash !== authority
		)
			throw new RelayError(409, "operation_conflict");
		return operation;
	}
	async finish(
		client: PoolClient,
		operation: Operation,
		outcome: Outcome,
	): Promise<Outcome> {
		await client.query("UPDATE relay_operation SET outcome=$2 WHERE id=$1", [
			operation.id,
			outcome,
		]);
		return outcome;
	}
	async admit(client: PoolClient, targetId: string, path: Path): Promise<void> {
		if (path === "/v1/manage/retire") return;
		const count = Number(
			(
				await client.query<{ count: string }>(
					"SELECT count(*) FROM relay_operation WHERE target_id=$1",
					[targetId],
				)
			).rows[0].count,
		);
		if (count >= 2048) throw new RelayError(429, "operation_capacity");
	}
	async nonce(
		client: PoolClient,
		proof: { key: string; nonce: string },
		operationId: string,
		digest: string,
		record = true,
	): Promise<void> {
		if (record)
			await client.query(
				"INSERT INTO relay_nonce(key_thumbprint,nonce,operation_id,digest,expires_at) VALUES($1,$2,$3,$4,now()+interval '65 seconds') ON CONFLICT DO NOTHING",
				[proof.key, proof.nonce, operationId, digest],
			);
		const saved = (
			await client.query<{ operation_id: string; digest: string }>(
				"SELECT operation_id,digest FROM relay_nonce WHERE key_thumbprint=$1 AND nonce=$2",
				[proof.key, proof.nonce],
			)
		).rows[0];
		if (
			saved &&
			(saved.operation_id !== operationId || saved.digest !== digest)
		)
			throw new RelayError(409, "proof_replayed");
	}
	// Separate committed quota reservations survive transaction rollback after provider attempts.
	async quota(
		keys: { key: string; seconds: number; limit: number }[],
	): Promise<boolean> {
		return this.transaction(
			async (client) => {
				const sorted = [...keys].sort((a, b) => a.key.localeCompare(b.key));
				for (const item of sorted)
					await client.query(
						"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
						[item.key],
					);
				for (const item of sorted) {
					const result = await client.query<{ count: number }>(
						"SELECT count FROM relay_quota WHERE key=$1 AND window_start > now()-($2*interval '1 second')",
						[item.key, item.seconds],
					);
					if ((result.rows[0]?.count ?? 0) >= item.limit) return false;
				}
				for (const item of sorted)
					await client.query(
						"INSERT INTO relay_quota(key,window_start,count) VALUES($1,now(),1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN relay_quota.window_start <= now()-($2*interval '1 second') THEN 1 ELSE relay_quota.count+1 END,window_start=CASE WHEN relay_quota.window_start <= now()-($2*interval '1 second') THEN now() ELSE relay_quota.window_start END",
						[item.key, item.seconds],
					);
				return true;
			},
			undefined,
			this.quotaPool,
		);
	}
	async retireInstallation(
		client: PoolClient,
		installationId: string,
	): Promise<void> {
		await client.query(
			"UPDATE relay_target SET state='retired',retired_at=now(),challenge_encrypted=NULL,pending_fid=NULL,pending_management_hash=NULL,pending_challenge=NULL,pending_expires=NULL,pending_operation_id=NULL WHERE installation_id=$1",
			[installationId],
		);
	}
	async close(): Promise<void> {
		await Promise.all([this.pool.end(), this.quotaPool.end()]);
	}
}
