ALTER TABLE "import_source" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_source" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_source_owner_select" ON "import_source" FOR SELECT USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_source_owner_insert" ON "import_source" FOR INSERT WITH CHECK (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_source_owner_delete" ON "import_source" FOR DELETE USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
ALTER TABLE "import_job" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_job" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_job_owner_select" ON "import_job" FOR SELECT USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
CREATE POLICY "import_job_owner_insert" ON "import_job" FOR INSERT WITH CHECK (owner_user_id = current_setting('ditero.user_id', true) AND created_txid = txid_current() AND EXISTS (SELECT 1 FROM import_source s WHERE s.id = import_job.source_id AND s.owner_user_id = import_job.owner_user_id));
--> statement-breakpoint
CREATE POLICY "import_job_owner_delete" ON "import_job" FOR DELETE USING (owner_user_id = current_setting('ditero.user_id', true));
--> statement-breakpoint
ALTER TABLE "import_item" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_item" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_item_owner_select" ON "import_item" FOR SELECT USING (EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_item.job_id AND j.owner_user_id = current_setting('ditero.user_id', true)));
--> statement-breakpoint
CREATE POLICY "import_item_owner_insert" ON "import_item" FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM import_job j WHERE j.created_txid = txid_current() AND j.id = import_item.job_id AND j.owner_user_id = current_setting('ditero.user_id', true)));
