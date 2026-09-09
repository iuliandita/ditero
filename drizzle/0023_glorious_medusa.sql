ALTER TABLE "user_key" DROP CONSTRAINT "user_key_user_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "user_key_active" ON "user_key" USING btree ("user_id") WHERE retired_at is null;