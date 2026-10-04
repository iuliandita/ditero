import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskPlacement,
	apiTaskPlacementAckSchema,
	canonicalApiTaskPlacement,
} from "../../domain/public-api-task-placement.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroTaskWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { observeDeletionChildren } from "./deletion-observation.ts";
import { listStateToken, visibleListSnapshot } from "./list-observation.ts";
import {
	taskPlacementToken,
	visibleTaskPlacement,
} from "./task-placement-observation.ts";
import { withPersonalAccessToken } from "./tokens.ts";

const database = (client: PoolClient) =>
	new ZQLDatabase(
		{
			transaction: async (callback) =>
				callback(new NodePgTransactionInternal(client)),
		},
		schema,
	);
const notFound = () =>
	new PublicApiError(404, "not-found", "Resource not found");
const forbidden = () =>
	new PublicApiError(
		403,
		"forbidden",
		"This workspace role cannot place tasks",
	);
const changed = () =>
	new PublicApiError(
		409,
		"task-state-changed",
		"Read new task and list observations before placing this task",
	);
function translate(error: unknown): never {
	if (error instanceof Error) {
		if (error.message === "Task is waiting for import activation")
			throw new PublicApiError(
				409,
				"activation-pending",
				"Complete import activation before placing this task",
			);
		if (error.message === "access denied: need member+") throw forbidden();
		if (/^Task activation .+ changed$/.test(error.message))
			throw new PublicApiError(
				503,
				"temporarily-unavailable",
				"Try again shortly",
			);
	}
	throw error;
}
export function placeApiTask(
	pool: Pool,
	token: string | null,
	taskId: string,
	input: ApiTaskPlacement,
	requestId: string,
): Promise<Response> {
	let held = false;
	let problem: PublicApiError | null = null;
	const relocation = input.listId !== input.targetListId;
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			const authority = await client.query<{ role: string }>(
				"select role from membership where workspace_id=$1 and user_id=$2 for share",
				[input.workspaceId, actor.userId],
			);
			if (!authority.rowCount) throw notFound();
			if (!["owner", "admin", "member"].includes(authority.rows[0].role))
				throw forbidden();
			const hash = createHash("sha256")
				.update(canonicalApiTaskPlacement(taskId, input))
				.digest("hex");
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1,0))",
				[JSON.stringify(["public-api-task-create", actor.userId, requestId])],
			);
			const receipt = await client.query<{
				resource_kind: string;
				task_id: string | null;
				request_hash: string;
				task_snapshot: unknown;
			}>(
				"select resource_kind,task_id,request_hash,task_snapshot from public_api_request where user_id=$1 and request_id=$2",
				[actor.userId, requestId],
			);
			if (receipt.rowCount) {
				const row = receipt.rows[0];
				if (
					row.resource_kind !== "task" ||
					row.task_id !== taskId ||
					row.request_hash !== hash ||
					row.task_snapshot === null
				)
					throw new PublicApiError(
						409,
						"idempotency-conflict",
						"This Idempotency-Key was used for a different request",
					);
				const ack = apiTaskPlacementAckSchema.parse(row.task_snapshot);
				if (
					ack.snapshot.task.taskId !== taskId ||
					ack.originalWorkspaceId !== input.workspaceId ||
					ack.originalListId !== input.listId
				)
					throw new Error("Invalid task placement receipt");
				return apiResult(ack);
			}
			if (problem) throw problem;
			if (!held) throw notFound();
			const current = await visibleTaskPlacement(client, actor.userId, taskId);
			const target = await visibleListSnapshot(
				client,
				actor.userId,
				input.targetListId,
			);
			if (!current || !target) throw notFound();
			if (
				current.snapshot.task.workspaceId !== input.workspaceId ||
				current.snapshot.task.listId !== input.listId ||
				taskPlacementToken(current.snapshot) !== input.expectedState ||
				listStateToken(target.snapshot) !== input.expectedTargetState
			)
				throw changed();
			if (
				target.snapshot.workspaceId !== input.workspaceId ||
				target.snapshot.kind !== current.snapshot.list.kind
			)
				throw new PublicApiError(
					400,
					"invalid-task-placement",
					"Task placement requires the same workspace and list kind",
				);
			if (relocation && current.snapshot.parentId !== null)
				throw new PublicApiError(
					400,
					"invalid-task-placement",
					"A subtask must stay in its parent's list",
				);
			let movedChildren = 0;
			if (relocation) {
				const children = await observeDeletionChildren(
					client,
					taskId,
					input.listId,
				);
				if (
					!input.cascadeChildren ||
					!input.expectedChildrenState ||
					children.count !== input.expectedChildrenState.count ||
					children.token !== input.expectedChildrenState.token
				)
					throw changed();
				movedChildren = children.count;
			}
			await database(client).transaction((tx) =>
				withZeroUserContext(tx, actor.userId, async () => {
					try {
						await mutators.task.move.fn({
							tx,
							ctx: { id: actor.userId },
							args: {
								id: taskId,
								listId: input.targetListId,
								sortKey: input.sortKey,
							},
						});
					} catch (error) {
						translate(error);
					}
				}),
			);
			const after = await visibleTaskPlacement(client, actor.userId, taskId);
			if (
				!after ||
				after.snapshot.task.listId !== input.targetListId ||
				after.snapshot.sortKey !== input.sortKey ||
				after.snapshot.parentId !== current.snapshot.parentId
			)
				throw new Error("Task placement postcondition failed");
			const ack = apiTaskPlacementAckSchema.parse({
				kind: "task-place-ack",
				originalWorkspaceId: input.workspaceId,
				originalListId: input.listId,
				movedChildren,
				snapshot: after.snapshot,
			});
			const encoded = JSON.stringify(ack);
			if (Buffer.byteLength(encoded) > 262144)
				throw new PublicApiError(
					413,
					"response-too-large",
					"Task placement snapshot is too large",
				);
			await client.query(
				"insert into public_api_request(user_id,request_id,request_hash,resource_kind,task_id,task_snapshot) values($1,$2,$3,'task',$4,$5::jsonb)",
				[actor.userId, requestId, hash, taskId, encoded],
			);
			return apiResult(ack);
		},
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id',$1,true)", [
				userId,
			]);
			const replay = await client.query(
				"select request_id from public_api_request where user_id=$1 and request_id=$2",
				[userId, requestId],
			);
			if (replay.rowCount) {
				await client.query(
					'select id from "user" where id=$1 and deleted_at is null for update',
					[userId],
				);
				await client.query("select id from workspace where id=$1 for share", [
					input.workspaceId,
				]);
				await client.query(
					"select id from membership where workspace_id=$1 and user_id=$2 for share",
					[input.workspaceId, userId],
				);
				return;
			}
			const current = await visibleTaskPlacement(client, userId, taskId);
			if (!current) return;
			if (current.role === "viewer") {
				problem = forbidden();
				return;
			}
			if (
				current.snapshot.task.workspaceId !== input.workspaceId ||
				current.snapshot.task.listId !== input.listId
			) {
				problem = changed();
				return;
			}
			const target = await visibleListSnapshot(
				client,
				userId,
				input.targetListId,
			);
			if (!target) {
				problem = notFound();
				return;
			}
			if (
				target.snapshot.workspaceId !== input.workspaceId ||
				target.snapshot.kind !== current.snapshot.list.kind
			) {
				problem = new PublicApiError(
					400,
					"invalid-task-placement",
					"Task placement requires the same workspace and list kind",
				);
				return;
			}
			try {
				await database(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroTaskWrite(tx, userId, {
							taskIds: [taskId],
							targetListIds: [input.targetListId],
							includeChildren: relocation,
						}),
					),
				);
				held = true;
			} catch (error) {
				try {
					translate(error);
				} catch (mapped) {
					if (!(mapped instanceof PublicApiError)) throw mapped;
					problem = mapped;
				}
			}
		},
	);
}
