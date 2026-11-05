ALTER TABLE "habit_log" ADD COLUMN "completed_by" text;--> statement-breakpoint
CREATE INDEX "habit_log_completed_by_idx" ON "habit_log" USING btree ("completed_by");--> statement-breakpoint
ALTER TABLE "habit_log" ADD CONSTRAINT "habit_log_completed_by_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "habit_log" VALIDATE CONSTRAINT "habit_log_completed_by_user_id_fk";
