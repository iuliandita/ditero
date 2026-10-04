ALTER TABLE "public_api_request" DROP CONSTRAINT "public_api_request_resource";--> statement-breakpoint
ALTER TABLE "public_api_request" ADD COLUMN "task_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_task_snapshot" CHECK ("public_api_request"."task_snapshot" is null or coalesce(
 "public_api_request"."resource_kind" = 'task' and octet_length("public_api_request"."task_snapshot"::text) <= 262144
 and jsonb_typeof("public_api_request"."task_snapshot") = 'object'
 and "public_api_request"."task_snapshot"->>'kind' = 'task-place-ack'
 and jsonb_typeof("public_api_request"."task_snapshot"->'originalWorkspaceId') = 'string'
 and jsonb_typeof("public_api_request"."task_snapshot"->'originalListId') = 'string'
 and jsonb_typeof("public_api_request"."task_snapshot"->'movedChildren') = 'number'
 and case when jsonb_typeof("public_api_request"."task_snapshot"->'movedChildren') = 'number' then ("public_api_request"."task_snapshot"->>'movedChildren')::numeric between 0 and 9007199254740991 and ("public_api_request"."task_snapshot"->>'movedChildren')::numeric = trunc(("public_api_request"."task_snapshot"->>'movedChildren')::numeric) else false end
 and jsonb_typeof("public_api_request"."task_snapshot"->'snapshot') = 'object'
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,task}') = 'object'
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,list}') = 'object'
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,version}') = 'number'
 and "public_api_request"."task_snapshot"#>>'{snapshot,version}' = '1'
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,task,taskId}') = 'string'
 and "public_api_request"."task_snapshot"#>>'{snapshot,task,taskId}' = "public_api_request"."task_id"
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,sortKey}') = 'string'
 and length("public_api_request"."task_snapshot"#>>'{snapshot,sortKey}') between 2 and 256
 and jsonb_typeof("public_api_request"."task_snapshot"#>'{snapshot,parentId}') in ('string','null')
 and "public_api_request"."task_snapshot"#>>'{snapshot,task,listId}' = "public_api_request"."task_snapshot"#>>'{snapshot,list,id}'
 and "public_api_request"."task_snapshot"#>>'{snapshot,task,workspaceId}' = "public_api_request"."task_snapshot"->>'originalWorkspaceId'
 and "public_api_request"."task_snapshot"#>>'{snapshot,list,workspaceId}' = "public_api_request"."task_snapshot"->>'originalWorkspaceId', false));--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_resource" CHECK (
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
		);