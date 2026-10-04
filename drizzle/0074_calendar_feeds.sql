CREATE TABLE "calendar_feed" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"list_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "calendar_feed_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "calendar_feed_name" CHECK (char_length("calendar_feed"."name") between 1 and 80),
	CONSTRAINT "calendar_feed_hash" CHECK ("calendar_feed"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "calendar_feed_expiry" CHECK ("calendar_feed"."expires_at" > "calendar_feed"."created_at" and "calendar_feed"."expires_at" <= "calendar_feed"."created_at" + interval '365 days')
);
--> statement-breakpoint
ALTER TABLE "calendar_feed" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed" ADD CONSTRAINT "calendar_feed_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_feed_user_idx" ON "calendar_feed" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_feed_list_idx" ON "calendar_feed" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "calendar_feed_workspace_idx" ON "calendar_feed" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "calendar_feed_owner" ON "calendar_feed" AS PERMISSIVE FOR ALL TO public USING ("calendar_feed"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("calendar_feed"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "calendar_feed_authenticate" ON "calendar_feed" AS PERMISSIVE FOR SELECT TO public USING ("calendar_feed"."secret_hash" = current_setting('ditero.calendar_feed_hash', true));