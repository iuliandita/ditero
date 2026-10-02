CREATE TABLE "native_relay_authority" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"device_id" text NOT NULL,
	"registration_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"config_ciphertext" text NOT NULL,
	"offer_token" text NOT NULL,
	"state" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"offer_expires" timestamp with time zone NOT NULL,
	"receipt" text,
	"next_attempt" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_relay_authority_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "native_relay_authority_registration_id_unique" UNIQUE("registration_id"),
	CONSTRAINT "native_relay_state" CHECK ("native_relay_authority"."state" in ('issued','active','retiring'))
);
--> statement-breakpoint
ALTER TABLE "native_push_registration" DROP CONSTRAINT "native_push_registration_provider";--> statement-breakpoint
CREATE INDEX "native_relay_recovery_due" ON "native_relay_authority" USING btree ("next_attempt");--> statement-breakpoint
CREATE INDEX "native_relay_session" ON "native_relay_authority" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "native_push_registration" ADD CONSTRAINT "native_push_registration_provider" CHECK ("native_push_registration"."provider" in ('unifiedpush','fcm','desktop','fcm-relay'));