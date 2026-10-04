import type { Pool } from "pg";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiFolderDelete,
	canonicalApiFolderDelete,
} from "../../domain/public-api-folder.ts";
import { mutators } from "../../zero/mutators.ts";
import { withZeroUserContext } from "../../zero/task-activation.ts";
import {
	folderStateToken,
	visibleFolderSnapshot,
} from "./folder-observation.ts";
import {
	folderDatabase,
	translateFolderError,
	withFolderWrite,
} from "./folder-write.ts";
export function deleteApiFolder(
	pool: Pool,
	token: string | null,
	folderId: string,
	input: ApiFolderDelete,
	requestId: string,
): Promise<Response> {
	return withFolderWrite(
		pool,
		token,
		requestId,
		{
			workspaceId: input.workspaceId,
			folderId,
			canonical: canonicalApiFolderDelete(folderId, input),
			kind: "folder-delete-ack",
		},
		async (client, actor) => {
			const current = await visibleFolderSnapshot(
				client,
				actor.userId,
				folderId,
			);
			if (!current)
				throw new PublicApiError(404, "not-found", "Resource not found");
			if (
				current.snapshot.workspaceId !== input.workspaceId ||
				folderStateToken(current.snapshot) !== input.expectedState
			)
				throw new PublicApiError(
					409,
					"folder-state-changed",
					"Read a new observation before deleting this folder",
				);
			// The held parent update lock excludes concurrent list attachment; the native FK remains authoritative.
			if (
				(
					await client.query("select id from list where folder_id=$1 limit 1", [
						folderId,
					])
				).rowCount
			)
				throw new PublicApiError(
					409,
					"folder-not-empty",
					"Only empty folders can be deleted",
				);
			try {
				await folderDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, actor.userId, () =>
						mutators.folder.delete.fn({
							tx,
							ctx: { id: actor.userId },
							args: { id: folderId },
						}),
					),
				);
			} catch (error) {
				translateFolderError(error);
			}
			return current.snapshot;
		},
	);
}
