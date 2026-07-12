import type { Pool, PoolClient } from "pg";

export async function withUserContext<T>(
	pool: Pool,
	userId: string,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	if (!userId) throw new Error("User context is required");
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query("select set_config('ditero.user_id', $1, true)", [
			userId,
		]);
		const result = await callback(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
