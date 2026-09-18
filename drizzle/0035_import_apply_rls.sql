CREATE FUNCTION public.import_run_preserve_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.job_id, NEW.owner_user_id) IS DISTINCT FROM ROW(OLD.job_id, OLD.owner_user_id) THEN
    RAISE EXCEPTION 'import_run identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER import_run_preserve_identity BEFORE UPDATE ON public.import_run
FOR EACH ROW EXECUTE FUNCTION public.import_run_preserve_identity();
--> statement-breakpoint
CREATE FUNCTION public.import_source_map_preserve_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.source_id, NEW.source_key, NEW.owner_user_id, NEW.collection, NEW.source_row_id, NEW.target_id, NEW.target_workspace_id)
    IS DISTINCT FROM ROW(OLD.source_id, OLD.source_key, OLD.owner_user_id, OLD.collection, OLD.source_row_id, OLD.target_id, OLD.target_workspace_id) THEN
    RAISE EXCEPTION 'import_source_map identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER import_source_map_preserve_identity BEFORE UPDATE ON public.import_source_map
FOR EACH ROW EXECUTE FUNCTION public.import_source_map_preserve_identity();
--> statement-breakpoint
ALTER TABLE "import_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_run" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_run_owner_select" ON "import_run" FOR SELECT USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_run_owner_insert" ON "import_run" FOR INSERT WITH CHECK (
  owner_user_id = current_setting('ditero.user_id', true)
  AND EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_run.job_id AND j.owner_user_id = import_run.owner_user_id AND j.planner_version = 2 AND j.apply_supported)
);
--> statement-breakpoint
CREATE POLICY "import_run_owner_update" ON "import_run" FOR UPDATE
  USING (owner_user_id = current_setting('ditero.user_id', true))
  WITH CHECK (
    owner_user_id = current_setting('ditero.user_id', true)
    AND EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_run.job_id AND j.owner_user_id = import_run.owner_user_id AND j.planner_version = 2 AND j.apply_supported)
  );
--> statement-breakpoint
CREATE POLICY "import_run_owner_delete" ON "import_run" FOR DELETE USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
ALTER TABLE "import_source_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_source_map" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_source_map_owner_select" ON "import_source_map" FOR SELECT USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_source_map_owner_insert" ON "import_source_map" FOR INSERT WITH CHECK (
  owner_user_id = current_setting('ditero.user_id', true)
  AND EXISTS (SELECT 1 FROM import_source s WHERE s.id = import_source_map.source_id AND s.owner_user_id = import_source_map.owner_user_id)
);
--> statement-breakpoint
CREATE POLICY "import_source_map_owner_update" ON "import_source_map" FOR UPDATE
  USING (owner_user_id = current_setting('ditero.user_id', true))
  WITH CHECK (
    owner_user_id = current_setting('ditero.user_id', true)
    AND EXISTS (SELECT 1 FROM import_source s WHERE s.id = import_source_map.source_id AND s.owner_user_id = import_source_map.owner_user_id)
  );
--> statement-breakpoint
CREATE POLICY "import_source_map_owner_delete" ON "import_source_map" FOR DELETE USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
ALTER TABLE "import_workspace_map" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_workspace_map" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_workspace_map_owner_select" ON "import_workspace_map" FOR SELECT USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_workspace_map_owner_insert" ON "import_workspace_map" FOR INSERT WITH CHECK (
  owner_user_id = current_setting('ditero.user_id', true)
  AND EXISTS (SELECT 1 FROM import_source s WHERE s.id = import_workspace_map.source_id AND s.owner_user_id = import_workspace_map.owner_user_id)
);
--> statement-breakpoint
CREATE POLICY "import_workspace_map_owner_delete" ON "import_workspace_map" FOR DELETE USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
ALTER POLICY "import_item_owner_insert" ON "import_item" WITH CHECK (
  EXISTS (
    SELECT 1 FROM import_job j
    WHERE j.created_txid = txid_current()
      AND j.id = import_item.job_id
      AND j.owner_user_id = current_setting('ditero.user_id', true)
      AND (
        j.planner_version <> 2 OR import_item.disposition <> 'ensure'
        OR (
          import_item.phase IS NOT NULL
          AND import_item.content_digest IS NOT NULL
          AND import_item.target_precondition IS NOT NULL
          AND import_item.dependency_proof IS NOT NULL
        )
      )
  )
);
