DO $$
DECLARE duplicates integer;
BEGIN
 SELECT count(*) INTO duplicates FROM (
  SELECT 1 FROM "account" GROUP BY "provider_id", "account_id" HAVING count(*) > 1
 ) d;
 IF duplicates > 0 THEN
  RAISE EXCEPTION 'account has % provider account key(s) shared by several rows; resolve them before migrating (see docs/runbooks/database-roles.md#better-auth-17-upgrade)', duplicates
   USING ERRCODE = '23505';
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_uidx" ON "account" USING btree ("provider_id","account_id");
