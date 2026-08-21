CREATE TYPE "public"."key_enrollment_state" AS ENUM('unenrolled', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."key_grant_state" AS ENUM('key_pending', 'ready', 'failed', 'revoked');--> statement-breakpoint
CREATE TABLE "key_grant_request" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_version" integer NOT NULL,
	"state" "key_grant_state" DEFAULT 'key_pending' NOT NULL,
	"failure_reason" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "membership_key" (
	"id" text PRIMARY KEY NOT NULL,
	"membership_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"enc" text NOT NULL,
	"ciphertext" text NOT NULL,
	"recipient_public_key" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_key_version" UNIQUE("membership_id","key_version")
);
--> statement-breakpoint
CREATE TABLE "user_device" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"passphrase_wrapped" text NOT NULL,
	"recovery_wrapped" text NOT NULL,
	"passphrase_salt" text NOT NULL,
	"recovery_salt" text NOT NULL,
	"format_version" smallint DEFAULT 1 NOT NULL,
	"state" "key_enrollment_state" DEFAULT 'unenrolled' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_key_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_key" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"commitment" text NOT NULL,
	"minted_by" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workspace_key_version" UNIQUE("workspace_id","version")
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "rotation_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "key_grant_request" ADD CONSTRAINT "key_grant_request_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_grant_request" ADD CONSTRAINT "key_grant_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_grant_request" ADD CONSTRAINT "key_grant_request_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_key" ADD CONSTRAINT "membership_key_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_key" ADD CONSTRAINT "membership_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_key" ADD CONSTRAINT "membership_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_key" ADD CONSTRAINT "membership_key_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_device" ADD CONSTRAINT "user_device_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_key" ADD CONSTRAINT "user_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_key" ADD CONSTRAINT "workspace_key_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_key" ADD CONSTRAINT "workspace_key_minted_by_user_id_fk" FOREIGN KEY ("minted_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "key_grant_request_active" ON "key_grant_request" USING btree ("membership_id","requested_version") WHERE state = 'key_pending';
--> statement-breakpoint
ALTER TABLE "user_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_key_owner" ON "user_key"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
ALTER TABLE "membership_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "membership_key_owner" ON "membership_key"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
ALTER TABLE "key_grant_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "key_grant_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "key_grant_request_owner" ON "key_grant_request"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
ALTER TABLE "user_device" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_device" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_device_owner" ON "user_device"
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
ALTER TABLE "workspace_key" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_key" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "workspace_key_member" ON "workspace_key"
	USING (EXISTS (
		SELECT 1 FROM "membership" m
		WHERE m."workspace_id" = "workspace_key"."workspace_id"
		  AND m."user_id" = current_setting('ditero.user_id', true)
	))
	WITH CHECK (EXISTS (
		SELECT 1 FROM "membership" m
		WHERE m."workspace_id" = "workspace_key"."workspace_id"
		  AND m."user_id" = current_setting('ditero.user_id', true)
	));
