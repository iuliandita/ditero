ALTER TABLE "import_history_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_history_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_history_ledger_member_select" ON "import_history_ledger"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM membership m
      JOIN "user" u ON u.id = m.user_id AND u.deleted_at IS NULL
      WHERE m.user_id = current_setting('ditero.user_id', true)
        AND m.workspace_id = CASE
          WHEN import_history_ledger.collection = 'templates'
            THEN import_history_ledger.target_parent_id
          ELSE (
            SELECT l.workspace_id FROM task t
            JOIN list l ON l.id = t.list_id
            WHERE t.id = import_history_ledger.target_parent_id
          )
        END
    )
  );
--> statement-breakpoint
ALTER TABLE "import_history_redaction" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_history_redaction" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_history_redaction_member_select" ON "import_history_redaction"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM import_history_ledger l
      WHERE l.id = import_history_redaction.ledger_id
    )
  );
--> statement-breakpoint
-- The initial batch has no runtime write proof. Later apply must replace this
-- gate together with an exact job/item/ordinal authorization policy.
CREATE FUNCTION guard_import_history_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.rolsuper OR r.rolbypassrls INTO privileged
      FROM pg_roles r WHERE r.rolname = current_user;
    IF NOT coalesce(privileged, false) THEN
      RAISE EXCEPTION 'import history ledger writes require a privileged import path'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'import history ledger is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER import_history_ledger_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_history_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_import_history_ledger();
--> statement-breakpoint
CREATE TRIGGER import_history_redaction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON import_history_redaction
  FOR EACH ROW EXECUTE FUNCTION guard_import_history_ledger();
