CREATE TABLE "task_notification_activation" (
	"task_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"generation" integer NOT NULL,
	"import_occurrence_cutoff" timestamp with time zone,
	"recipient_generation_cutoff" timestamp with time zone,
	"completion_mode" text,
	"owning_source_id" text,
	"owning_owner_user_id" text,
	"owning_job_id" text,
	"readiness_ordinal" integer DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"manual_review_digest" text,
	"expected_relationship_digest" text,
	"expected_relationship_count" integer,
	"expected_relationship_bytes" integer,
	"expected_relationships" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_notification_activation_status" CHECK ("task_notification_activation"."status" in ('pending', 'blocked', 'active')),
	CONSTRAINT "task_notification_activation_generation" CHECK ("task_notification_activation"."generation" > 0),
	CONSTRAINT "task_notification_activation_readiness" CHECK ("task_notification_activation"."readiness_ordinal" >= 0),
	CONSTRAINT "task_notification_activation_completion" CHECK (("task_notification_activation"."status" = 'active') = ("task_notification_activation"."completion_mode" is not null)
				and ("task_notification_activation"."completion_mode" is null or "task_notification_activation"."completion_mode" in ('import', 'manual'))),
	CONSTRAINT "task_notification_activation_active_cutoffs" CHECK ("task_notification_activation"."status" <> 'active' or ("task_notification_activation"."import_occurrence_cutoff" is not null and "task_notification_activation"."recipient_generation_cutoff" is not null)),
	CONSTRAINT "task_notification_activation_cutoff_order" CHECK ("task_notification_activation"."import_occurrence_cutoff" is null or "task_notification_activation"."recipient_generation_cutoff" is null or "task_notification_activation"."recipient_generation_cutoff" >= "task_notification_activation"."import_occurrence_cutoff"),
	CONSTRAINT "task_notification_activation_blocked_reason" CHECK ("task_notification_activation"."blocked_reason" is null or char_length("task_notification_activation"."blocked_reason") <= 128),
	CONSTRAINT "task_notification_activation_evidence" CHECK (("task_notification_activation"."expected_relationships" is null and "task_notification_activation"."expected_relationship_digest" is null and "task_notification_activation"."expected_relationship_count" is null and "task_notification_activation"."expected_relationship_bytes" is null)
				or ("task_notification_activation"."expected_relationships" is not null and jsonb_typeof("task_notification_activation"."expected_relationships") = 'object'
					and "task_notification_activation"."expected_relationship_digest" is not null
					and "task_notification_activation"."expected_relationship_count" is not null
					and "task_notification_activation"."expected_relationship_bytes" is not null
					and "task_notification_activation"."expected_relationship_digest" ~ '^[0-9a-f]{64}$'
					and "task_notification_activation"."expected_relationship_count" between 0 and 50000
					and "task_notification_activation"."expected_relationship_bytes" between 0 and 67108864
					and octet_length("task_notification_activation"."expected_relationships"::text) = "task_notification_activation"."expected_relationship_bytes"))
);
--> statement-breakpoint
CREATE TABLE "task_notification_recipient" (
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"generation" integer NOT NULL,
	"cutoff" timestamp with time zone,
	"overdue_suppressed_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_notification_recipient_task_id_user_id_pk" PRIMARY KEY("task_id","user_id"),
	CONSTRAINT "task_notification_recipient_generation" CHECK ("task_notification_recipient"."generation" > 0),
	CONSTRAINT "task_notification_recipient_active_cutoff" CHECK (not "task_notification_recipient"."active" or "task_notification_recipient"."cutoff" is not null)
);
--> statement-breakpoint
ALTER TABLE "task_notification_activation" ADD CONSTRAINT "task_notification_activation_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notification_recipient" ADD CONSTRAINT "task_notification_recipient_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notification_recipient" ADD CONSTRAINT "task_notification_recipient_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_notification_activation_job_idx" ON "task_notification_activation" USING btree ("owning_job_id","generation","status","readiness_ordinal","task_id");--> statement-breakpoint
CREATE INDEX "task_notification_recipient_user_idx" ON "task_notification_recipient" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_notification_recipient_active_idx" ON "task_notification_recipient" USING btree ("task_id","generation","user_id") WHERE "task_notification_recipient"."active";