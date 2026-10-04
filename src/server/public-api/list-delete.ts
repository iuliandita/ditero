import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiListDelete,
	apiListDeleteAckSchema,
	canonicalApiListDelete,
} from "../../domain/public-api-list-deletion.ts";
import {
	type ApiList,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroContainerWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
import { observeDeletionTasks } from "./list-deletion-observation.ts";
import { listStateToken, visibleListSnapshot } from "./list-observation.ts";
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
		"Only the list creator, Admin or Owner may delete this list",
	);
const changed = () =>
	new PublicApiError(
		409,
		"list-state-changed",
		"Read a new deletion observation before deleting this list",
	);
const mayDelete = (role: string, ownerId: string, actor: string) =>
	role === "owner" ||
	role === "admin" ||
	(role === "member" && ownerId === actor);
type Receipt = {
	request_hash: string;
	resource_kind: string;
	list_id: string | null;
	list_snapshot: unknown;
};
const receiptQuery = (client: PoolClient, actor: string, key: string) =>
	client.query<Receipt>(
		"select request_hash,resource_kind,list_id,list_snapshot from public_api_request where user_id=$1 and request_id=$2",
		[actor, key],
	);

export function deleteApiList(
	pool: Pool,
	token: string | null,
	listId: string,
	input: ApiListDelete,
	requestId: string,
): Promise<Response> {
	let authorityProblem: PublicApiError | null = null;
	let membershipRole: string | null = null;
	let locked = false;
	const hash = createHash("sha256")
		.update(canonicalApiListDelete(listId, input))
		.digest("hex");
	const storedSnapshot = (receipt: Receipt): ApiList => {
		if (receipt.resource_kind !== "list" || receipt.request_hash !== hash)
			throw new PublicApiError(
				409,
				"idempotency-conflict",
				"This Idempotency-Key was used for a different request",
			);
		const snapshot = publicApiResourceSchemas.lists.parse(
			receipt.list_snapshot,
		);
		if (
			receipt.list_id !== listId ||
			snapshot.id !== listId ||
			snapshot.workspaceId !== input.workspaceId
		)
			throw new Error("Invalid list deletion receipt");
		return snapshot;
	};
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			if (authorityProblem) throw authorityProblem;
			if (!membershipRole) throw notFound();
			const receipt = await receiptQuery(client, actor.userId, requestId);
			if (receipt.rowCount) {
				const snapshot = storedSnapshot(receipt.rows[0]);
				if (!mayDelete(membershipRole, snapshot.ownerId, actor.userId))
					throw forbidden();
				return apiResult(
					apiListDeleteAckSchema.parse({
						kind: "list-delete-ack",
						snapshot,
						deletedTasks: input.expectedTasksState.count,
					}),
				);
			}
			if (!locked) throw notFound();
			const current = await visibleListSnapshot(client, actor.userId, listId);
			if (!current) throw notFound();
			if (!mayDelete(current.role, current.snapshot.ownerId, actor.userId))
				throw forbidden();
			if (
				current.snapshot.workspaceId !== input.workspaceId ||
				listStateToken(current.snapshot) !== input.expectedState
			)
				throw changed();
			const tasks = await observeDeletionTasks(client, listId);
			if (
				tasks.count !== input.expectedTasksState.count ||
				tasks.token !== input.expectedTasksState.token ||
				(!input.cascadeTasks && tasks.count !== 0)
			)
				throw changed();
			await borrowedDatabase(client).transaction((tx) =>
				withZeroUserContext(tx, actor.userId, async () => {
					await mutators.list.delete.fn({
						tx,
						ctx: { id: actor.userId },
						args: { id: listId },
					});
					await client.query(
						"insert into public_api_request(user_id,request_id,request_hash,resource_kind,list_id,list_snapshot) values($1,$2,$3,'list',$4,$5::jsonb)",
						[
							actor.userId,
							requestId,
							hash,
							listId,
							JSON.stringify(current.snapshot),
						],
					);
				}),
			);
			return apiResult(
				apiListDeleteAckSchema.parse({
					kind: "list-delete-ack",
					snapshot: current.snapshot,
					deletedTasks: tasks.count,
				}),
			);
		},
		async (client, userId) => {
			await client.query("select set_config('ditero.user_id', $1, true)", [
				userId,
			]);
			const live = await client.query(
				'select id from "user" where id=$1 and deleted_at is null for update',
				[userId],
			);
			if (!live.rowCount) return;
			const workspace = await client.query(
				"select id from workspace where id=$1 for share",
				[input.workspaceId],
			);
			const membership = await client.query<{ role: string }>(
				"select role from membership where workspace_id=$1 and user_id=$2 for share",
				[input.workspaceId, userId],
			);
			if (!workspace.rowCount || !membership.rowCount) return;
			membershipRole = membership.rows[0].role;
			// All task and list writes share one account-scoped UUID namespace.
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1, 0))",
				[JSON.stringify(["public-api-task-create", userId, requestId])],
			);
			if ((await receiptQuery(client, userId, requestId)).rowCount) return;
			if (membershipRole === "viewer") {
				authorityProblem = forbidden();
				return;
			}
			const current = await visibleListSnapshot(client, userId, listId);
			if (!current || current.snapshot.workspaceId !== input.workspaceId)
				return;
			try {
				await borrowedDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroContainerWrite(tx, userId, {
							listId,
							allowPending: true,
							deleteTasks: true,
						}),
					),
				);
				locked = true;
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				if (error.message === "access denied: need member+")
					authorityProblem = forbidden();
				else if (error.message === "Activation container not found")
					authorityProblem = notFound();
				else if (/^Activation .+ changed$/.test(error.message))
					authorityProblem = new PublicApiError(
						503,
						"temporarily-unavailable",
						"Try again shortly",
					);
				else throw error;
			}
		},
	);
}
