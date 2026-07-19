CREATE TABLE "rate_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" integer NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_outbox_claim" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_reclaim" ON "notification_outbox" USING btree ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "notification_outbox_recipient" ON "notification_outbox" USING btree ("recipient_user_id","status");--> statement-breakpoint
CREATE INDEX "notification_outbox_prune" ON "notification_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "reminder_state_sweep" ON "reminder_state" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "reminder_state_deferred" ON "reminder_state" USING btree ("status","deferred_until");--> statement-breakpoint
CREATE INDEX "reminder_state_siblings" ON "reminder_state" USING btree ("task_id","occurrence_at");