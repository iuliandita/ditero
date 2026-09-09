-- Task 15. A grant is the first write here where the writer and the row's owner
-- are different people, so the owner-only policies these tables shipped with
-- cannot express it.

-- key_grant_request: the recipient creates it, a granter fulfils it. Reads and
-- fulfilment open to workspace members; creation stays with the recipient, so a
-- member cannot manufacture a request naming someone else.
DROP POLICY "key_grant_request_owner" ON "key_grant_request";--> statement-breakpoint
CREATE POLICY "key_grant_request_read" ON "key_grant_request" FOR SELECT
	USING (
		"user_id" = current_setting('ditero.user_id', true)
		OR EXISTS (
			SELECT 1 FROM "membership" m
			WHERE m."workspace_id" = "key_grant_request"."workspace_id"
			  AND m."user_id" = current_setting('ditero.user_id', true)
		)
	);--> statement-breakpoint
CREATE POLICY "key_grant_request_own_insert" ON "key_grant_request" FOR INSERT
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "key_grant_request_fulfil" ON "key_grant_request" FOR UPDATE
	USING (
		"user_id" = current_setting('ditero.user_id', true)
		OR EXISTS (
			SELECT 1 FROM "membership" m
			WHERE m."workspace_id" = "key_grant_request"."workspace_id"
			  AND m."user_id" = current_setting('ditero.user_id', true)
		)
	)
	WITH CHECK (
		"user_id" = current_setting('ditero.user_id', true)
		OR EXISTS (
			SELECT 1 FROM "membership" m
			WHERE m."workspace_id" = "key_grant_request"."workspace_id"
			  AND m."user_id" = current_setting('ditero.user_id', true)
		)
	);--> statement-breakpoint
CREATE POLICY "key_grant_request_own_delete" ON "key_grant_request" FOR DELETE
	USING ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint

-- membership_key: a wrap is HPKE ciphertext addressed to one public key, so a
-- co-member reading it learns nothing they can open. Reads widen to workspace
-- members because the granter must tell "already granted, identical" from
-- "already granted, different" -- deciding that by re-reading is what keeps the
-- answer honest without letting a granter overwrite anything. INSERT admits a
-- granter writing for a member of a workspace they share; UPDATE and DELETE
-- stay with the owner, so a wrap can be created for someone but never moved.
DROP POLICY "membership_key_owner" ON "membership_key";--> statement-breakpoint
CREATE POLICY "membership_key_read" ON "membership_key" FOR SELECT
	USING (
		"user_id" = current_setting('ditero.user_id', true)
		OR EXISTS (
			SELECT 1 FROM "membership" m
			WHERE m."workspace_id" = "membership_key"."workspace_id"
			  AND m."user_id" = current_setting('ditero.user_id', true)
		)
	);--> statement-breakpoint
CREATE POLICY "membership_key_grant_insert" ON "membership_key" FOR INSERT
	WITH CHECK (
		"user_id" = current_setting('ditero.user_id', true)
		OR (
			"granted_by" = current_setting('ditero.user_id', true)
			AND EXISTS (
				SELECT 1 FROM "membership" m
				WHERE m."workspace_id" = "membership_key"."workspace_id"
				  AND m."user_id" = current_setting('ditero.user_id', true)
			)
		)
	);--> statement-breakpoint
CREATE POLICY "membership_key_own_update" ON "membership_key" FOR UPDATE
	USING ("user_id" = current_setting('ditero.user_id', true))
	WITH CHECK ("user_id" = current_setting('ditero.user_id', true));--> statement-breakpoint
CREATE POLICY "membership_key_own_delete" ON "membership_key" FOR DELETE
	USING ("user_id" = current_setting('ditero.user_id', true));
