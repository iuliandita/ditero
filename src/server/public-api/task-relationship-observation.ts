import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskRelationshipSnapshot,
	apiTaskRelationshipSnapshotSchema,
	canonicalApiTaskRelationshipSnapshot,
} from "../../domain/public-api-task-relationships.ts";
import type { ApiActor } from "./tokens.ts";
export const taskRelationshipStateToken = (
	snapshot: ApiTaskRelationshipSnapshot,
) =>
	createHash("sha256")
		.update(canonicalApiTaskRelationshipSnapshot(snapshot))
		.digest("hex");
const unavailable = () =>
	new PublicApiError(
		503,
		"relationship-evidence-unavailable",
		"The complete relationship state cannot be observed; try again shortly",
	);
export async function visibleTaskRelationships(
	client: PoolClient,
	userId: string,
	taskId: string,
): Promise<ApiTaskRelationshipSnapshot | null> {
	const deadline = performance.now() + 5000;
	const check = () => {
		if (performance.now() >= deadline) throw unavailable();
	};
	let previous: string | undefined,
		declared = false;
	let result: ApiTaskRelationshipSnapshot | null = null;
	const cleanup: unknown[] = [];
	const budget = async () => {
		check();
		await client.query("select set_config('statement_timeout',$1,true)", [
			`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`,
		]);
		check();
	};
	try {
		previous = (
			await client.query<{ timeout: string }>(
				"select current_setting('statement_timeout') as timeout",
			)
		).rows[0].timeout;
		await budget();
		// One statement snapshot covers scope and both complete sets; pages never truncate evidence.
		await client.query(
			`declare api_task_relationships no scroll cursor for
   with seat as (select t.id,t.list_id,l.workspace_id from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id where t.id=$1 and m.user_id=$2)
    , pairs as (select 'scope' as kind,s.id,s.list_id,s.workspace_id from seat s
   union all select 'assignee',a.user_id,null,null from task_assignee a join seat s on s.id=a.task_id
   union all select 'label',a.label_id,null,null from task_label a join seat s on s.id=a.task_id
   ) select * from pairs order by kind collate "C",id collate "C"`,
			[taskId, userId],
		);
		declared = true;
		check();
		let scope:
			| { id: string; list_id: string; workspace_id: string }
			| undefined;
		const assigneeIds: string[] = [],
			labelIds: string[] = [];
		let rows = 0,
			bytes = 0;
		for (;;) {
			await budget();
			const page = await client.query<{
				kind: string;
				id: string;
				list_id: string;
				workspace_id: string;
			}>("fetch forward 256 from api_task_relationships");
			check();
			if (!page.rowCount) break;
			for (const row of page.rows) {
				check();
				rows++;
				bytes += Buffer.byteLength(JSON.stringify(row));
				if (rows > 50000 || bytes > 2 * 1024 * 1024) throw unavailable();
				if (row.kind === "scope") scope = row;
				else if (row.kind === "assignee") assigneeIds.push(row.id);
				else if (row.kind === "label") labelIds.push(row.id);
				else throw new Error("Invalid relationship evidence");
			}
		}
		check();
		result = scope
			? apiTaskRelationshipSnapshotSchema.parse({
					version: 1,
					taskId: scope.id,
					listId: scope.list_id,
					workspaceId: scope.workspace_id,
					assigneeIds,
					labelIds,
				})
			: null;
		check();
	} catch (error) {
		cleanup.push(error);
	} finally {
		for (const action of [
			async () => {
				if (declared) await client.query("close api_task_relationships");
			},
			async () => {
				if (previous !== undefined)
					await client.query("select set_config('statement_timeout',$1,true)", [
						previous,
					]);
			},
		]) {
			try {
				await action();
			} catch (error) {
				if (
					!(
						cleanup.length > 0 &&
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "25P02"
					)
				)
					cleanup.push(error);
			}
		}
	}
	if (cleanup.length === 1) throw cleanup[0];
	if (cleanup.length > 1)
		throw new AggregateError(
			cleanup,
			"Relationship observation cleanup failed",
			{ cause: cleanup[0] },
		);
	return result;
}
export async function readApiTaskRelationshipObservation(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
): Promise<Response> {
	const snapshot = await visibleTaskRelationships(client, actor.userId, taskId);
	if (!snapshot)
		throw new PublicApiError(404, "not-found", "Resource not found");
	return apiResult({
		snapshot,
		stateToken: taskRelationshipStateToken(snapshot),
	});
}
