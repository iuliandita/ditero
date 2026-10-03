import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import { taskStateToken, visibleTaskSnapshot } from "./task-observation.ts";
import type { ApiActor } from "./tokens.ts";

export function canonicalChildRow(row: Record<string, unknown>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.keys(row)
				.sort()
				.map((key) => [key, row[key]]),
		),
	);
}
const unavailable = () =>
	new PublicApiError(503, "temporarily-unavailable", "Try again shortly");

export async function observeDeletionChildren(
	client: PoolClient,
	taskId: string,
	listId: string,
) {
	const deadline = performance.now() + 5000;
	const check = () => {
		if (performance.now() >= deadline) throw unavailable();
	};
	const hash = createHash("sha256");
	const frame = (value: string) => {
		const bytes = Buffer.from(value);
		hash.update(`${bytes.length}:`);
		hash.update(bytes);
	};
	frame(JSON.stringify(["task.delete.children.v1", taskId, listId]));
	// One cursor snapshot, bounded pages, and every persisted task column. Preserve timestamp microseconds.
	await client.query(
		`declare api_deletion_children no scroll cursor for
 select to_jsonb(t) || jsonb_build_object(
 'due_at',to_char(t.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'created_at',to_char(t.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'completed_at',to_char(t.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 'recurrence_anchor_at',to_char(t.recurrence_anchor_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) as row
 from task t where t.parent_id=$1 order by t.id collate "C"`,
		[taskId],
	);
	let count = 0;
	try {
		for (;;) {
			check();
			await client.query("select set_config('statement_timeout', $1, true)", [
				`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`,
			]);
			const page = await client.query<{ row: Record<string, unknown> }>(
				"fetch forward 256 from api_deletion_children",
			);
			check();
			if (!page.rowCount) break;
			for (const { row } of page.rows) {
				check();
				if (row.list_id !== listId)
					throw new PublicApiError(
						409,
						"task-state-changed",
						"Child task scope changed",
					);
				frame(canonicalChildRow(row));
				count++;
			}
		}
		check();
		frame(JSON.stringify(count));
		return { version: 1 as const, count, token: hash.digest("hex") };
	} finally {
		// On SQL cancellation the transaction is aborted and the outer rollback closes the cursor.
		await client
			.query("close api_deletion_children")
			.catch((error: unknown) => {
				if (
					!(
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "25P02"
					)
				)
					throw error;
			});
	}
}
export async function readApiTaskDeletionObservation(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
): Promise<Response> {
	const current = await visibleTaskSnapshot(client, actor.userId, taskId);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	const childrenState = await observeDeletionChildren(
		client,
		taskId,
		current.snapshot.listId,
	);
	return apiResult({
		snapshot: current.snapshot,
		stateToken: taskStateToken(current.snapshot),
		childrenState,
	});
}
