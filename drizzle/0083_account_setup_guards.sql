-- Existing accounts keep their content and receive no first-run offer.
INSERT INTO "account_setup" ("id", "outcome")
SELECT "id", 'legacy' FROM "user"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "account_setup" FORCE ROW LEVEL SECURITY;
