-- Seed before FORCE RLS: the export transaction is read-only and cannot
-- initialize an installation namespace on first use.
INSERT INTO "portability_identity" ("id", "namespace") VALUES (1, gen_random_uuid());
--> statement-breakpoint
ALTER TABLE "portability_identity" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "portability_identity" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "portability_identity_live_user_select" ON "portability_identity"
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM "user" u
      WHERE u.id = current_setting('ditero.user_id', true)
        AND u.deleted_at IS NULL
    )
  );
