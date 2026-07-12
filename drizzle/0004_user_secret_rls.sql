CREATE TABLE "user_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_secret_user_kind" UNIQUE("user_id","kind")
);
--> statement-breakpoint
ALTER TABLE "user_secret" ADD CONSTRAINT "user_secret_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_secret" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_secret" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_secret_owner" ON "user_secret"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));
