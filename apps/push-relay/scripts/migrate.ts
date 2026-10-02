import { readFile } from "node:fs/promises";
import { Pool } from "pg";
export async function migrate(url: string, runtimeRole: string): Promise<void> {
	if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole))
		throw new Error("Invalid runtime role");
	const pool = new Pool({ connectionString: url, max: 1 });
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(492000)");
		const role = (
			await client.query<{
				rolsuper: boolean;
				rolbypassrls: boolean;
				rolcreaterole: boolean;
				rolcreatedb: boolean;
			}>(
				"SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=$1",
				[runtimeRole],
			)
		).rows[0];
		if (!role || Object.values(role).some(Boolean))
			throw new Error(
				"Runtime role must exist without administrative privileges",
			);
		if (
			!(
				await client.query(
					"SELECT to_regclass('public.relay_schema_version') AS existing",
				)
			).rows[0].existing
		)
			await client.query(
				await readFile(
					new URL("../db/001_initial.sql", import.meta.url),
					"utf8",
				),
			);
		await client.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
		await client.query(
			`GRANT SELECT,INSERT,UPDATE,DELETE ON relay_installation,relay_target,relay_operation,relay_nonce,relay_quota TO "${runtimeRole}"`,
		);
		await client.query(
			`GRANT SELECT ON relay_schema_version TO "${runtimeRole}"`,
		);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}
if (import.meta.main) {
	const url = process.env.RELAY_MIGRATOR_DATABASE_URL;
	const role = process.env.RELAY_RUNTIME_ROLE;
	if (!url || !role)
		throw new Error(
			"RELAY_MIGRATOR_DATABASE_URL and RELAY_RUNTIME_ROLE are required",
		);
	await migrate(url, role);
	console.info("Relay migration complete");
}
