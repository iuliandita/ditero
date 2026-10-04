ALTER TABLE "public_api_request" DROP CONSTRAINT "public_api_request_resource";--> statement-breakpoint
ALTER TABLE "public_api_request" ADD COLUMN "comment_id" text;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD COLUMN "comment_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_comment_snapshot" CHECK ("public_api_request"."comment_snapshot" is null or coalesce(
 "public_api_request"."resource_kind" = 'comment' and octet_length("public_api_request"."comment_snapshot"::text) <= 262144
 and jsonb_typeof("public_api_request"."comment_snapshot") = 'object'
 and "public_api_request"."comment_snapshot"->>'kind' in ('comment-create-ack','comment-update-ack','comment-delete-ack')
 and jsonb_typeof("public_api_request"."comment_snapshot"->'originalWorkspaceId') = 'string'
 and jsonb_typeof("public_api_request"."comment_snapshot"->'originalListId') = 'string'
 and jsonb_typeof("public_api_request"."comment_snapshot"->'originalTaskId') = 'string'
 and length("public_api_request"."comment_snapshot"->>'originalWorkspaceId') between 1 and 256
 and length("public_api_request"."comment_snapshot"->>'originalListId') between 1 and 256
 and length("public_api_request"."comment_snapshot"->>'originalTaskId') between 1 and 256
 and jsonb_typeof("public_api_request"."comment_snapshot"->'snapshot') = 'object'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,version}') = 'number'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,version}' = '1'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,commentId}') = 'string'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,commentId}' = "public_api_request"."comment_id"
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,workspaceId}') = 'string'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,listId}') = 'string'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,taskId}') = 'string'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,workspaceId}' = "public_api_request"."comment_snapshot"->>'originalWorkspaceId'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,listId}' = "public_api_request"."comment_snapshot"->>'originalListId'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,taskId}' = "public_api_request"."comment_snapshot"->>'originalTaskId'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,authorId}') in ('string','null')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,createdAt}') = 'string'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,editedAt}') in ('string','null')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,importedAt}') in ('string','null')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,provenanceRedactedAt}') in ('string','null')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,historicalAuthorKind}') in ('string','null')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,historicalAuthorName}') in ('string','null')
 and (("public_api_request"."comment_snapshot"->>'kind' in ('comment-create-ack','comment-update-ack')
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,body}') = 'string' and not ("public_api_request"."comment_snapshot" ? 'deleted'))
 or ("public_api_request"."comment_snapshot"->>'kind' = 'comment-delete-ack'
 and "public_api_request"."comment_snapshot"->'deleted' = 'true'::jsonb
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,body}') = 'object'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,body,sha256}') = 'string'
 and "public_api_request"."comment_snapshot"#>>'{snapshot,body,sha256}' ~ '^[a-f0-9]{64}$'
 and jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,body,utf8Bytes}') = 'number'
 and case when jsonb_typeof("public_api_request"."comment_snapshot"#>'{snapshot,body,utf8Bytes}') = 'number'
 then ("public_api_request"."comment_snapshot"#>>'{snapshot,body,utf8Bytes}')::numeric between 0 and 9007199254740991
 and ("public_api_request"."comment_snapshot"#>>'{snapshot,body,utf8Bytes}')::numeric = trunc(("public_api_request"."comment_snapshot"#>>'{snapshot,body,utf8Bytes}')::numeric) else false end)), false));--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_resource" CHECK ((
			(
			("public_api_request"."resource_kind" = 'task' and "public_api_request"."task_id" is not null
			 and "public_api_request"."list_id" is null and "public_api_request"."list_snapshot" is null)
			or ("public_api_request"."resource_kind" = 'list' and "public_api_request"."task_id" is null
			 and "public_api_request"."task_snapshot" is null and "public_api_request"."list_id" is not null and "public_api_request"."list_snapshot" is not null
			 and coalesce(jsonb_typeof("public_api_request"."list_snapshot") = 'object'
			 and jsonb_typeof("public_api_request"."list_snapshot"->'id') = 'string'
			 and "public_api_request"."list_snapshot"->>'id' = "public_api_request"."list_id", false))
			) and "public_api_request"."folder_id" is null and "public_api_request"."folder_snapshot" is null
			or ("public_api_request"."resource_kind" = 'folder' and "public_api_request"."task_id" is null and "public_api_request"."task_snapshot" is null
			 and "public_api_request"."list_id" is null and "public_api_request"."list_snapshot" is null
			 and "public_api_request"."folder_id" is not null and "public_api_request"."folder_snapshot" is not null
			 and coalesce(jsonb_typeof("public_api_request"."folder_snapshot") = 'object'
			 and jsonb_typeof("public_api_request"."folder_snapshot"->'id') = 'string'
			 and "public_api_request"."folder_snapshot"->>'id' = "public_api_request"."folder_id", false))
) and "public_api_request"."comment_id" is null and "public_api_request"."comment_snapshot" is null
or ("public_api_request"."resource_kind" = 'comment' and "public_api_request"."comment_id" is not null and "public_api_request"."comment_snapshot" is not null
 and "public_api_request"."task_id" is null and "public_api_request"."task_snapshot" is null and "public_api_request"."list_id" is null and "public_api_request"."list_snapshot" is null
 and "public_api_request"."folder_id" is null and "public_api_request"."folder_snapshot" is null)
		);