import { createHash } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool, PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiListUpdate,
	apiListUpdateAckSchema,
	canonicalApiListUpdate,
} from "../../domain/public-api-list-update.ts";
import { publicApiResourceSchemas } from "../../domain/public-api-resources.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import {
	lockZeroContainerWrite,
	withZeroUserContext,
} from "../../zero/task-activation.ts";
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
		"This workspace role cannot update lists",
	);
function translateLockError(error: unknown): never {
	if (error instanceof Error) {
		if (error.message === "List is waiting for import activation")
			throw new PublicApiError(
				409,
				"activation-pending",
				"Complete import activation before updating this list",
			);
		if (error.message === "access denied: need member+") throw forbidden();
		if (error.message === "Activation container not found") throw notFound();
		if (/^Activation .+ changed$/.test(error.message))
			throw new PublicApiError(
				503,
				"temporarily-unavailable",
				"Try again shortly",
			);
	}
	throw error;
}
export function updateApiList(
	pool: Pool,
	token: string | null,
	listId: string,
	input: ApiListUpdate,
	requestId: string,
): Promise<Response> {
	let authorityHeld = false;
	let originalAuthorityHeld = false;
	// Defer authority refusals until the token is revalidated after native locks.
	let authorityProblem: PublicApiError | null = null;
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			if (authorityProblem) throw authorityProblem;
			const hash = createHash("sha256")
				.update(canonicalApiListUpdate(listId, input))
				.digest("hex");
			await client.query(
				"select pg_advisory_xact_lock(hashtextextended($1, 0))",
				[JSON.stringify(["public-api-task-create", actor.userId, requestId])],
			);
			const receipt = await client.query<{
				request_hash: string;
				resource_kind: string;
				list_id: string | null;
				list_snapshot: unknown;
			}>(
				"select request_hash,resource_kind,list_id,list_snapshot from public_api_request where user_id=$1 and request_id=$2",
				[actor.userId, requestId],
			);
			if (receipt.rowCount) {
				const stored = receipt.rows[0];
				if (stored.resource_kind !== "list" || stored.request_hash !== hash)
					throw new PublicApiError(
						409,
						"idempotency-conflict",
						"This Idempotency-Key was used for a different request",
					);
				const snapshot = publicApiResourceSchemas.lists.parse(
					stored.list_snapshot,
				);
				if (
					snapshot.id !== stored.list_id ||
					snapshot.id !== listId ||
					snapshot.workspaceId !== input.workspaceId
				)
					throw new Error("Invalid list update receipt");
				if (!authorityHeld) throw notFound();
				return apiResult(
					apiListUpdateAckSchema.parse({ kind: "list-update-ack", snapshot }),
				);
			}
			if (!originalAuthorityHeld) throw notFound();
			const current = await visibleListSnapshot(client, actor.userId, listId);
			if (!current) throw notFound();
			if (current.role === "viewer") throw forbidden();
			if (current.snapshot.workspaceId !== input.workspaceId)
				throw new PublicApiError(
					409,
					"list-state-changed",
					"Read the current list observation before updating it",
				);
			if (!authorityHeld) throw notFound();
			if (listStateToken(current.snapshot) !== input.expectedState)
				throw new PublicApiError(
					409,
					"list-state-changed",
					"Read the current list observation before updating it",
				);
			await borrowedDatabase(client).transaction((tx) =>
				withZeroUserContext(tx, actor.userId, async () => {
					try {
						await mutators.list.update.fn({
							tx,
							ctx: { id: actor.userId },
							args: { id: listId, ...input.patch },
						});
					} catch (error) {
						translateLockError(error);
					}
					const updated = await visibleListSnapshot(
						client,
						actor.userId,
						listId,
					);
					if (!updated) throw notFound();
					await client.query(
						"insert into public_api_request(user_id,request_id,request_hash,resource_kind,list_id,list_snapshot) values($1,$2,$3,'list',$4,$5::jsonb)",
						[
							actor.userId,
							requestId,
							hash,
							listId,
							JSON.stringify(updated.snapshot),
						],
					);
				}),
			);
			const updated = await visibleListSnapshot(client, actor.userId, listId);
			if (!updated) throw notFound();
			return apiResult(
				apiListUpdateAckSchema.parse({
					kind: "list-update-ack",
					snapshot: updated.snapshot,
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
			if (!["owner", "admin", "member"].includes(membership.rows[0].role)) {
				authorityProblem = forbidden();
				return;
			}
			originalAuthorityHeld = true;
			const receipt = await client.query(
				"select request_id from public_api_request where user_id=$1 and request_id=$2",
				[userId, requestId],
			);
			if (receipt.rowCount) {
				authorityHeld = true;
				return;
			}
			const current = await visibleListSnapshot(client, userId, listId);
			if (!current || current.snapshot.workspaceId !== input.workspaceId)
				return;
			if (input.patch.folderId != null) {
				const target = await client.query(
					"select id from folder where id=$1 and workspace_id=$2",
					[input.patch.folderId, input.workspaceId],
				);
				if (!target.rowCount) {
					authorityProblem = notFound();
					return;
				}
			}
			try {
				await borrowedDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, userId, () =>
						lockZeroContainerWrite(tx, userId, {
							listId,
							targetFolderId: input.patch.folderId,
							listPatch: input.patch,
						}),
					),
				);
			} catch (error) {
				try {
					translateLockError(error);
				} catch (translated) {
					if (!(translated instanceof PublicApiError)) throw translated;
					authorityProblem = translated;
				}
			}
			authorityHeld = true;
		},
	);
}
