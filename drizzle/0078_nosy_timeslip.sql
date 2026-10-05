CREATE TABLE "inbound_webhook" (
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
	CONSTRAINT "inbound_webhook_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "inbound_webhook_name" CHECK (char_length("inbound_webhook"."name") between 1 and 80),
	CONSTRAINT "inbound_webhook_hash" CHECK ("inbound_webhook"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "inbound_webhook_expiry" CHECK ("inbound_webhook"."expires_at" > "inbound_webhook"."created_at" and "inbound_webhook"."expires_at" <= "inbound_webhook"."created_at" + interval '365 days')
);
--> statement-breakpoint
ALTER TABLE "inbound_webhook" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbound_webhook" ADD CONSTRAINT "inbound_webhook_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_webhook" ADD CONSTRAINT "inbound_webhook_list_id_list_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_webhook" ADD CONSTRAINT "inbound_webhook_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbound_webhook_user_idx" ON "inbound_webhook" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "inbound_webhook_list_idx" ON "inbound_webhook" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "inbound_webhook_workspace_idx" ON "inbound_webhook" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "inbound_webhook_owner" ON "inbound_webhook" AS PERMISSIVE FOR ALL TO public USING ("inbound_webhook"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("inbound_webhook"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "inbound_webhook_authenticate" ON "inbound_webhook" AS PERMISSIVE FOR SELECT TO public USING ("inbound_webhook"."secret_hash" = current_setting('ditero.webhook_hash', true));