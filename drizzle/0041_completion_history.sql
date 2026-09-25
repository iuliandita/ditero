CREATE TABLE "task_completion_event" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"recorded_at" timestamp (3) with time zone NOT NULL,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"before_due_at" timestamp (3) with time zone,
	"before_due_all_day" boolean,
	"before_done" boolean,
	"after_due_at" timestamp (3) with time zone,
	"after_done" boolean,
	"habit_date" text,
	"before_habit_status" "habit_log_status",
	"after_habit_status" "habit_log_status",
	CONSTRAINT "task_completion_event_id_uuid" CHECK ("task_completion_event"."id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "task_completion_event_origin" CHECK ("task_completion_event"."origin" in ('member_mutation', 'capability_recipient')),
	CONSTRAINT "task_completion_event_payload" CHECK ((
				("task_completion_event"."action" in ('complete', 'reopen', 'skip')
					and "task_completion_event"."before_due_all_day" is not null
					and "task_completion_event"."before_done" is not null
					and "task_completion_event"."after_done" is not null
					and "task_completion_event"."habit_date" is null
					and "task_completion_event"."before_habit_status" is null
					and "task_completion_event"."after_habit_status" is null)
				or ("task_completion_event"."action" in ('habit_set', 'habit_unlog')
					and "task_completion_event"."habit_date" is not null
					and "task_completion_event"."before_due_at" is null
					and "task_completion_event"."before_due_all_day" is null
					and "task_completion_event"."before_done" is null
					and "task_completion_event"."after_due_at" is null
					and "task_completion_event"."after_done" is null)
			)),
	CONSTRAINT "task_completion_event_transition" CHECK ((
				("task_completion_event"."action" = 'complete' and "task_completion_event"."before_done" = false)
				or ("task_completion_event"."action" = 'reopen' and "task_completion_event"."before_done" = true and "task_completion_event"."after_done" = false)
				or ("task_completion_event"."action" = 'skip' and "task_completion_event"."after_done" = false and "task_completion_event"."after_due_at" is not null)
				or ("task_completion_event"."action" = 'habit_set' and "task_completion_event"."after_habit_status" is not null
					and "task_completion_event"."after_habit_status" is distinct from "task_completion_event"."before_habit_status")
				or ("task_completion_event"."action" = 'habit_unlog' and "task_completion_event"."before_habit_status" is not null
					and "task_completion_event"."after_habit_status" is null)
			)),
	CONSTRAINT "task_completion_event_habit_date" CHECK ("task_completion_event"."habit_date" is null or "task_completion_event"."habit_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);
--> statement-breakpoint
ALTER TABLE "task_completion_event" ADD CONSTRAINT "task_completion_event_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_completion_event" ADD CONSTRAINT "task_completion_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_completion_event_page_idx" ON "task_completion_event" USING btree ("task_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_completion_event_actor_idx" ON "task_completion_event" USING btree ("actor_user_id");