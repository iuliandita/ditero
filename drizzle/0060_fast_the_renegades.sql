CREATE TABLE "native_desktop_mailbox" (
	"notification_id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "native_desktop_mailbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "native_desktop_mailbox" ADD CONSTRAINT "native_desktop_mailbox_notification_id_notification_outbox_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification_outbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_desktop_mailbox" ADD CONSTRAINT "native_desktop_mailbox_registration_id_user_id_native_push_registration_id_user_id_fk" FOREIGN KEY ("registration_id","user_id") REFERENCES "public"."native_push_registration"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_desktop_mailbox_poll" ON "native_desktop_mailbox" USING btree ("registration_id","notification_id") WHERE "native_desktop_mailbox"."received_at" is null;--> statement-breakpoint
CREATE POLICY "native_desktop_mailbox_owner" ON "native_desktop_mailbox" AS PERMISSIVE FOR ALL TO public USING ("native_desktop_mailbox"."user_id" = current_setting('ditero.user_id', true)) WITH CHECK ("native_desktop_mailbox"."user_id" = current_setting('ditero.user_id', true));