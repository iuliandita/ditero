-- Membership removal also serves Viewers leaving their own workspace.
CREATE FUNCTION public.membership_cleanup_validate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ditero.activation_scope', true) = 'membership-remove' THEN
    IF TG_TABLE_NAME = 'task_notification_activation' THEN
      IF NEW.status <> 'blocked' OR NEW.completion_mode IS NOT NULL
        OR NEW.blocked_reason IS DISTINCT FROM 'membership-removed'
        OR (to_jsonb(NEW) - ARRAY['status','completion_mode','blocked_reason','updated_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','completion_mode','blocked_reason','updated_at']) THEN
        RAISE EXCEPTION 'membership removal may only block activation' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NEW.active OR (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
        RAISE EXCEPTION 'membership removal may only deactivate recipients' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER membership_cleanup_activation_update BEFORE UPDATE ON public.task_notification_activation
FOR EACH ROW EXECUTE FUNCTION public.membership_cleanup_validate_update();
--> statement-breakpoint
CREATE TRIGGER membership_cleanup_recipient_update BEFORE UPDATE ON public.task_notification_recipient
FOR EACH ROW EXECUTE FUNCTION public.membership_cleanup_validate_update();
--> statement-breakpoint
CREATE POLICY "task_notification_activation_membership_cleanup" ON "task_notification_activation" FOR UPDATE
USING (current_setting('ditero.activation_scope', true) = 'membership-remove' AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id=t.list_id
      JOIN membership m ON m.workspace_id=l.workspace_id
      JOIN "user" u ON u.id=m.user_id AND u.deleted_at IS NULL
      WHERE t.id=task_notification_activation.task_id AND m.user_id=current_setting('ditero.user_id', true)))
WITH CHECK (current_setting('ditero.activation_scope', true) = 'membership-remove' AND status = 'blocked' AND completion_mode IS NULL AND blocked_reason = 'membership-removed' AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id=t.list_id
      JOIN membership m ON m.workspace_id=l.workspace_id
      JOIN "user" u ON u.id=m.user_id AND u.deleted_at IS NULL
      WHERE t.id=task_notification_activation.task_id AND m.user_id=current_setting('ditero.user_id', true)));
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_membership_cleanup" ON "task_notification_recipient" FOR UPDATE
USING (current_setting('ditero.activation_scope', true) = 'membership-remove' AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id=t.list_id
      JOIN membership m ON m.workspace_id=l.workspace_id
      JOIN "user" u ON u.id=m.user_id AND u.deleted_at IS NULL
      WHERE t.id=task_notification_recipient.task_id AND m.user_id=current_setting('ditero.user_id', true)))
WITH CHECK (current_setting('ditero.activation_scope', true) = 'membership-remove' AND active = false AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id=t.list_id
      JOIN membership m ON m.workspace_id=l.workspace_id
      JOIN "user" u ON u.id=m.user_id AND u.deleted_at IS NULL
      WHERE t.id=task_notification_recipient.task_id AND m.user_id=current_setting('ditero.user_id', true)));
