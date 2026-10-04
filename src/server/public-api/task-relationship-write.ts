import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as tables from "../../db/schema.ts";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskRelationships,
	canonicalApiTaskRelationshipSnapshot,
	canonicalApiTaskRelationships,
	taskRelationshipsAck,
} from "../../domain/public-api-task-relationships.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroTaskWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import {
	type CollectedEvent,
	enqueueEventsSafely,
	withEventCollector,
} from "../notifications/events.ts";
import {
	taskRelationshipStateToken,
	visibleTaskRelationships,
} from "./task-relationship-observation.ts";
import { withPersonalAccessToken } from "./tokens.ts";
import type { FlushApiEvents } from "./write.ts";
export const relationshipDatabase = (client: PoolClient) =>
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
		"This workspace role cannot edit task relationships",
	);
const changed = () =>
	new PublicApiError(
		409,
		"task-relationships-changed",
		"Read a new relationship observation before editing",
	);
const invalid = () =>
	new PublicApiError(
		400,
		"invalid-task-references",
		"Assignees must be active workspace members and labels must belong to the workspace",
	);
function translate(error: unknown): never {
	if (error instanceof Error) {
		if (error.message === "Task activation evidence exceeds import limit")
			throw new PublicApiError(
				503,
				"relationship-evidence-unavailable",
				"The complete relationship state exceeds supported evidence bounds",
			);
		if (error.message === "Task is waiting for import activation")
			throw new PublicApiError(
				409,
				"activation-pending",
				"Complete import activation before editing assignments",
			);
		if (error.message === "access denied: need member+") throw forbidden();
		if (
			error.message === "task not found" ||
			error.message === "list not found"
		)
			throw notFound();
		if (
			error.message === "assignee not a member" ||
			error.message === "Task activation user authority changed" ||
			error.message === "label not in task workspace"
		)
			throw invalid();
		if (/^Task activation .+ changed$/.test(error.message))
			throw new PublicApiError(
				503,
				"temporarily-unavailable",
				"Try again shortly",
			);
	}
	throw error;
}
export async function writeApiTaskRelationships(
	pool: Pool,
	token: string | null,
	taskId: string,
	input: ApiTaskRelationships,
	requestId: string,
	flush?: FlushApiEvents,
): Promise<Response> {
	const hash = createHash("sha256")
		.update(canonicalApiTaskRelationships(taskId, input))
		.digest("hex");
	const events: CollectedEvent[] = [];
	let problem: PublicApiError | null = null,
		held = false;
	const response = await withPersonalAccessToken(
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
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1,0))",
				[JSON.stringify(["public-api-task-create", actor.userId, requestId])],
			);
			const receipt = await client.query<{
				resource_kind: string;
				request_hash: string;
				task_id: string | null;
			}>(
				"select resource_kind,request_hash,task_id from public_api_request where user_id=$1 and request_id=$2",
				[actor.userId, requestId],
			);
			if (receipt.rowCount) {
				const stored = receipt.rows[0];
				if (
					stored.resource_kind !== "task" ||
					stored.request_hash !== hash ||
					stored.task_id !== taskId
				)
					throw new PublicApiError(
						409,
						"idempotency-conflict",
						"This Idempotency-Key was used for a different request",
					);
				return apiResult(taskRelationshipsAck(taskId, input));
			}
			if (problem) throw problem;
			if (!held) throw notFound();
			const current = await visibleTaskRelationships(
				client,
				actor.userId,
				taskId,
			);
			if (!current) throw notFound();
			if (
				current.workspaceId !== input.workspaceId ||
				current.listId !== input.listId ||
				taskRelationshipStateToken(current) !== input.expectedState
			)
				throw new PublicApiError(
					409,
					"task-relationships-changed",
					"Read a new relationship observation before editing",
				);
			for (const userId of input.assigneeIds) {
				if (
					!(
						await client.query(
							"select id from membership where workspace_id=$1 and user_id=$2 for share",
							[input.workspaceId, userId],
						)
					).rowCount
				)
					throw invalid();
			}
			for (const labelId of [
				...new Set([...current.labelIds, ...input.labelIds]),
			].sort()) {
				const label = await client.query<{ workspace_id: string }>(
					"select workspace_id from label where id=$1 for share",
					[labelId],
				);
				if (!label.rowCount || label.rows[0].workspace_id !== input.workspaceId)
					throw invalid();
			}
			await withEventCollector(events, () =>
				relationshipDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, actor.userId, async () => {
						try {
							for (const userId of current.assigneeIds)
								if (!input.assigneeIds.includes(userId))
									await mutators.task.unassign.fn({
										tx,
										ctx: { id: actor.userId },
										args: { taskId, userId },
									});
							for (const userId of input.assigneeIds)
								if (!current.assigneeIds.includes(userId))
									await mutators.task.assign.fn({
										tx,
										ctx: { id: actor.userId },
										args: { taskId, userId },
									});
							await mutators.taskLabel.set.fn({
								tx,
								ctx: { id: actor.userId },
								args: { taskId, labelIds: input.labelIds },
							});
						} catch (error) {
							translate(error);
						}
						const after = await visibleTaskRelationships(
							client,
							actor.userId,
							taskId,
						);
						const desired = taskRelationshipsAck(taskId, input);
						if (
							!after ||
							canonicalApiTaskRelationshipSnapshot(after) !==
								canonicalApiTaskRelationshipSnapshot(desired.snapshot)
						)
							throw new Error("Relationship mutation result changed");
						await client.query(
							"insert into public_api_request(user_id,request_id,request_hash,resource_kind,task_id) values($1,$2,$3,'task',$4)",
							[actor.userId, requestId, hash, taskId],
						);
					}),
				),
			);
			return apiResult(taskRelationshipsAck(taskId, input));
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
			const visible = await client.query<{
				role: string;
				list_id: string;
				workspace_id: string;
			}>(
				"select m.role,t.list_id,l.workspace_id from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id where t.id=$1 and m.user_id=$2",
				[taskId, userId],
			);
			if (!visible.rowCount) return;
			if (!["owner", "admin", "member"].includes(visible.rows[0].role)) {
				problem = forbidden();
				return;
			}
			if (
				visible.rows[0].list_id !== input.listId ||
				visible.rows[0].workspace_id !== input.workspaceId
			) {
				problem = changed();
				return;
			}
			try {
				await relationshipDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroTaskWrite(tx, userId, {
							taskIds: [taskId],
							extraUserIds: input.assigneeIds,
						}),
					),
				);
				const scope = await client.query<{
					list_id: string;
					workspace_id: string;
				}>(
					"select t.list_id,l.workspace_id from task t join list l on l.id=t.list_id where t.id=$1",
					[taskId],
				);
				if (
					!scope.rowCount ||
					scope.rows[0].list_id !== input.listId ||
					scope.rows[0].workspace_id !== input.workspaceId
				) {
					problem = changed();
					return;
				}
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
	if (events.length) {
		if (flush) {
			try {
				await flush(events);
			} catch {
				console.error("public API notification enqueue after commit failed");
			}
		} else await enqueueEventsSafely(drizzle(pool, { schema: tables }), events);
	}
	return response;
}
