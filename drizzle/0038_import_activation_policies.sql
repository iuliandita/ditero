CREATE FUNCTION public.task_notification_activation_validate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id
    OR (OLD.import_occurrence_cutoff IS NOT NULL AND NEW.import_occurrence_cutoff IS DISTINCT FROM OLD.import_occurrence_cutoff)
    OR NEW.generation < OLD.generation
    OR (OLD.recipient_generation_cutoff IS NOT NULL AND (NEW.recipient_generation_cutoff IS NULL OR NEW.recipient_generation_cutoff < OLD.recipient_generation_cutoff)) THEN
    RAISE EXCEPTION 'activation identity or cutoff cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF current_setting('ditero.activation_scope', true) = 'account-delete' THEN
    IF NEW.status <> 'blocked' OR NEW.completion_mode IS NOT NULL
      OR ROW(NEW.generation, NEW.import_occurrence_cutoff, NEW.recipient_generation_cutoff,
        NEW.owning_source_id, NEW.owning_owner_user_id, NEW.owning_job_id, NEW.readiness_ordinal,
        NEW.manual_review_digest, NEW.expected_relationship_digest,
        NEW.expected_relationship_count, NEW.expected_relationship_bytes,
        NEW.expected_relationships, NEW.created_at)
        IS DISTINCT FROM
        ROW(OLD.generation, OLD.import_occurrence_cutoff, OLD.recipient_generation_cutoff,
          OLD.owning_source_id, OLD.owning_owner_user_id, OLD.owning_job_id, OLD.readiness_ordinal,
          OLD.manual_review_digest, OLD.expected_relationship_digest,
          OLD.expected_relationship_count, OLD.expected_relationship_bytes,
          OLD.expected_relationships, OLD.created_at) THEN
      RAISE EXCEPTION 'account deletion may only block activation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_notification_activation_validate_update BEFORE UPDATE ON public.task_notification_activation
FOR EACH ROW EXECUTE FUNCTION public.task_notification_activation_validate_update();
--> statement-breakpoint
CREATE FUNCTION public.task_notification_recipient_validate_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.task_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.task_id, OLD.user_id)
    OR NEW.generation < OLD.generation
    OR (OLD.cutoff IS NOT NULL AND (NEW.cutoff IS NULL OR NEW.cutoff < OLD.cutoff)) THEN
    RAISE EXCEPTION 'recipient identity or cutoff cannot move backwards' USING ERRCODE = '23514';
  END IF;
  IF current_setting('ditero.activation_scope', true) = 'account-delete' THEN
    IF NEW.active
      OR ROW(NEW.generation, NEW.cutoff, NEW.overdue_suppressed_due_at, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.generation, OLD.cutoff, OLD.overdue_suppressed_due_at, OLD.created_at) THEN
      RAISE EXCEPTION 'account deletion may only deactivate recipient' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_notification_recipient_validate_update BEFORE UPDATE ON public.task_notification_recipient
FOR EACH ROW EXECUTE FUNCTION public.task_notification_recipient_validate_update();
--> statement-breakpoint
ALTER TABLE "task_notification_activation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_notification_activation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_notification_recipient" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "task_notification_recipient" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "task_notification_activation_member_select" ON "task_notification_activation" FOR SELECT USING (
  EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_notification_activation.task_id
      AND m.user_id = current_setting('ditero.user_id', true))
);
--> statement-breakpoint
CREATE POLICY "task_notification_activation_service_select" ON "task_notification_activation" FOR SELECT USING (
  current_setting('ditero.activation_scope', true) IN ('producer', 'invite', 'ack', 'account-delete')
);
--> statement-breakpoint
CREATE POLICY "task_notification_activation_member_insert" ON "task_notification_activation" FOR INSERT WITH CHECK (
  coalesce(current_setting('ditero.activation_scope', true), '') = ''
  AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_notification_activation.task_id
      AND m.user_id = current_setting('ditero.user_id', true)
      AND m.role IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE POLICY "task_notification_activation_member_update" ON "task_notification_activation" FOR UPDATE
  USING (
    coalesce(current_setting('ditero.activation_scope', true), '') = ''
    AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
      JOIN membership m ON m.workspace_id = l.workspace_id
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE t.id = task_notification_activation.task_id
        AND m.user_id = current_setting('ditero.user_id', true)
        AND m.role IN ('owner', 'admin', 'member'))
  )
  WITH CHECK (
    coalesce(current_setting('ditero.activation_scope', true), '') = ''
    AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
      JOIN membership m ON m.workspace_id = l.workspace_id
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE t.id = task_notification_activation.task_id
        AND m.user_id = current_setting('ditero.user_id', true)
        AND m.role IN ('owner', 'admin', 'member'))
  );
--> statement-breakpoint
CREATE POLICY "task_notification_activation_account_delete_update" ON "task_notification_activation" FOR UPDATE
  USING (current_setting('ditero.activation_scope', true) = 'account-delete')
  WITH CHECK (current_setting('ditero.activation_scope', true) = 'account-delete' AND status = 'blocked');
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_member_select" ON "task_notification_recipient" FOR SELECT USING (
  EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_notification_recipient.task_id
      AND m.user_id = current_setting('ditero.user_id', true))
);
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_service_select" ON "task_notification_recipient" FOR SELECT USING (
  current_setting('ditero.activation_scope', true) IN ('producer', 'invite', 'ack', 'account-delete')
);
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_member_insert" ON "task_notification_recipient" FOR INSERT WITH CHECK (
  coalesce(current_setting('ditero.activation_scope', true), '') = ''
  AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
    JOIN membership m ON m.workspace_id = l.workspace_id
    JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
    WHERE t.id = task_notification_recipient.task_id
      AND m.user_id = current_setting('ditero.user_id', true)
      AND m.role IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_member_update" ON "task_notification_recipient" FOR UPDATE
  USING (
    coalesce(current_setting('ditero.activation_scope', true), '') = ''
    AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
      JOIN membership m ON m.workspace_id = l.workspace_id
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE t.id = task_notification_recipient.task_id
        AND m.user_id = current_setting('ditero.user_id', true)
        AND m.role IN ('owner', 'admin', 'member'))
  )
  WITH CHECK (
    coalesce(current_setting('ditero.activation_scope', true), '') = ''
    AND EXISTS (SELECT 1 FROM task t JOIN list l ON l.id = t.list_id
      JOIN membership m ON m.workspace_id = l.workspace_id
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE t.id = task_notification_recipient.task_id
        AND m.user_id = current_setting('ditero.user_id', true)
        AND m.role IN ('owner', 'admin', 'member'))
  );
--> statement-breakpoint
CREATE POLICY "task_notification_recipient_account_delete_update" ON "task_notification_recipient" FOR UPDATE
  USING (current_setting('ditero.activation_scope', true) = 'account-delete')
  WITH CHECK (current_setting('ditero.activation_scope', true) = 'account-delete' AND active = false);
