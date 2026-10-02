CREATE TABLE "native_push_registration" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"provider" text NOT NULL,
	"config_ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_push_registration_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "native_push_registration_provider" CHECK ("native_push_registration"."provider" in ('unifiedpush','fcm'))
);
--> statement-breakpoint
ALTER TABLE "native_push_registration" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "native_push_registration" ADD CONSTRAINT "native_push_registration_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_push_registration" ADD CONSTRAINT "native_push_registration_device_id_user_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_push_registration" ADD CONSTRAINT "native_push_registration_session_id_user_id_device_id_native_session_link_session_id_user_id_device_id_fk" FOREIGN KEY ("session_id","user_id","device_id") REFERENCES "public"."native_session_link"("session_id","user_id","device_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "native_push_registration_owner" ON "native_push_registration" AS PERMISSIVE FOR ALL TO public USING ("native_push_registration"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("native_push_registration"."user_id" = current_setting('ditero.user_id', true));