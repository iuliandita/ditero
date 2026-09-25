ALTER POLICY "import_run_owner_insert" ON "import_run" WITH CHECK (
  owner_user_id = current_setting('ditero.user_id', true)
  AND EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_run.job_id AND j.owner_user_id = import_run.owner_user_id AND j.planner_version IN (2, 3, 4) AND j.apply_supported)
);
--> statement-breakpoint
ALTER POLICY "import_run_owner_update" ON "import_run"
  USING (owner_user_id = current_setting('ditero.user_id', true))
  WITH CHECK (
    owner_user_id = current_setting('ditero.user_id', true)
    AND EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_run.job_id AND j.owner_user_id = import_run.owner_user_id AND j.planner_version IN (2, 3, 4) AND j.apply_supported)
  );
