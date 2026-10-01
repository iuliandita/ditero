-- Custom SQL migration file, put your code below! --
ALTER TABLE "task_completion_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_completion_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "task_completion_event_member_select" ON "task_completion_event" FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM task t
    JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_completion_event.task_id
      AND m.user_id = current_setting('ditero.user_id', true)
  )
);
--> statement-breakpoint
CREATE POLICY "task_completion_event_scoped_insert" ON "task_completion_event" FOR INSERT WITH CHECK (
  current_setting('ditero.completion_history_scope_present', true) = '1'
  AND task_id = current_setting('ditero.completion_history_task_id', true)
  AND actor_user_id = current_setting('ditero.completion_history_actor_id', true)
  AND actor_user_id = current_setting('ditero.user_id', true)
  AND origin = current_setting('ditero.completion_history_origin', true)
  AND coalesce(current_setting('ditero.activation_scope', true), '') = ''
  AND EXISTS (
    SELECT 1 FROM task t
    JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_completion_event.task_id
      AND m.user_id = task_completion_event.actor_user_id
      AND m.role IN ('owner', 'admin', 'member')
  )
);
