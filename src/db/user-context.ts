import type { Pool, PoolClient } from "pg";

export class UserContextError extends Error {
	constructor() {
		super("User is no longer active");
		this.name = "UserContextError";
	}
}

/** Hold account deletion until the write commits, or reject its tombstone. */
export async function withLiveUserContext<T>(
	pool: Pool,
	userId: string,
	callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
	return withUserContext(pool, userId, async (client) => {
		const live = await client.query(
			'select id from "user" where id = $1 and deleted_at is null for key share',
			[userId],
		);
		if (live.rowCount !== 1) throw new UserContextError();
		return callback(client);
	});
}

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
