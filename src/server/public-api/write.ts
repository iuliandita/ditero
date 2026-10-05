import { createHash, randomUUID } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as tables from "../../db/schema.ts";
import { mutatorErrorCode } from "../../domain/mutator-error.ts";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiTaskCreate,
	canonicalApiTaskCreate,
} from "../../domain/public-api-writes.ts";
import { keyBetween } from "../../domain/sort-key.ts";
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
import { readApiResource } from "./read.ts";
import { type ApiActor, withPersonalAccessToken } from "./tokens.ts";

export type FlushApiEvents = (events: CollectedEvent[]) => Promise<void>;
const TASK_QUERY = {
	limit: 1,
	after: null,
	workspaceId: null,
	listId: null,
	done: null,
};

async function prelockCreateAuthority(
	client: PoolClient,
	userId: string,
	input: ApiTaskCreate,
	requestId: string,
): Promise<boolean> {
	await client.query("select set_config('ditero.user_id', $1, true)", [userId]);
	const receipt = await client.query(
		"select request_id from public_api_request where user_id=$1 and request_id=$2",
		[userId, requestId],
	);
	if (receipt.rowCount) return false;
	const observed = await client.query<{
		id: string;
		workspace_id: string;
		owner_id: string;
	}>(
		"select l.id,l.workspace_id,l.owner_id from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2",
		[input.listId, userId],
	);
	const list = observed.rows[0];
	if (!list) return false;
	const users = [
		...new Set([userId, list.owner_id, ...input.assigneeIds]),
	].sort();
	for (const id of users) {
		const live = await client.query(
			'select id from "user" where id=$1 and deleted_at is null for update',
			[id],
		);
		if (!live.rowCount)
			throw new PublicApiError(
				id === userId ? 401 : 400,
				id === userId ? "unauthorized" : "invalid-task-references",
				id === userId
					? "A valid personal access token is required"
					: "Assignees must be active workspace members",
			);
	}
	await client.query("select id from workspace where id=$1 for share", [
		list.workspace_id,
	]);
	await client.query(
		"select id from membership where workspace_id=$1 and user_id=$2 for share",
		[list.workspace_id, userId],
	);
	const locked = await client.query<{ workspace_id: string; owner_id: string }>(
		"select workspace_id,owner_id from list where id=$1 for share",
		[list.id],
	);
	if (
		locked.rows[0]?.workspace_id !== list.workspace_id ||
		locked.rows[0]?.owner_id !== list.owner_id
	)
		throw new PublicApiError(
			503,
			"temporarily-unavailable",
			"Try again shortly",
		);
	return true;
}

