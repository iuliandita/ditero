CREATE TABLE "import_run" (
	"job_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"next_ordinal" integer DEFAULT 0 NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"noop_count" integer DEFAULT 0 NOT NULL,
	"conflict_code" text,
	"conflict_ordinal" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_run_state" CHECK ("import_run"."state" in ('pending', 'running', 'conflict', 'completed')),
	CONSTRAINT "import_run_next_ordinal" CHECK ("import_run"."next_ordinal" >= 0),
	CONSTRAINT "import_run_applied_count" CHECK ("import_run"."applied_count" >= 0),
	CONSTRAINT "import_run_noop_count" CHECK ("import_run"."noop_count" >= 0),
	CONSTRAINT "import_run_conflict_ordinal" CHECK ("import_run"."conflict_ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "import_source_map" (
	"source_id" text NOT NULL,
	"source_key" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"collection" text NOT NULL,
	"source_row_id" text NOT NULL,
	"target_id" text NOT NULL,
	"target_workspace_id" text NOT NULL,
	"content_digest" text NOT NULL,
	"last_target_digest" text NOT NULL,
	"last_plan_digest" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_source_map_source_id_source_key_pk" PRIMARY KEY("source_id","source_key"),
	CONSTRAINT "import_source_map_target" UNIQUE("source_id","collection","target_id"),
	CONSTRAINT "import_source_map_version" CHECK ("import_source_map"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "import_workspace_map" (
	"source_id" text NOT NULL,
	"source_workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"target_workspace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_workspace_map_source_id_source_workspace_id_pk" PRIMARY KEY("source_id","source_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "import_item" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "import_item" ADD COLUMN "content_digest" text;--> statement-breakpoint
ALTER TABLE "import_item" ADD COLUMN "target_precondition" jsonb;--> statement-breakpoint
ALTER TABLE "import_item" ADD COLUMN "dependency_proof" jsonb;--> statement-breakpoint
ALTER TABLE "import_job" ADD COLUMN "planner_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_job" ADD COLUMN "apply_supported" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_job_id_import_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_source_map" ADD CONSTRAINT "import_source_map_source_id_import_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."import_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_source_map" ADD CONSTRAINT "import_source_map_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_workspace_map" ADD CONSTRAINT "import_workspace_map_source_id_import_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."import_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_workspace_map" ADD CONSTRAINT "import_workspace_map_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_run_owner_idx" ON "import_run" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "import_source_map_owner_idx" ON "import_source_map" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "import_workspace_map_owner_idx" ON "import_workspace_map" USING btree ("owner_user_id");