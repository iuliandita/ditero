import type { Pool } from "pg";

const workspaceIds = ["hia-source", "hia-target"];
const userIds = [
	"hia-owner",
	"hia-author",
	"hia-viewer",
	"hia-outsider",
	"hia-writer",
];

export async function cleanupHistoryImportFixture(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query("begin");
		const parents = await client.query<{ id: string }>(
			"select id from task where list_id in (select id from list where workspace_id=any($1))",
			[workspaceIds],
		);
		const parentIds = [...workspaceIds, ...parents.rows.map((row) => row.id)];
		// Privileged fixture teardown must remove otherwise immutable replay evidence.
		await client.query("set local session_replication_role=replica");
		await client.query(
			"delete from import_history_redaction where ledger_id in (select id from import_history_ledger where target_parent_id=any($1))",
			[parentIds],
		);
		await client.query(
			"delete from import_history_ledger where target_parent_id=any($1)",
			[parentIds],
		);
		await client.query("set local session_replication_role=origin");
		await client.query("delete from template where workspace_id=any($1)", [
			workspaceIds,
		]);
		await client.query(
			"delete from task where list_id in (select id from list where workspace_id=any($1))",
			[workspaceIds],
		);
		await client.query("delete from list where workspace_id=any($1)", [
			workspaceIds,
		]);
		await client.query("delete from membership where workspace_id=any($1)", [
			workspaceIds,
		]);
		await client.query("delete from workspace where id=any($1)", [
			workspaceIds,
		]);
		await client.query('delete from "user" where id=any($1)', [userIds]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
