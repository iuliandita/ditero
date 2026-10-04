import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import { canonicalApiFolderSnapshot } from "../../domain/public-api-folder.ts";
import { publicApiResourceSchemas } from "../../domain/public-api-resources.ts";
import type { ApiActor } from "./tokens.ts";
export const folderStateToken = (
	snapshot: Parameters<typeof canonicalApiFolderSnapshot>[0],
) =>
	createHash("sha256")
		.update(canonicalApiFolderSnapshot(snapshot))
		.digest("hex");
export async function visibleFolderSnapshot(
	client: PoolClient,
	userId: string,
	folderId: string,
) {
	const result = await client.query(
		'select f.id,f.workspace_id as "workspaceId",f.name,f.sort_key as "sortKey",m.role from folder f join membership m on m.workspace_id=f.workspace_id where f.id=$1 and m.user_id=$2',
		[folderId, userId],
	);
	if (!result.rowCount) return null;
	const { role, ...snapshot } = result.rows[0];
	return { role, snapshot: publicApiResourceSchemas.folders.parse(snapshot) };
}
export async function readApiFolderObservation(
	client: PoolClient,
	actor: ApiActor,
	folderId: string,
): Promise<Response> {
	const current = await visibleFolderSnapshot(client, actor.userId, folderId);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	return apiResult({
		snapshot: current.snapshot,
		stateToken: folderStateToken(current.snapshot),
	});
}
