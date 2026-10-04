import { createHash, randomUUID } from "node:crypto";
import { ZQLDatabase } from "@rocicorp/zero/server";
import { NodePgTransactionInternal } from "@rocicorp/zero/server/adapters/pg";
import type { Pool } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiListCreate,
	apiListCreationAckSchema,
	canonicalApiListCreate,
} from "../../domain/public-api-list-create.ts";
import { publicApiResourceSchemas } from "../../domain/public-api-resources.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { withZeroUserContext } from "../../zero/task-activation.ts";
import { withPersonalAccessToken } from "./tokens.ts";

export function writeApiList(
	pool: Pool,
	token: string | null,
	input: ApiListCreate,
	requestId: string,
): Promise<Response> {
	return withPersonalAccessToken(
		pool,
		token,
		"write",
		async (client, actor) => {
			const workspace = await client.query(
				"select id from workspace where id=$1 for update",
				[input.workspaceId],
			);
			const membership = await client.query<{ role: string }>(
				"select role from membership where workspace_id=$1 and user_id=$2 for share",
				[input.workspaceId, actor.userId],
			);
			if (!workspace.rowCount || !membership.rowCount)
				throw new PublicApiError(404, "not-found", "Resource not found");
			if (!["owner", "admin", "member"].includes(membership.rows[0].role))
				throw new PublicApiError(
					403,
					"forbidden",
					"This workspace role cannot create lists",
				);
			const hash = createHash("sha256")
				.update(canonicalApiListCreate(input))
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
					snapshot.workspaceId !== input.workspaceId
				)
					throw new Error("Invalid list creation receipt");
				return apiResult(
					apiListCreationAckSchema.parse({ kind: "list-create-ack", snapshot }),
				);
			}
			const id = randomUUID();
			const last = await client.query<{ sort_key: string }>(
				'select sort_key from list where workspace_id=$1 and folder_id is null order by sort_key collate "C" desc limit 1',
				[input.workspaceId],
			);
			const database = new ZQLDatabase(
				{
					transaction: async (callback) =>
						callback(new NodePgTransactionInternal(client)),
				},
				schema,
			);
			await database.transaction((tx) =>
				withZeroUserContext(tx, actor.userId, () =>
					mutators.list.create.fn({
						tx,
						ctx: { id: actor.userId },
						args: {
							id,
							workspaceId: input.workspaceId,
							title: input.title,
							kind: input.kind,
							sortKey: keyBetween(last.rows[0]?.sort_key ?? null, null),
							...(input.icon !== null ? { icon: input.icon } : {}),
						},
					}),
				),
			);
			const created = await client.query(
				`select id,workspace_id as "workspaceId",owner_id as "ownerId",title,kind,icon,
			folder_id as "folderId",sort_key as "sortKey",completed_display as "completedDisplay"
			from list where id=$1`,
				[id],
			);
			const snapshot = publicApiResourceSchemas.lists.parse(created.rows[0]);
			const ack = apiListCreationAckSchema.parse({
				kind: "list-create-ack",
				snapshot,
			});
			await client.query(
				"insert into public_api_request(user_id,request_id,request_hash,resource_kind,list_id,list_snapshot) values($1,$2,$3,'list',$4,$5::jsonb)",
				[actor.userId, requestId, hash, id, JSON.stringify(snapshot)],
			);
			return apiResult(ack, null, 201);
		},
	);
}
