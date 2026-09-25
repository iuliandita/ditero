ALTER POLICY "import_item_owner_insert" ON "import_item" WITH CHECK (
  EXISTS (
    SELECT 1 FROM import_job j
    WHERE j.created_txid = txid_current()
      AND j.id = import_item.job_id
      AND j.owner_user_id = current_setting('ditero.user_id', true)
      AND (
        j.planner_version = 1
        OR (
          j.planner_version IN (2, 3, 4)
          AND (
            import_item.disposition <> 'ensure'
            OR (
              import_item.phase IS NOT NULL
              AND import_item.content_digest IS NOT NULL
              AND import_item.target_precondition IS NOT NULL
              AND import_item.dependency_proof IS NOT NULL
            )
          )
        )
      )
  )
);
