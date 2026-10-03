CREATE TABLE "public_api_request" (
	"user_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"task_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_api_request_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "public_api_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public_api_request" ADD CONSTRAINT "public_api_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "public_api_request_read" ON "public_api_request" AS PERMISSIVE FOR SELECT TO public USING ("public_api_request"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "public_api_request_insert" ON "public_api_request" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("public_api_request"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "public_api_request_delete" ON "public_api_request" AS PERMISSIVE FOR DELETE TO public USING ("public_api_request"."user_id" = current_setting('ditero.user_id', true));