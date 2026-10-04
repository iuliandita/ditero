import type { Pool } from "pg";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiFolderUpdate,
	canonicalApiFolderUpdate,
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
export function updateApiFolder(
	pool: Pool,
	token: string | null,
	folderId: string,
	input: ApiFolderUpdate,
	requestId: string,
): Promise<Response> {
	return withFolderWrite(
		pool,
		token,
		requestId,
		{
			workspaceId: input.workspaceId,
			folderId,
			canonical: canonicalApiFolderUpdate(folderId, input),
			kind: "folder-update-ack",
			patch: input.patch,
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
					"Read a new observation before renaming this folder",
				);
			try {
				await folderDatabase(client).transaction((tx) =>
					withZeroUserContext(tx, actor.userId, () =>
						mutators.folder.update.fn({
							tx,
							ctx: { id: actor.userId },
							args: { id: folderId, name: input.patch.name },
						}),
					),
				);
			} catch (error) {
				translateFolderError(error);
			}
			const updated = await visibleFolderSnapshot(
				client,
				actor.userId,
				folderId,
			);
			if (!updated) throw new Error("Folder update result missing");
			return updated.snapshot;
		},
	);
}
