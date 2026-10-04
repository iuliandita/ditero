import { createHash, randomUUID } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as tables from "../../db/schema.ts";
import { parseMentions, personMatchesHandle } from "../../domain/mention.ts";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	API_COMMENT_RESPONSE_BYTES,
	type ApiCommentInput,
	type ApiCommentOperation,
	apiCommentAckSchema,
	canonicalApiCommentRequest,
} from "../../domain/public-api-comments.ts";
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
	compactCommentSnapshot,
	visibleCommentSnapshot,
} from "./comment-observation.ts";
import { taskStateToken, visibleTaskSnapshot } from "./task-observation.ts";
import { withPersonalAccessToken } from "./tokens.ts";
import type { FlushApiEvents } from "./write.ts";

const database = (client: PoolClient) =>
	new ZQLDatabase(
		{
			transaction: async (callback) =>
				callback(new NodePgTransactionInternal(client)),
		},
		schema,
	);
const missing = () =>
	new PublicApiError(404, "not-found", "Resource not found");
const forbidden = () =>
	new PublicApiError(
		403,
		"forbidden",
		"This caller cannot change this comment",
	);
const changed = () =>
	new PublicApiError(
		409,
		"comment-state-changed",
		"Read a new observation before changing this comment",
	);
const unavailable = () =>
	new PublicApiError(503, "temporarily-unavailable", "Try again shortly");
async function mentions(
	client: PoolClient,
	workspaceId: string,
	authorId: string,
	body: string,
): Promise<string[]> {
	const handles = parseMentions(body);
	if (!handles.length) return [];
	const rows = await client.query<{ id: string; name: string }>(
		`select u.id,u.name from membership m join "user" u on u.id=m.user_id where m.workspace_id=$1 and u.id<>$2 order by u.id`,
		[workspaceId, authorId],
	);
	return rows.rows
		.filter((person) =>
			handles.some((handle) => personMatchesHandle(person.name, handle)),
		)
		.map((person) => person.id)
		.sort();
}
function authorize(
	operation: ApiCommentOperation,
	role: string,
	userId: string,
	authorId: string | null,
	importedAt: string | null,
) {
	if (role === "viewer") throw forbidden();
	if (operation === "update" && (importedAt !== null || authorId !== userId))
		throw forbidden();
	if (
		operation === "delete" &&
		!(
			role === "owner" ||
			role === "admin" ||
			(importedAt === null && authorId === userId)
		)
	)
		throw forbidden();
}
type Receipt = {
	request_hash: string;
	resource_kind: string;
	comment_id: string | null;
	comment_snapshot: unknown;
};
const receiptFor = (client: PoolClient, userId: string, requestId: string) =>
	client.query<Receipt>(
		"select request_hash,resource_kind,comment_id,comment_snapshot from public_api_request where user_id=$1 and request_id=$2",
		[userId, requestId],
	);

