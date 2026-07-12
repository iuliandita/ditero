CREATE TYPE "public"."completed_display" AS ENUM('sink', 'keep', 'hide');--> statement-breakpoint
CREATE TYPE "public"."list_kind" AS ENUM('tasks', 'shopping', 'checklist', 'project', 'habits');--> statement-breakpoint
CREATE TYPE "public"."template_kind" AS ENUM('list', 'task');--> statement-breakpoint
CREATE TABLE "folder" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "label" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	CONSTRAINT "label_workspace_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "task_label" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"label_id" text NOT NULL,
	CONSTRAINT "task_label_pair" UNIQUE("task_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" "template_kind" NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"content" jsonb NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "kind" "list_kind" DEFAULT 'tasks' NOT NULL;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "sort_key" text;--> statement-breakpoint
ALTER TABLE "list" ADD COLUMN "completed_display" "completed_display" DEFAULT 'sink' NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "due_all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "priority" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "sort_key" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "parent_id" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "quantity" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "category" text;--> statement-breakpoint
-- backfill sort_key with valid fractional-indexing keys ('a'+base62); pre-release data, <=62 rows/parent assumed
UPDATE "list" SET "sort_key" = sub.k FROM (SELECT id, 'a' || nullif(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (row_number() OVER (PARTITION BY workspace_id ORDER BY ctid))::int, 1), '') AS k FROM "list") sub WHERE "list".id = sub.id;--> statement-breakpoint
UPDATE "task" SET "sort_key" = sub.k FROM (SELECT id, 'a' || nullif(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (row_number() OVER (PARTITION BY list_id ORDER BY ctid))::int, 1), '') AS k FROM "task") sub WHERE "task".id = sub.id;--> statement-breakpoint
ALTER TABLE "list" ALTER COLUMN "sort_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ALTER COLUMN "sort_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_label" ADD CONSTRAINT "task_label_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_label" ADD CONSTRAINT "task_label_label_id_label_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."label"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list" ADD CONSTRAINT "list_folder_id_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folder"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."task"("id") ON DELETE no action ON UPDATE no action;