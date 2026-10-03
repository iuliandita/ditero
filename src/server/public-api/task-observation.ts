import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskSnapshot,
	apiTaskSnapshotSchema,
	canonicalApiTaskSnapshot,
} from "../../domain/public-api-task-update.ts";
import type { ApiActor } from "./tokens.ts";

export function taskStateToken(snapshot: ApiTaskSnapshot): string {
	return createHash("sha256")
		.update(canonicalApiTaskSnapshot(snapshot))
		.digest("hex");
}

export async function visibleTaskSnapshot(
	client: PoolClient,
	userId: string,
	taskId: string,
): Promise<{ snapshot: ApiTaskSnapshot; role: string } | null> {
	const result = await client.query(
		`select 1 as version,t.id as "taskId",t.list_id as "listId",l.workspace_id as "workspaceId",
		 t.title,t.notes,t.due_at as "dueAt",t.due_all_day as "dueAllDay",t.priority,
		 t.created_at as "createdAt",t.done,t.completed_at as "completedAt",l.kind as "listKind",t.rrule,
		 t.recurrence_relative as "recurrenceRelative",t.recurrence_anchor_at as "recurrenceAnchorAt",
		 t.recurrence_consumed as "recurrenceConsumed",m.role
		 from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id
		 where t.id=$1 and m.user_id=$2`,
		[taskId, userId],
	);
	const row = result.rows[0];
	if (!row) return null;
	const { role, ...fields } = row;
	return {
		role,
		snapshot: apiTaskSnapshotSchema.parse(JSON.parse(JSON.stringify(fields))),
	};
}

export async function readApiTaskObservation(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
): Promise<Response> {
	const current = await visibleTaskSnapshot(client, actor.userId, taskId);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	return apiResult({
		snapshot: current.snapshot,
		stateToken: taskStateToken(current.snapshot),
	});
}
