CREATE TABLE "native_auth_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"device_label" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_user_id" text,
	"approved_session_id" text,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "native_session_link" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_session_link_device_id_unique" UNIQUE("device_id")
);
--> statement-breakpoint
ALTER TABLE "native_auth_grant" ADD CONSTRAINT "native_auth_grant_approved_user_id_user_id_fk" FOREIGN KEY ("approved_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_auth_grant" ADD CONSTRAINT "native_auth_grant_approved_session_id_session_id_fk" FOREIGN KEY ("approved_session_id") REFERENCES "public"."session"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_link" ADD CONSTRAINT "native_session_link_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_link" ADD CONSTRAINT "native_session_link_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_session_link" ADD CONSTRAINT "native_session_link_device_id_user_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_auth_grant_expiry_idx" ON "native_auth_grant" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "native_session_link_user_idx" ON "native_session_link" USING btree ("user_id");