CREATE TYPE "public"."channel_error_code" AS ENUM('auth', 'not_found', 'rate_limited', 'policy', 'transport');--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "last_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD COLUMN "last_error_code" "channel_error_code";