export async function writeApiComment(
	pool: Pool,
	token: string | null,
	operation: ApiCommentOperation,
	taskId: string,
	commentId: string | null,
	input: ApiCommentInput,
	requestId: string,
	flush?: FlushApiEvents,
): Promise<Response> {
	const hash = createHash("sha256")
		.update(canonicalApiCommentRequest(operation, taskId, commentId, input))
		.digest("hex");
	const events: CollectedEvent[] = [];
	let held = false;
	let candidates: string[] = [];
	const response = await withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) =>
			withEventCollector(events, async () => {
				await client.query(
					"select pg_advisory_xact_lock(hashtextextended($1,0))",
					[JSON.stringify(["public-api-task-create", actor.userId, requestId])],
				);
				const receipt = (await receiptFor(client, actor.userId, requestId))
					.rows[0];
				let replay: ReturnType<typeof apiCommentAckSchema.parse> | null = null;
				if (receipt) {
					if (
						receipt.resource_kind !== "comment" ||
						receipt.request_hash !== hash ||
						!receipt.comment_id
					)
						throw new PublicApiError(
							409,
							"idempotency-conflict",
							"This Idempotency-Key was used for a different request",
						);
					replay = apiCommentAckSchema.parse(receipt.comment_snapshot);
					if (replay.snapshot.commentId !== receipt.comment_id)
						throw new Error("Comment receipt identity mismatch");
				}
				const workspaceId = replay?.originalWorkspaceId ?? input.workspaceId;
				const member = await client.query<{ role: string }>(
					"select role from membership where workspace_id=$1 and user_id=$2 for share",
					[workspaceId, actor.userId],
				);
				if (!member.rowCount) throw missing();
				if (replay) {
					authorize(
						operation,
						member.rows[0].role,
						actor.userId,
						replay.snapshot.authorId,
						replay.snapshot.importedAt,
					);
					return apiResult(replay);
				}
				if (member.rows[0].role === "viewer") throw forbidden();
				const task = await visibleTaskSnapshot(client, actor.userId, taskId);
				if (!task) throw missing();
				if (
					task.snapshot.workspaceId !== input.workspaceId ||
					task.snapshot.listId !== input.listId
				)
					throw changed();
				if (!held) throw missing();
				let current =
					commentId === null
						? null
						: await visibleCommentSnapshot(
								client,
								actor.userId,
								taskId,
								commentId,
							);
				if (operation === "create") {
					if (!("expectedTaskState" in input) || !("body" in input))
						throw new Error("Invalid create contract");
					if (taskStateToken(task.snapshot) !== input.expectedTaskState)
						throw changed();
					if (
						JSON.stringify(candidates) !==
						JSON.stringify(
							await mentions(
								client,
								input.workspaceId,
								actor.userId,
								input.body,
							),
						)
					)
						throw unavailable();
				} else {
					if (!current) throw missing();
					authorize(
						operation,
						current.role,
						actor.userId,
						current.snapshot.authorId,
						current.snapshot.importedAt,
					);
					if (
						!("expectedState" in input) ||
						current.stateToken !== input.expectedState
					)
						throw changed();
				}
				const id = commentId ?? randomUUID();
				await database(client).transaction((tx) =>
					withZeroUserContext(tx, actor.userId, async () => {
						if (operation === "create" && "body" in input)
							await mutators.comment.add.fn({
								tx,
								ctx: { id: actor.userId },
								args: { id, taskId, body: input.body },
							});
						else if (operation === "update" && "body" in input)
							await mutators.comment.edit.fn({
								tx,
								ctx: { id: actor.userId },
								args: { id, body: input.body },
							});
						else if (operation === "delete")
							await mutators.comment.delete.fn({
								tx,
								ctx: { id: actor.userId },
								args: { id },
							});
						else throw new Error("Invalid comment operation");
					}),
				);
				if (operation === "create") {
					const recipients: string[] = [];
					for (const collected of events) {
						if (
							collected.event.kind !== "mention" ||
							collected.event.commentId !== id ||
							collected.event.taskId !== taskId ||
							collected.event.actorUserId !== actor.userId ||
							recipients.includes(collected.recipientUserId)
						)
							throw unavailable();
						recipients.push(collected.recipientUserId);
					}
					// Native name resolution runs after insertion; refuse newly unlocked recipients.
					if (JSON.stringify(recipients.sort()) !== JSON.stringify(candidates))
						throw unavailable();
				}
				if (operation !== "delete")
					current = await visibleCommentSnapshot(
						client,
						actor.userId,
						taskId,
						id,
					);
				if (!current)
					throw new Error("Comment acknowledgment snapshot missing");
				const acknowledgment = apiCommentAckSchema.parse({
					kind: `comment-${operation}-ack`,
					originalWorkspaceId: input.workspaceId,
					originalListId: input.listId,
					originalTaskId: taskId,
					snapshot:
						operation === "delete"
							? compactCommentSnapshot(current.snapshot)
							: current.snapshot,
					...(operation === "delete" ? { deleted: true } : {}),
				});
				const encoded = JSON.stringify(acknowledgment);
				if (Buffer.byteLength(encoded, "utf8") > API_COMMENT_RESPONSE_BYTES)
					throw new PublicApiError(
						413,
						"comment-response-too-large",
						"The complete comment acknowledgment is too large",
					);
				await client.query(
					"insert into public_api_request(user_id,request_id,request_hash,resource_kind,comment_id,comment_snapshot,created_at) values($1,$2,$3,'comment',$4,$5::jsonb,statement_timestamp())",
					[actor.userId, requestId, hash, id, encoded],
				);
				return apiResult(acknowledgment);
			}),
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id',$1,true)", [
				userId,
			]);
			const lockReplay = async () => {
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
			};
			if ((await receiptFor(client, userId, requestId)).rowCount) {
				await lockReplay();
				return;
			}
			const visible = await visibleTaskSnapshot(client, userId, taskId);
			if (!visible || visible.role === "viewer") return;
			if (
				visible.snapshot.workspaceId !== input.workspaceId ||
				visible.snapshot.listId !== input.listId
			)
				return;
			if (operation === "create" && "body" in input)
				candidates = await mentions(
					client,
					input.workspaceId,
					userId,
					input.body,
				);
			try {
				await database(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroTaskWrite(tx, userId, {
							taskIds: [taskId],
							allowPending: true,
							extraUserIds: candidates,
						}),
					),
				);
				if (commentId !== null)
					await client.query(
						"select id from comment where id=$1 and task_id=$2 for update",
						[commentId, taskId],
					);
				held = true;
			} catch (error) {
				if ((await receiptFor(client, userId, requestId)).rowCount) {
					await lockReplay();
					return;
				}
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
				if (
					error instanceof Error &&
					(error.message === "task not found" ||
						error.message.startsWith("Task activation"))
				)
					throw unavailable();
				throw error;
			}
		},
	);
	// A replay and a rolled-back mutation never flush events.
	if (events.length) {
		if (flush) {
			try {
				await flush(events);
			} catch {
				console.error("public API event enqueue after commit failed");
			}
		} else await enqueueEventsSafely(drizzle(pool, { schema: tables }), events);
	}
	return response;
}
