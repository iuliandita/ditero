CREATE TABLE "user_key_secret" (
	"user_key_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"passphrase_wrapped" text NOT NULL,
	"recovery_wrapped" text NOT NULL,
	"passphrase_salt" text NOT NULL,
	"recovery_salt" text NOT NULL,
	"format_version" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_key_secret" ADD CONSTRAINT "user_key_secret_user_key_id_user_key_id_fk" FOREIGN KEY ("user_key_id") REFERENCES "public"."user_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_key_secret" ADD CONSTRAINT "user_key_secret_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "user_key_secret"
	("user_key_id", "user_id", "passphrase_wrapped", "recovery_wrapped",
	 "passphrase_salt", "recovery_salt", "format_version", "updated_at")
SELECT "id", "user_id", "passphrase_wrapped", "recovery_wrapped",
       "passphrase_salt", "recovery_salt", "format_version", "updated_at"
FROM "user_key";--> statement-breakpoint
ALTER TABLE "user_key" DROP COLUMN "passphrase_wrapped";--> statement-breakpoint
ALTER TABLE "user_key" DROP COLUMN "recovery_wrapped";--> statement-breakpoint
ALTER TABLE "user_key" DROP COLUMN "passphrase_salt";--> statement-breakpoint
ALTER TABLE "user_key" DROP COLUMN "recovery_salt";--> statement-breakpoint
ALTER TABLE "user_key" DROP COLUMN "format_version";
--> statement-breakpoint
ALTER TABLE "user_key_secret" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_key_secret" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_key_secret_owner" ON "user_key_secret"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
DROP POLICY "user_key_owner" ON "user_key";--> statement-breakpoint
CREATE POLICY "user_key_read" ON "user_key" FOR SELECT
	USING (
		"user_id" = current_setting('ditero.user_id', true)
		OR EXISTS (
			SELECT 1 FROM "membership" mine
			JOIN "membership" theirs ON theirs."workspace_id" = mine."workspace_id"
			WHERE mine."user_id" = current_setting('ditero.user_id', true)
			  AND theirs."user_id" = "user_key"."user_id"
		)
	);--> statement-breakpoint
CREATE POLICY "user_key_own_insert" ON "user_key" FOR INSERT
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "user_key_own_update" ON "user_key" FOR UPDATE
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "user_key_own_delete" ON "user_key" FOR DELETE
	USING ("user_id" = current_setting('ditero.user_id', true));
