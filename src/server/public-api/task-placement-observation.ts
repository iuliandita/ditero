import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	apiTaskPlacementSnapshotSchema,
	canonicalApiTaskPlacementSnapshot,
} from "../../domain/public-api-task-placement.ts";
import { observeDeletionChildren } from "./deletion-observation.ts";
import { visibleListSnapshot } from "./list-observation.ts";
import { visibleTaskSnapshot } from "./task-observation.ts";
import type { ApiActor } from "./tokens.ts";

export async function visibleTaskPlacement(
	client: PoolClient,
	userId: string,
	taskId: string,
) {
	const task = await visibleTaskSnapshot(client, userId, taskId);
	if (!task) return null;
	const list = await visibleListSnapshot(client, userId, task.snapshot.listId);
	const placement = await client.query<{
		sortKey: string;
		parentId: string | null;
	}>(
		`select sort_key as "sortKey",parent_id as "parentId" from task where id=$1`,
		[taskId],
	);
	if (!list || !placement.rowCount) return null;
	return {
		role: task.role,
		snapshot: apiTaskPlacementSnapshotSchema.parse({
			version: 1,
			task: task.snapshot,
			...placement.rows[0],
			list: list.snapshot,
		}),
	};
}
export function taskPlacementToken(
	snapshot: Parameters<typeof canonicalApiTaskPlacementSnapshot>[0],
) {
	return createHash("sha256")
		.update(canonicalApiTaskPlacementSnapshot(snapshot))
		.digest("hex");
}
export async function readApiTaskPlacementObservation(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
) {
	const current = await visibleTaskPlacement(client, actor.userId, taskId);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	const childrenState = await observeDeletionChildren(
		client,
		taskId,
		current.snapshot.task.listId,
	);
	return apiResult({
		snapshot: current.snapshot,
		stateToken: taskPlacementToken(current.snapshot),
		childrenState,
	});
}
