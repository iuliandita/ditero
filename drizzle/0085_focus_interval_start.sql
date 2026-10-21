CREATE TABLE "focus_interval_start" (
	"user_id" text NOT NULL,
	"interval_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "focus_interval_start_user_id_interval_id_pk" PRIMARY KEY("user_id","interval_id")
);
--> statement-breakpoint
ALTER TABLE "focus_interval_start" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "focus_interval_start" ADD CONSTRAINT "focus_interval_start_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "focus_interval_start_owner_select" ON "focus_interval_start" AS PERMISSIVE FOR SELECT TO public USING ("focus_interval_start"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "focus_interval_start_owner_insert" ON "focus_interval_start" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("focus_interval_start"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "focus_interval_start_owner_delete" ON "focus_interval_start" AS PERMISSIVE FOR DELETE TO public USING ("focus_interval_start"."user_id" = current_setting('ditero.user_id', true));