ALTER TABLE "imported_completion_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "imported_completion_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "imported_completion_event_member_select" ON "imported_completion_event"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM task t
      JOIN list l ON l.id = t.list_id
      JOIN membership m ON m.workspace_id = l.workspace_id
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE t.id = imported_completion_event.task_id
        AND m.user_id = current_setting('ditero.user_id', true)
    )
  );
--> statement-breakpoint
-- The runtime role cannot seed imported provenance. The future import apply
-- migration must replace this closed boundary with a scoped proof policy.
CREATE FUNCTION guard_imported_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  privileged boolean;
BEGIN
  SELECT r.rolsuper OR r.rolbypassrls
    INTO privileged
    FROM pg_roles r
    WHERE r.rolname = current_user;
  IF NOT coalesce(privileged, false) THEN
    IF TG_TABLE_NAME = 'imported_completion_event'
      OR (TG_TABLE_NAME = 'comment' AND (NEW.source_namespace IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.source_namespace IS NOT NULL)))
      OR (TG_TABLE_NAME = 'template' AND (NEW.source_namespace IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.source_namespace IS NOT NULL)))
    THEN
      RAISE EXCEPTION 'imported history writes require a privileged import path' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  IF TG_TABLE_NAME = 'comment' THEN
    IF OLD.source_namespace IS NULL AND NEW.source_namespace IS NULL THEN RETURN NEW; END IF;
    IF OLD.source_namespace IS NULL OR NEW.source_namespace IS NULL
      OR ROW(OLD.id, OLD.task_id, OLD.author_id, OLD.body, OLD.created_at, OLD.edited_at, OLD.source_namespace, OLD.source_row_id, OLD.imported_at)
        IS DISTINCT FROM
        ROW(NEW.id, NEW.task_id, NEW.author_id, NEW.body, NEW.created_at, NEW.edited_at, NEW.source_namespace, NEW.source_row_id, NEW.imported_at)
    THEN
      RAISE EXCEPTION 'imported comment content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.historical_author_kind, OLD.historical_author_namespace, OLD.historical_author_principal_id, OLD.historical_author_name)
      IS DISTINCT FROM ROW(NEW.historical_author_kind, NEW.historical_author_namespace, NEW.historical_author_principal_id, NEW.historical_author_name) THEN
      RAISE EXCEPTION 'imported comment claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'template' THEN
    IF OLD.source_namespace IS NULL AND NEW.source_namespace IS NULL THEN RETURN NEW; END IF;
    IF OLD.source_namespace IS NULL OR NEW.source_namespace IS NULL
      OR ROW(OLD.id, OLD.workspace_id, OLD.kind, OLD.name, OLD.icon, OLD.content, OLD.created_by, OLD.source_namespace, OLD.source_row_id, OLD.imported_at)
        IS DISTINCT FROM
        ROW(NEW.id, NEW.workspace_id, NEW.kind, NEW.name, NEW.icon, NEW.content, NEW.created_by, NEW.source_namespace, NEW.source_row_id, NEW.imported_at)
    THEN
      RAISE EXCEPTION 'imported template content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.historical_creator_kind, OLD.historical_creator_namespace, OLD.historical_creator_principal_id, OLD.historical_creator_name)
      IS DISTINCT FROM ROW(NEW.historical_creator_kind, NEW.historical_creator_namespace, NEW.historical_creator_principal_id, NEW.historical_creator_name) THEN
      RAISE EXCEPTION 'imported template claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(OLD.id, OLD.task_id, OLD.source_namespace, OLD.source_row_id, OLD.occurred_at, OLD.ingested_at,
           OLD.action, OLD.before_due_at, OLD.before_due_all_day, OLD.before_done, OLD.after_due_at,
           OLD.after_done, OLD.habit_date, OLD.before_habit_status, OLD.after_habit_status)
      IS DISTINCT FROM
       ROW(NEW.id, NEW.task_id, NEW.source_namespace, NEW.source_row_id, NEW.occurred_at, NEW.ingested_at,
           NEW.action, NEW.before_due_at, NEW.before_due_all_day, NEW.before_done, NEW.after_due_at,
           NEW.after_done, NEW.habit_date, NEW.before_habit_status, NEW.after_habit_status) THEN
      RAISE EXCEPTION 'imported event content and source are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.provenance_redacted_at IS DISTINCT FROM OLD.provenance_redacted_at THEN
      IF OLD.provenance_redacted_at IS NOT NULL OR NEW.provenance_redacted_at IS NULL THEN
        RAISE EXCEPTION 'provenance redaction cannot be reversed' USING ERRCODE = '23514';
      END IF;
    ELSIF ROW(OLD.actor_kind, OLD.actor_namespace, OLD.actor_principal_id, OLD.actor_name,
              OLD.origin_kind, OLD.origin_mechanism, OLD.origin_label)
      IS DISTINCT FROM
          ROW(NEW.actor_kind, NEW.actor_namespace, NEW.actor_principal_id, NEW.actor_name,
              NEW.origin_kind, NEW.origin_mechanism, NEW.origin_label) THEN
      RAISE EXCEPTION 'imported event claims are immutable without redaction' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER comment_imported_history_guard BEFORE INSERT OR UPDATE ON comment
  FOR EACH ROW EXECUTE FUNCTION guard_imported_history();
--> statement-breakpoint
CREATE TRIGGER template_imported_history_guard BEFORE INSERT OR UPDATE ON template
  FOR EACH ROW EXECUTE FUNCTION guard_imported_history();
--> statement-breakpoint
CREATE TRIGGER imported_completion_event_guard BEFORE INSERT OR UPDATE ON imported_completion_event
  FOR EACH ROW EXECUTE FUNCTION guard_imported_history();
