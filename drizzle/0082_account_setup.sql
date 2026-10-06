CREATE TABLE "account_setup" (
	"id" text PRIMARY KEY NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"catalog_version" integer,
	"locale" text,
	"latest_receipt" jsonb,
	"generated_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_setup_revision" CHECK ("account_setup"."revision" between 0 and 9007199254740991),
	CONSTRAINT "account_setup_state" CHECK (coalesce(
 ("account_setup"."outcome" in ('pending','legacy') and "account_setup"."revision"=0 and "account_setup"."catalog_version" is null and "account_setup"."locale" is null and "account_setup"."latest_receipt" is null and "account_setup"."generated_ids" is null)
 or ("account_setup"."outcome" in ('completed','custom','skipped') and "account_setup"."revision">0 and "account_setup"."catalog_version"=1 and "account_setup"."locale" in ('en','de','es','fr','ro','ar')
 and jsonb_typeof("account_setup"."latest_receipt")='object' and octet_length("account_setup"."latest_receipt"::text)<=4096
 and "account_setup"."latest_receipt"->'outcome'=to_jsonb("account_setup"."outcome")
 and "account_setup"."latest_receipt"->'revision'=to_jsonb("account_setup"."revision")
 and jsonb_typeof("account_setup"."latest_receipt"->'request')='object'
 and "account_setup"."latest_receipt"#>'{request,catalogVersion}'=to_jsonb("account_setup"."catalog_version")
 and "account_setup"."latest_receipt"#>'{request,locale}'=to_jsonb("account_setup"."locale")
 and "account_setup"."latest_receipt"#>'{request,expectedRevision}'=to_jsonb("account_setup"."revision"-1)
 and jsonb_typeof("account_setup"."latest_receipt"#>'{request,requestId}')='string'
 and "account_setup"."latest_receipt"#>>'{request,requestId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 and (("account_setup"."outcome"='completed' and "account_setup"."latest_receipt"#>>'{request,mode}' in ('basic','guided') and "account_setup"."generated_ids" is not null)
 or ("account_setup"."outcome"='custom' and "account_setup"."latest_receipt"#>>'{request,mode}'='custom' and "account_setup"."generated_ids" is null)
 or ("account_setup"."outcome"='skipped' and "account_setup"."latest_receipt"#>>'{request,mode}'='skip' and "account_setup"."generated_ids" is null))),false)),
	CONSTRAINT "account_setup_generated_ids" CHECK ("account_setup"."generated_ids" is null or coalesce(
 jsonb_typeof("account_setup"."generated_ids")='object' and octet_length("account_setup"."generated_ids"::text)<=4096
 and "account_setup"."generated_ids"->'version'='1'::jsonb
 and jsonb_typeof("account_setup"."generated_ids"->'workspaceId')='string'
 and "account_setup"."generated_ids"->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 and case when jsonb_typeof("account_setup"."generated_ids"->'listIds')='array' then jsonb_array_length("account_setup"."generated_ids"->'listIds')<=3 else false end
 and case when jsonb_typeof("account_setup"."generated_ids"->'taskIds')='array' then jsonb_array_length("account_setup"."generated_ids"->'taskIds')<=24 else false end
 and case when jsonb_typeof("account_setup"."generated_ids"->'panelIds')='array' then jsonb_array_length("account_setup"."generated_ids"->'panelIds')<=2 else false end
 and (jsonb_typeof("account_setup"."generated_ids"->'dashboardId')='null' or (jsonb_typeof("account_setup"."generated_ids"->'dashboardId')='string' and "account_setup"."generated_ids"->>'dashboardId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),false))
);
--> statement-breakpoint
ALTER TABLE "account_setup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account_setup" ADD CONSTRAINT "account_setup_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "account_setup_owner_select" ON "account_setup" AS PERMISSIVE FOR SELECT TO public USING ("account_setup"."id"=current_setting('ditero.user_id',true));--> statement-breakpoint
CREATE POLICY "account_setup_owner_insert" ON "account_setup" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("account_setup"."id"=current_setting('ditero.user_id',true));--> statement-breakpoint
CREATE POLICY "account_setup_owner_update" ON "account_setup" AS PERMISSIVE FOR UPDATE TO public USING ("account_setup"."id"=current_setting('ditero.user_id',true)) WITH CHECK ("account_setup"."id"=current_setting('ditero.user_id',true));