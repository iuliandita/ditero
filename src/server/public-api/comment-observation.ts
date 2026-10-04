import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	type ApiCommentSnapshot,
	apiCommentSnapshotSchema,
} from "../../domain/public-api-comments.ts";
import type { ApiActor } from "./tokens.ts";

const instant = (column: string) =>
	`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const COMMENT_FIELDS = `1 as version,c.id as "commentId",c.task_id as "taskId",t.list_id as "listId",l.workspace_id as "workspaceId",
 c.author_id as "authorId",c.body,${instant("c.created_at")} as "createdAt",${instant("c.edited_at")} as "editedAt",
 c.historical_author_kind as "historicalAuthorKind",c.historical_author_name as "historicalAuthorName",
 ${instant("c.imported_at")} as "importedAt",${instant("c.provenance_redacted_at")} as "provenanceRedactedAt"`;
export type ObservedComment = {
	snapshot: ApiCommentSnapshot;
	role: string;
	stateToken: string;
};
export async function visibleCommentSnapshot(
	client: PoolClient,
	userId: string,
	taskId: string,
	commentId: string,
): Promise<ObservedComment | null> {
	const result = await client.query(
		`select ${COMMENT_FIELDS},m.role,
 jsonb_build_object('version',1,'listId',t.list_id,'workspaceId',l.workspace_id,'comment',
 to_jsonb(c) || jsonb_build_object('created_at',${instant("c.created_at")},'edited_at',${instant("c.edited_at")},
 'imported_at',${instant("c.imported_at")},'provenance_redacted_at',${instant("c.provenance_redacted_at")})) as captured
 from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id
 where c.id=$1 and c.task_id=$2 and m.user_id=$3`,
		[commentId, taskId, userId],
	);
	const row = result.rows[0];
	if (!row) return null;
	const { role, captured, ...fields } = row;
	return {
		snapshot: apiCommentSnapshotSchema.parse(fields),
		role,
		stateToken: createHash("sha256")
			.update(JSON.stringify(captured))
			.digest("hex"),
	};
}
export function compactCommentSnapshot(snapshot: ApiCommentSnapshot) {
	return {
		...snapshot,
		body: {
			sha256: createHash("sha256").update(snapshot.body).digest("hex"),
			utf8Bytes: Buffer.byteLength(snapshot.body, "utf8"),
		},
	};
}
export async function readApiCommentObservation(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
	commentId: string,
): Promise<Response> {
	const current = await visibleCommentSnapshot(
		client,
		actor.userId,
		taskId,
		commentId,
	);
	if (!current)
		throw new PublicApiError(404, "not-found", "Resource not found");
	return apiResult({
		snapshot: compactCommentSnapshot(current.snapshot),
		stateToken: current.stateToken,
	});
}
