CREATE TYPE "public"."channel_kind" AS ENUM('ntfy', 'telegram', 'discord', 'slack', 'email');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('pending', 'deferred', 'acked', 'escalated', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "ack_capability" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"reminder_state_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"action" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ack_capability_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "delivery_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"outbox_id" text NOT NULL,
	"attempt_no" smallint NOT NULL,
	"provider_status" smallint,
	"retry_class" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channel_user_kind" UNIQUE("user_id","kind")
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"reminder_state_id" text,
	"recipient_user_id" text NOT NULL,
	"channel_kind" "channel_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_idempotency" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "reminder_state" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"recipient_user_id" text NOT NULL,
	"status" "reminder_status" DEFAULT 'pending' NOT NULL,
	"fire_count" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"deferred_until" timestamp with time zone,
	"fired_late" boolean DEFAULT false NOT NULL,
	"acked_at" timestamp with time zone,
	"acked_via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_state_occurrence" UNIQUE("task_id","occurrence_at","recipient_user_id")
);
--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "repeat_every_min" smallint;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "max_repeats" smallint;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "fallback_user_id" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "quiet_hours" jsonb;--> statement-breakpoint
ALTER TABLE "user_pref" ADD COLUMN "escalation_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "ack_capability" ADD CONSTRAINT "ack_capability_reminder_state_id_reminder_state_id_fk" FOREIGN KEY ("reminder_state_id") REFERENCES "public"."reminder_state"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ack_capability" ADD CONSTRAINT "ack_capability_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_reminder_state_id_reminder_state_id_fk" FOREIGN KEY ("reminder_state_id") REFERENCES "public"."reminder_state"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_state" ADD CONSTRAINT "reminder_state_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_state" ADD CONSTRAINT "reminder_state_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_fallback_user_id_user_id_fk" FOREIGN KEY ("fallback_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;