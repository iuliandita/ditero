import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import { canonicalApiListSnapshot } from "../../domain/public-api-list-update.ts";
import {
	type ApiList,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
import type { ApiActor } from "./tokens.ts";

export function listStateToken(snapshot: ApiList): string {
	return createHash("sha256")
		.update(canonicalApiListSnapshot(snapshot))
		.digest("hex");
}
export async function visibleListSnapshot(
	client: PoolClient,
	userId: string,
	listId: string,
): Promise<{ snapshot: ApiList; role: string } | null> {
	const result = await client.query(
		`select l.id,l.workspace_id as "workspaceId",l.owner_id as "ownerId",l.title,l.kind,l.icon,
 l.folder_id as "folderId",l.sort_key as "sortKey",l.completed_display as "completedDisplay",m.role
 from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2`,
		[listId, userId],
	);
	const row = result.rows[0];
	if (!row) return null;
	const { role, ...snapshot } = row;
	return { role, snapshot: publicApiResourceSchemas.lists.parse(snapshot) };
}
export async function readApiListObservation(
	client: PoolClient,
	actor: ApiActor,
	listId: string,
): Promise<Response> {
	const current = await visibleListSnapshot(client, actor.userId, listId);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	return apiResult({
		snapshot: current.snapshot,
		stateToken: listStateToken(current.snapshot),
	});
}
