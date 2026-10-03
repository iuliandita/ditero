import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskComplete,
	canonicalApiTaskComplete,
} from "../../domain/public-api-completion.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroTaskWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { readApiResource } from "./read.ts";
import { type ApiActor, withPersonalAccessToken } from "./tokens.ts";

const query = {
	limit: 1,
	after: null,
	workspaceId: null,
	listId: null,
	done: null,
};
const borrowedDatabase = (client: PoolClient) =>
	new ZQLDatabase(
		{
			transaction: async (callback) =>
				callback(new NodePgTransactionInternal(client)),
		},
		schema,
	);

async function completeTask(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
	input: ApiTaskComplete,
	requestId: string,
	authorityHeld: boolean,
): Promise<Response> {
	const hash = createHash("sha256")
		.update(canonicalApiTaskComplete(taskId, input))
		.digest("hex");
	await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
		JSON.stringify(["public-api-task-create", actor.userId, requestId]),
	]);
	const receipt = await client.query<{ request_hash: string; task_id: string }>(
		"select request_hash,task_id from public_api_request where user_id=$1 and request_id=$2",
		[actor.userId, requestId],
	);
	if (receipt.rowCount) {
		if (receipt.rows[0].request_hash !== hash)
			throw new PublicApiError(
				409,
				"idempotency-conflict",
				"This Idempotency-Key was used for a different request",
			);
		try {
			return await readApiResource(client, actor, "tasks", query, taskId);
		} catch (error) {
			if (!(error instanceof PublicApiError) || error.status !== 404)
				throw error;
			const visible = await client.query(
				"select l.id from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2",
				[input.listId, actor.userId],
			);
			if (!visible.rowCount) throw error;
			const exists = await client.query("select id from task where id=$1", [
				taskId,
			]);
			if (exists.rowCount) throw error;
			throw new PublicApiError(
				410,
				"task-deleted",
				"The task completed by this request has been deleted",
			);
		}
	}
	if (!authorityHeld)
		throw new PublicApiError(404, "not-found", "Resource not found");
	const current = await client.query<{
		list_id: string;
		due_at: Date | null;
		kind: string;
		role: string;
	}>(
		"select t.list_id,t.due_at,l.kind,m.role from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id where t.id=$1 and m.user_id=$2",
		[taskId, actor.userId],
	);
	const task = current.rows[0];
	if (!task) throw new PublicApiError(404, "not-found", "Resource not found");
	if (task.role === "viewer")
		throw new PublicApiError(
			403,
			"forbidden",
			"This workspace role cannot complete tasks",
		);
	if (
		task.list_id !== input.listId ||
		(task.due_at?.toISOString() ?? null) !== input.expectedDueAt
	)
		throw new PublicApiError(
			409,
			"task-state-changed",
			"Read the current task before completing it",
		);
	if (task.kind === "habits")
		throw new PublicApiError(
			400,
			"habit-completion-required",
			"Habits require an occurrence completion",
		);
	await borrowedDatabase(client).transaction((tx) =>
		withZeroUserContext(tx, actor.userId, async () => {
			await mutators.task.complete.fn({
				tx,
				ctx: { id: actor.userId },
				args: { id: taskId },
			});
			await client.query(
				"insert into public_api_request (user_id,request_id,request_hash,task_id,created_at) values ($1,$2,$3,$4,statement_timestamp())",
				[actor.userId, requestId, hash, taskId],
			);
		}),
	);
	return readApiResource(client, actor, "tasks", query, taskId);
}

export async function completeApiTask(
	pool: Pool,
	token: string | null,
	taskId: string,
	input: ApiTaskComplete,
	requestId: string,
): Promise<Response> {
	let authorityHeld = false;
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		(client, actor) =>
			completeTask(client, actor, taskId, input, requestId, authorityHeld),
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			const receipt = await client.query(
				"select request_id from public_api_request where user_id=$1 and request_id=$2",
				[userId, requestId],
			);
			if (receipt.rowCount) return;
			const visible = await client.query(
				"select t.id from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id where t.id=$1 and m.user_id=$2",
				[taskId, userId],
			);
			if (!visible.rowCount) return;
			const live = await client.query(
				'select id from "user" where id=$1 and deleted_at is null',
				[userId],
			);
			if (!live.rowCount) return;
			try {
				await borrowedDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroTaskWrite(tx, userId, {
							taskIds: [taskId],
							allowViewer: true,
						}),
					),
				);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "Task is waiting for import activation"
				)
					throw new PublicApiError(
						409,
						"activation-pending",
						"Complete import activation before completing this task",
					);
				if (
					error instanceof Error &&
					/^Task activation .+ changed$/.test(error.message)
				)
					throw new PublicApiError(
						503,
						"temporarily-unavailable",
						"Try again shortly",
					);
				throw error;
			}
			authorityHeld = true;
		},
	);
}
