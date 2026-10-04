import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskUpdate,
	canonicalApiTaskUpdate,
} from "../../domain/public-api-task-update.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroTaskWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { readApiResource } from "./read.ts";
import { taskStateToken, visibleTaskSnapshot } from "./task-observation.ts";
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
const notFound = () =>
	new PublicApiError(404, "not-found", "Resource not found");
const forbidden = () =>
	new PublicApiError(
		403,
		"forbidden",
		"This workspace role cannot update tasks",
	);

async function updateTask(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
	input: ApiTaskUpdate,
	requestId: string,
	authorityHeld: boolean,
): Promise<Response> {
	const hash = createHash("sha256")
		.update(canonicalApiTaskUpdate(taskId, input))
		.digest("hex");
	await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
		JSON.stringify(["public-api-task-create", actor.userId, requestId]),
	]);
	const receipt = await client.query<{
		request_hash: string;
		resource_kind: string;
		task_id: string | null;
	}>(
		"select request_hash,resource_kind,task_id from public_api_request where user_id=$1 and request_id=$2",
		[actor.userId, requestId],
	);
	const current = await visibleTaskSnapshot(client, actor.userId, taskId);
	if (receipt.rowCount) {
		if (
			receipt.rows[0].resource_kind !== "task" ||
			receipt.rows[0].task_id === null ||
			receipt.rows[0].request_hash !== hash
		)
			throw new PublicApiError(
				409,
				"idempotency-conflict",
				"This Idempotency-Key was used for a different request",
			);
		if (current) {
			if (current.role === "viewer") throw forbidden();
			return readApiResource(client, actor, "tasks", query, taskId);
		}
		const origin = await client.query<{ role: string }>(
			"select m.role from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2",
			[input.listId, actor.userId],
		);
		if (!origin.rowCount) throw notFound();
		if (origin.rows[0].role === "viewer") throw forbidden();
		if (
			(await client.query("select id from task where id=$1", [taskId])).rowCount
		)
			throw notFound();
		throw new PublicApiError(
			410,
			"task-deleted",
			"The task updated by this request has been deleted",
		);
	}
	if (!current) throw notFound();
	if (current.role === "viewer") throw forbidden();
	if (!authorityHeld) throw notFound();
	if (
		current.snapshot.listId !== input.listId ||
		taskStateToken(current.snapshot) !== input.expectedState
	)
		throw new PublicApiError(
			409,
			"task-state-changed",
			"Read the current task observation before updating it",
		);
	const patch = input.patch;
	if (
		(current.snapshot.listKind === "habits" ||
			current.snapshot.rrule !== null) &&
		(patch.dueAt !== undefined || patch.dueAllDay !== undefined)
	)
		throw new PublicApiError(
			400,
			"recurrence-workflow-required",
			"Recurring tasks and habits permit metadata updates only",
		);
	const dueAt =
		patch.dueAt === undefined ? current.snapshot.dueAt : patch.dueAt;
	if ((patch.dueAllDay ?? current.snapshot.dueAllDay) && dueAt === null)
		throw new PublicApiError(
			400,
			"invalid-task",
			"All-day tasks require a due instant",
		);
	await borrowedDatabase(client).transaction((tx) =>
		withZeroUserContext(tx, actor.userId, async () => {
			const { dueAt: patchDue, ...fields } = patch;
			await mutators.task.update.fn({
				tx,
				ctx: { id: actor.userId },
				args: {
					id: taskId,
					...fields,
					...(patchDue === undefined
						? {}
						: { dueAt: patchDue === null ? null : Date.parse(patchDue) }),
				},
			});
			await client.query(
				"insert into public_api_request(user_id,request_id,request_hash,task_id,created_at) values($1,$2,$3,$4,statement_timestamp())",
				[actor.userId, requestId, hash, taskId],
			);
		}),
	);
	return readApiResource(client, actor, "tasks", query, taskId);
}

export async function updateApiTask(
	pool: Pool,
	token: string | null,
	taskId: string,
	input: ApiTaskUpdate,
	requestId: string,
): Promise<Response> {
	let authorityHeld = false;
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		(client, actor) =>
			updateTask(client, actor, taskId, input, requestId, authorityHeld),
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			const receipt = await client.query(
				"select request_id from public_api_request where user_id=$1 and request_id=$2",
				[userId, requestId],
			);
			const discovered = await visibleTaskSnapshot(client, userId, taskId);
			if (!discovered || discovered.role === "viewer") return;
			if (
				!(
					await client.query(
						'select id from "user" where id=$1 and deleted_at is null',
						[userId],
					)
				).rowCount
			)
				return;
			try {
				await borrowedDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroTaskWrite(tx, userId, {
							taskIds: [taskId],
							allowViewer: true,
							// Replays read the committed result without another mutation.
							allowPending: Boolean(receipt.rowCount),
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
						"Complete import activation before updating this task",
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
