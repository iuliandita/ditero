CREATE TABLE "workspace_access_scope" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_access_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_access_scope" ADD CONSTRAINT "workspace_access_scope_id_membership_id_fk" FOREIGN KEY ("id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_access_scope_user_id_idx" ON "workspace_access_scope" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "workspace_access_scope_own_select" ON "workspace_access_scope" AS PERMISSIVE FOR SELECT TO public USING ("workspace_access_scope"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "workspace_access_scope_owner_maintenance" ON "workspace_access_scope" AS PERMISSIVE FOR ALL TO public USING (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.workspace_access_scope'::pg_catalog.regclass))) WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.workspace_access_scope'::pg_catalog.regclass)));