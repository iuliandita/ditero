ALTER TABLE "ack_capability" ALTER COLUMN "reminder_state_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ack_capability" ADD COLUMN "channel_kind" "channel_kind";