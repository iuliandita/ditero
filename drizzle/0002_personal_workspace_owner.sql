CREATE UNIQUE INDEX "workspace_personal_owner" ON "workspace" USING btree ("owner_id") WHERE "workspace"."kind" = 'personal';
