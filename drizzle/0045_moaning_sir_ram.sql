CREATE TABLE "imported_completion_event" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"source_namespace" uuid NOT NULL,
	"source_row_id" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"ingested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_namespace" uuid,
	"actor_principal_id" text,
	"actor_name" text,
	"origin_kind" text NOT NULL,
	"origin_mechanism" text,
	"origin_label" text,
	"provenance_redacted_at" timestamp (3) with time zone,
	"action" text NOT NULL,
	"before_due_at" timestamp (3) with time zone,
	"before_due_all_day" boolean,
	"before_done" boolean,
	"after_due_at" timestamp (3) with time zone,
	"after_done" boolean,
	"habit_date" text,
	"before_habit_status" "habit_log_status",
	"after_habit_status" "habit_log_status",
	CONSTRAINT "imported_completion_event_id_nonempty" CHECK (length("imported_completion_event"."id") > 0),
	CONSTRAINT "imported_completion_event_actor" CHECK ((
			("imported_completion_event"."actor_kind" = 'source_claim' and "imported_completion_event"."actor_namespace" is not null)
			or ("imported_completion_event"."actor_kind" = 'unknown' and "imported_completion_event"."actor_namespace" is null and "imported_completion_event"."actor_principal_id" is null and "imported_completion_event"."actor_name" is null)
		)),
	CONSTRAINT "imported_completion_event_origin" CHECK ((
			("imported_completion_event"."origin_kind" = 'source_claim' and ("imported_completion_event"."origin_mechanism" is null or "imported_completion_event"."origin_mechanism" in ('member_mutation', 'capability_recipient')))
			or ("imported_completion_event"."origin_kind" = 'unknown' and "imported_completion_event"."origin_mechanism" is null and "imported_completion_event"."origin_label" is null)
		)),
	CONSTRAINT "imported_completion_event_redaction" CHECK ("imported_completion_event"."provenance_redacted_at" is null or ("imported_completion_event"."actor_kind" = 'unknown' and "imported_completion_event"."origin_kind" = 'unknown')),
	CONSTRAINT "imported_completion_event_claim_length" CHECK (("imported_completion_event"."actor_name" is null or char_length("imported_completion_event"."actor_name") <= 512) and ("imported_completion_event"."origin_label" is null or char_length("imported_completion_event"."origin_label") <= 128)),
	CONSTRAINT "imported_completion_event_payload" CHECK ((
			("imported_completion_event"."action" in ('complete', 'reopen', 'skip') and "imported_completion_event"."before_due_all_day" is not null and "imported_completion_event"."before_done" is not null and "imported_completion_event"."after_done" is not null and "imported_completion_event"."habit_date" is null and "imported_completion_event"."before_habit_status" is null and "imported_completion_event"."after_habit_status" is null)
			or ("imported_completion_event"."action" in ('habit_set', 'habit_unlog') and "imported_completion_event"."habit_date" is not null and "imported_completion_event"."before_due_at" is null and "imported_completion_event"."before_due_all_day" is null and "imported_completion_event"."before_done" is null and "imported_completion_event"."after_due_at" is null and "imported_completion_event"."after_done" is null)
		)),
	CONSTRAINT "imported_completion_event_transition" CHECK ((
			("imported_completion_event"."action" = 'complete' and "imported_completion_event"."before_done" = false)
			or ("imported_completion_event"."action" = 'reopen' and "imported_completion_event"."before_done" = true and "imported_completion_event"."after_done" = false)
			or ("imported_completion_event"."action" = 'skip' and "imported_completion_event"."after_done" = false and "imported_completion_event"."after_due_at" is not null)
			or ("imported_completion_event"."action" = 'habit_set' and "imported_completion_event"."after_habit_status" is not null and "imported_completion_event"."after_habit_status" is distinct from "imported_completion_event"."before_habit_status")
			or ("imported_completion_event"."action" = 'habit_unlog' and "imported_completion_event"."before_habit_status" is not null and "imported_completion_event"."after_habit_status" is null)
		)),
	CONSTRAINT "imported_completion_event_habit_date" CHECK ("imported_completion_event"."habit_date" is null or "imported_completion_event"."habit_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "comment" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "source_namespace" uuid;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "source_row_id" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "historical_author_kind" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "historical_author_namespace" uuid;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "historical_author_principal_id" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "historical_author_name" text;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "imported_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "comment" ADD COLUMN "provenance_redacted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "source_namespace" uuid;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "source_row_id" text;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "historical_creator_kind" text;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "historical_creator_namespace" uuid;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "historical_creator_principal_id" text;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "historical_creator_name" text;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "imported_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "provenance_redacted_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "imported_completion_event" ADD CONSTRAINT "imported_completion_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "imported_completion_event_page_idx" ON "imported_completion_event" USING btree ("task_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_provenance" CHECK ((
		("comment"."author_id" is not null and "comment"."source_namespace" is null and "comment"."source_row_id" is null and "comment"."historical_author_kind" is null and "comment"."historical_author_namespace" is null and "comment"."historical_author_principal_id" is null and "comment"."historical_author_name" is null and "comment"."imported_at" is null and "comment"."provenance_redacted_at" is null)
		or ("comment"."author_id" is null and "comment"."source_namespace" is not null and "comment"."source_row_id" is not null and "comment"."historical_author_kind" is not null and "comment"."imported_at" is not null
			and (("comment"."historical_author_kind" = 'source_claim' and "comment"."historical_author_namespace" is not null)
				or ("comment"."historical_author_kind" = 'unknown' and "comment"."historical_author_namespace" is null and "comment"."historical_author_principal_id" is null and "comment"."historical_author_name" is null))
			and ("comment"."provenance_redacted_at" is null or "comment"."historical_author_kind" = 'unknown'))
	));--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_historical_author_name_length" CHECK ("comment"."historical_author_name" is null or char_length("comment"."historical_author_name") <= 512);--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_provenance" CHECK ((
		("template"."source_namespace" is null and "template"."source_row_id" is null and "template"."historical_creator_kind" is null and "template"."historical_creator_namespace" is null and "template"."historical_creator_principal_id" is null and "template"."historical_creator_name" is null and "template"."imported_at" is null and "template"."provenance_redacted_at" is null)
		or ("template"."source_namespace" is not null and "template"."source_row_id" is not null and "template"."historical_creator_kind" is not null and "template"."imported_at" is not null
			and (("template"."historical_creator_kind" = 'source_claim' and "template"."historical_creator_namespace" is not null)
				or ("template"."historical_creator_kind" = 'unknown' and "template"."historical_creator_namespace" is null and "template"."historical_creator_principal_id" is null and "template"."historical_creator_name" is null))
			and ("template"."provenance_redacted_at" is null or "template"."historical_creator_kind" = 'unknown'))
	));--> statement-breakpoint
ALTER TABLE "template" ADD CONSTRAINT "template_historical_creator_name_length" CHECK ("template"."historical_creator_name" is null or char_length("template"."historical_creator_name") <= 512);