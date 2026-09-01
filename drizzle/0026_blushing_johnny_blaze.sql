ALTER TABLE "invite" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_claimed_by_user_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;