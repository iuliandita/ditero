ALTER TABLE "public_api_request" DROP CONSTRAINT "public_api_request_resource";--> statement-breakpoint
ALTER TABLE "public_api_request" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD COLUMN "folder_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_resource" CHECK (
			(
			("public_api_request"."resource_kind" = 'task' and "public_api_request"."task_id" is not null
			 and "public_api_request"."list_id" is null and "public_api_request"."list_snapshot" is null)
			or ("public_api_request"."resource_kind" = 'list' and "public_api_request"."task_id" is null
			 and "public_api_request"."list_id" is not null and "public_api_request"."list_snapshot" is not null
			 and coalesce(jsonb_typeof("public_api_request"."list_snapshot") = 'object'
			 and jsonb_typeof("public_api_request"."list_snapshot"->'id') = 'string'
			 and "public_api_request"."list_snapshot"->>'id' = "public_api_request"."list_id", false))
			) and "public_api_request"."folder_id" is null and "public_api_request"."folder_snapshot" is null
			or ("public_api_request"."resource_kind" = 'folder' and "public_api_request"."task_id" is null
			 and "public_api_request"."list_id" is null and "public_api_request"."list_snapshot" is null
			 and "public_api_request"."folder_id" is not null and "public_api_request"."folder_snapshot" is not null
			 and coalesce(jsonb_typeof("public_api_request"."folder_snapshot") = 'object'
			 and jsonb_typeof("public_api_request"."folder_snapshot"->'id') = 'string'
			 and "public_api_request"."folder_snapshot"->>'id' = "public_api_request"."folder_id", false))
		);