// Transaction-level create core shared by PAT and list-bound webhook callers.
// The caller owns authentication, the surrounding transaction and its commit.
export async function createApiTaskTx(
	client: PoolClient,
	userId: string,
	input: ApiTaskCreate,
	requestId: string,
	requestHash: string,
	creationLocksHeld: boolean,
): Promise<{ taskId: string; replayed: boolean }> {
	await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
		JSON.stringify(["public-api-task-create", userId, requestId]),
	]);
	const receipt = await client.query<{
		request_hash: string;
		resource_kind: string;
		task_id: string | null;
	}>(
		"select request_hash, resource_kind, task_id from public_api_request where user_id=$1 and request_id=$2",
		[userId, requestId],
	);
	if (receipt.rowCount) {
		const existing = receipt.rows[0];
		if (
			existing.resource_kind !== "task" ||
			existing.task_id === null ||
			existing.request_hash !== requestHash
		)
			throw new PublicApiError(
				409,
				"idempotency-conflict",
				"This Idempotency-Key was used for a different request",
			);
		return { taskId: existing.task_id, replayed: true };
	}
	if (!creationLocksHeld)
		throw new PublicApiError(404, "not-found", "Resource not found");
	const visible = await client.query<{ role: string }>(
		"select m.role from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2",
		[input.listId, userId],
	);
	if (!visible.rowCount)
		throw new PublicApiError(404, "not-found", "Resource not found");
	if (visible.rows[0].role === "viewer")
		throw new PublicApiError(
			403,
			"forbidden",
			"This workspace role cannot create tasks",
		);
	const taskId = randomUUID();
	// withPersonalAccessToken owns the surrounding transaction and its commit.
	const database = new ZQLDatabase(
		{
			transaction: async (callback) =>
				callback(new NodePgTransactionInternal(client)),
		},
		schema,
	);
	try {
		await database.transaction((tx) =>
			withZeroUserContext(tx, userId, async () => {
				await lockZeroTaskWrite(tx, userId, {
					taskIds: [],
					targetListIds: [input.listId],
					extraUserIds: input.assigneeIds,
				});
				await client.query("select id from list where id=$1 for update", [
					input.listId,
				]);
				const last = await client.query<{ sort_key: string }>(
					'select sort_key from task where list_id=$1 and parent_id is null order by sort_key collate "C" desc limit 1',
					[input.listId],
				);
				await mutators.task.create.fn({
					tx,
					ctx: { id: userId },
					args: {
						id: taskId,
						listId: input.listId,
						title: input.title,
						sortKey: keyBetween(last.rows[0]?.sort_key ?? null, null),
						...(input.notes !== null ? { notes: input.notes } : {}),
						dueAt: input.dueAt === null ? null : Date.parse(input.dueAt),
						dueAllDay: input.dueAllDay,
						priority: input.priority,
					},
				});
				for (const assigneeId of input.assigneeIds)
					await mutators.task.assign.fn({
						tx,
						ctx: { id: userId },
						args: { taskId, userId: assigneeId },
					});
				await mutators.taskLabel.set.fn({
					tx,
					ctx: { id: userId },
					args: { taskId, labelIds: input.labelIds },
				});
				await client.query(
					"insert into public_api_request (user_id,request_id,request_hash,task_id,created_at) values ($1,$2,$3,$4,statement_timestamp())",
					[userId, requestId, requestHash, taskId],
				);
			}),
		);
	} catch (error) {
		if (mutatorErrorCode(error) === "denied")
			throw new PublicApiError(
				403,
				"forbidden",
				"This workspace role cannot create tasks",
			);
		if (
			error instanceof Error &&
			[
				"assignee not a member",
				"Task activation user authority changed",
				"label not in task workspace",
			].includes(error.message)
		)
			throw new PublicApiError(
				400,
				"invalid-task-references",
				"Assignees must be active workspace members and labels must belong to the workspace",
			);
		throw error;
	}
	return { taskId, replayed: false };
}

async function createTask(
	client: PoolClient,
	actor: ApiActor,
	input: ApiTaskCreate,
	requestId: string,
	creationLocksHeld: boolean,
): Promise<Response> {
	const requestHash = createHash("sha256")
		.update(canonicalApiTaskCreate(input))
		.digest("hex");
	const { taskId, replayed } = await createApiTaskTx(
		client,
		actor.userId,
		input,
		requestId,
		requestHash,
		creationLocksHeld,
	);
	if (!replayed) {
		const result = await readApiResource(
			client,
			actor,
			"tasks",
			TASK_QUERY,
			taskId,
		);
		return new Response(result.body, { status: 201, headers: result.headers });
	}
	try {
		return await readApiResource(client, actor, "tasks", TASK_QUERY, taskId);
	} catch (error) {
		if (!(error instanceof PublicApiError) || error.status !== 404) throw error;
		// A retained receipt cannot distinguish deletion from inaccessible content.
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
			"The task created by this request has been deleted",
		);
	}
}

export async function flushApiEvents(
	pool: Pool,
	events: CollectedEvent[],
	flush?: FlushApiEvents,
): Promise<void> {
	if (!events.length) return;
	if (flush) {
		try {
			await flush(events);
		} catch {
			console.error("public API notification enqueue after commit failed");
		}
	} else await enqueueEventsSafely(drizzle(pool, { schema: tables }), events);
}

export async function writeApiTask(
	pool: Pool,
	token: string | null,
	input: ApiTaskCreate,
	requestId: string,
	flush?: FlushApiEvents,
): Promise<Response> {
	const events: CollectedEvent[] = [];
	let creationLocksHeld = false;
	const response = await withPersonalAccessToken(
		pool,
		token,
		"write",
		(client, actor) =>
			withEventCollector(events, () =>
				createTask(client, actor, input, requestId, creationLocksHeld),
			),
		async (client, userId) => {
			creationLocksHeld = await prelockCreateAuthority(
				client,
				userId,
				input,
				requestId,
			);
		},
	);
	await flushApiEvents(pool, events, flush);
	return response;
}
