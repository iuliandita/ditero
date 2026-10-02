ALTER TABLE "task" ADD COLUMN "has_import_activation" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  previous_scope text := current_setting('ditero.activation_scope', true);
BEGIN
  PERFORM set_config('ditero.activation_scope', 'producer', true);
  UPDATE task SET has_import_activation = true
  WHERE EXISTS (SELECT 1 FROM task_notification_activation WHERE task_id = task.id);
  PERFORM set_config('ditero.activation_scope', coalesce(previous_scope, ''), true);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION task_mark_import_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE task SET has_import_activation = true
  WHERE id = NEW.task_id AND has_import_activation = false;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_mark_import_activation
AFTER INSERT ON task_notification_activation
FOR EACH ROW EXECUTE FUNCTION task_mark_import_activation();
