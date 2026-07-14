CREATE TYPE "public"."keymap_profile" AS ENUM('default', 'vim');--> statement-breakpoint
CREATE TYPE "public"."view_scope" AS ENUM('personal', 'workspace');--> statement-breakpoint
CREATE TABLE "user_pref" (
	"id" text PRIMARY KEY NOT NULL,
	"keymap" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"keymap_profile" "keymap_profile" DEFAULT 'default' NOT NULL,
	"home_view_ref" text,
	"pinned_views" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "view" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"icon" text,
	"scope" "view_scope" DEFAULT 'personal' NOT NULL,
	"filter" jsonb NOT NULL,
	"display" jsonb NOT NULL,
	"sort_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_pref" ADD CONSTRAINT "user_pref_id_user_id_fk" FOREIGN KEY ("id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view" ADD CONSTRAINT "view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;