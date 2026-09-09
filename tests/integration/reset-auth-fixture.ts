import type { Pool } from "pg";

// Integration files share one serial database, but Vitest may reorder files by
// their recorded duration. Truncating the user root with CASCADE clears every
// user-owned auth and domain row without encoding the full FK graph here.
export async function resetAuthFixture(pool: Pool): Promise<void> {
	await pool.query('truncate table "user" cascade');
	await pool.query("truncate table rate_limit, verification");
}
