import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskDelete,
	canonicalApiTaskDelete,
} from "../../domain/public-api-task-deletion.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroPreferenceUser,
	lockZeroTaskDeletion,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { observeDeletionChildren } from "./deletion-observation.ts";
import { taskStateToken, visibleTaskSnapshot } from "./task-observation.ts";
import { withPersonalAccessToken } from "./tokens.ts";

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
		"This workspace role cannot delete tasks",
	);
const changed = () =>
	new PublicApiError(
		409,
		"task-state-changed",
		"Read a new deletion observation before deleting this task",
	);

async function lockOrigin(
	client: PoolClient,
	userId: string,
	listId: string,
): Promise<boolean> {
	const initial = await client.query<{ workspace_id: string }>(
		"select l.workspace_id from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2 and m.role <> 'viewer'",
		[listId, userId],
	);
	if (!initial.rowCount) return false;
	try {
		await borrowedDatabase(client).transaction((tx) =>
			withZeroUserContext(tx, userId, () => lockZeroPreferenceUser(tx, userId)),
		);
	} catch (error) {
		if (error instanceof Error && error.message === "User is no longer active")
			throw new PublicApiError(
				401,
				"unauthorized",
				"A valid personal access token is required",
			);
		throw error;
	}
	await client.query("select id from workspace where id=$1 for share", [
		initial.rows[0].workspace_id,
	]);
	const membership = await client.query<{ role: string }>(
		"select role from membership where workspace_id=$1 and user_id=$2 for share",
		[initial.rows[0].workspace_id, userId],
	);
	const list = await client.query(
		"select id from list where id=$1 and workspace_id=$2 for share",
		[listId, initial.rows[0].workspace_id],
	);
	return Boolean(
		list.rowCount &&
			membership.rowCount &&
			membership.rows[0].role !== "viewer",
	);
}

export async function deleteApiTask(
	pool: Pool,
	token: string | null,
	taskId: string,
	input: ApiTaskDelete,
	requestId: string,
): Promise<Response> {
	let authorityHeld = false;
	const receiptQuery = (client: PoolClient, userId: string) =>
		client.query<{ request_hash: string; task_id: string }>(
			"select request_hash,task_id from public_api_request where user_id=$1 and request_id=$2",
			[userId, requestId],
		);
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			const origin = await client.query<{ role: string }>(
				"select m.role from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2",
				[input.listId, actor.userId],
			);
			if (!origin.rowCount) throw notFound();
			if (origin.rows[0].role === "viewer") throw forbidden();
			if (!authorityHeld) throw notFound();
			const hash = createHash("sha256")
				.update(canonicalApiTaskDelete(taskId, input))
				.digest("hex");
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1, 0))",
				[JSON.stringify(["public-api-task-create", actor.userId, requestId])],
			);
			const receipt = await receiptQuery(client, actor.userId);
			if (receipt.rowCount) {
				if (receipt.rows[0].request_hash !== hash)
					throw new PublicApiError(
						409,
						"idempotency-conflict",
						"This Idempotency-Key was used for a different request",
					);
			} else {
				const current = await visibleTaskSnapshot(client, actor.userId, taskId);
				if (!current) throw notFound();
				if (current.role === "viewer") throw forbidden();
				if (
					current.snapshot.listId !== input.listId ||
					taskStateToken(current.snapshot) !== input.expectedState
				)
					throw changed();
				const children = await observeDeletionChildren(
					client,
					taskId,
					input.listId,
				);
				if (
					children.count !== input.expectedChildrenState.count ||
					children.token !== input.expectedChildrenState.token ||
					(!input.cascadeChildren && children.count !== 0)
				)
					throw changed();
				await borrowedDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, actor.userId, async () => {
						await mutators.task.delete.fn({
							tx,
							ctx: { id: actor.userId },
							args: { id: taskId },
						});
						await client.query(
							"insert into public_api_request(user_id,request_id,request_hash,task_id,created_at) values($1,$2,$3,$4,statement_timestamp())",
							[actor.userId, requestId, hash, taskId],
						);
					}),
				);
			}
			return apiResult({
				taskId,
				listId: input.listId,
				deleted: true,
				deletedChildren: input.expectedChildrenState.count,
			});
		},
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			if ((await receiptQuery(client, userId)).rowCount) {
				authorityHeld = await lockOrigin(client, userId, input.listId);
				return;
			}
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
						lockZeroTaskDeletion(tx, userId, taskId),
					),
				);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error) throw error;
				if (
					error instanceof Error &&
					error.message === "User is no longer active"
				)
					throw new PublicApiError(
						401,
						"unauthorized",
						"A valid personal access token is required",
					);
				if (
					error instanceof Error &&
					error.message === "access denied: need member+"
				)
					return;
				// A concurrent matching delete can commit while this request waits for its locks.
				if ((await receiptQuery(client, userId)).rowCount) {
					authorityHeld = await lockOrigin(client, userId, input.listId);
					return;
				}
				if (
					error instanceof Error &&
					(error.message === "task not found" ||
						/^Task deletion .+ changed$/.test(error.message))
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
