CREATE TABLE "personal_access_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_access_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "personal_access_token_access" CHECK ("personal_access_token"."access" in ('read', 'write')),
	CONSTRAINT "personal_access_token_name" CHECK (char_length("personal_access_token"."name") between 1 and 80),
	CONSTRAINT "personal_access_token_expiry" CHECK ("personal_access_token"."expires_at" > "personal_access_token"."created_at" and "personal_access_token"."expires_at" <= "personal_access_token"."created_at" + interval '365 days')
);
--> statement-breakpoint
ALTER TABLE "personal_access_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "personal_access_token" ADD CONSTRAINT "personal_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_access_token_user_idx" ON "personal_access_token" USING btree ("user_id");--> statement-breakpoint
CREATE POLICY "personal_access_token_owner" ON "personal_access_token" AS PERMISSIVE FOR ALL TO public USING ("personal_access_token"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("personal_access_token"."user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "personal_access_token_authenticate" ON "personal_access_token" AS PERMISSIVE FOR SELECT TO public USING ("personal_access_token"."token_hash" = current_setting('ditero.pat_hash', true));