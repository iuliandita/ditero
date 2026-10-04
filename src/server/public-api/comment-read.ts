import type { PoolClient } from "pg";
import { apiResult, PublicApiError } from "../../domain/public-api.ts";
import {
	API_COMMENT_RESPONSE_BYTES,
	type ApiCommentPageQuery,
	apiCommentSnapshotSchema,
	encodeCommentCursor,
} from "../../domain/public-api-comments.ts";
import { COMMENT_FIELDS } from "./comment-observation.ts";
import type { ApiActor } from "./tokens.ts";

export async function readApiComments(
	client: PoolClient,
	actor: ApiActor,
	taskId: string,
	query: ApiCommentPageQuery,
): Promise<Response> {
	const access = await client.query(
		`select t.id from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id where t.id=$1 and m.user_id=$2`,
		[taskId, actor.userId],
	);
	if (!access.rowCount)
		throw new PublicApiError(404, "not-found", "Resource not found");
	const rows = await client.query(
		`select ${COMMENT_FIELDS} from comment c join task t on t.id=c.task_id join list l on l.id=t.list_id
 join membership m on m.workspace_id=l.workspace_id where c.task_id=$1 and m.user_id=$2
 and ($3::text is null or c.id collate "C" > $3 collate "C") order by c.id collate "C" limit $4`,
		[taskId, actor.userId, query.after, query.limit + 1],
	);
	const data = rows.rows
		.slice(0, query.limit)
		.map((row) => apiCommentSnapshotSchema.parse(row));
	const cursor =
		rows.rows.length > query.limit
			? encodeCommentCursor(taskId, data[data.length - 1].commentId)
			: null;
	if (
		Buffer.byteLength(
			JSON.stringify({ version: 1, data, nextCursor: cursor }),
			"utf8",
		) > API_COMMENT_RESPONSE_BYTES
	)
		throw new PublicApiError(
			413,
			"comment-response-too-large",
			"Read a smaller comment page; oversized comments require an observation",
		);
	return apiResult(data, cursor);
}
