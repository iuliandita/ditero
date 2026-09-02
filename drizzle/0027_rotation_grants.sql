-- Own requests must describe the caller's real membership. Checking user_id
-- alone admitted a row that paired the caller with another member's seat.
DROP POLICY "key_grant_request_own_insert" ON "key_grant_request";--> statement-breakpoint
CREATE POLICY "key_grant_request_own_insert" ON "key_grant_request" FOR INSERT
	WITH CHECK (
		"user_id" = current_setting('ditero.user_id', true)
		AND EXISTS (
			SELECT 1 FROM "membership" target
			WHERE target."id" = "key_grant_request"."membership_id"
			  AND target."user_id" = "key_grant_request"."user_id"
			  AND target."workspace_id" = "key_grant_request"."workspace_id"
		)
	);--> statement-breakpoint

-- During removal rotation, an Owner/Admin creates a next-version request for
-- each remaining member who has not enrolled and therefore has no public key
-- to receive an immediate wrap. The flag and active-version predicates keep
-- this narrow exception unavailable to ordinary grant flows.
CREATE POLICY "key_grant_request_rotation_insert" ON "key_grant_request" FOR INSERT
	WITH CHECK (
		"state" = 'key_pending'
		AND EXISTS (
			SELECT 1 FROM "membership" caller
			WHERE caller."workspace_id" = "key_grant_request"."workspace_id"
			  AND caller."user_id" = current_setting('ditero.user_id', true)
			  AND caller."role" IN ('owner', 'admin')
		)
		AND EXISTS (
			SELECT 1 FROM "membership" target
			WHERE target."id" = "key_grant_request"."membership_id"
			  AND target."user_id" = "key_grant_request"."user_id"
			  AND target."workspace_id" = "key_grant_request"."workspace_id"
		)
		AND EXISTS (
			SELECT 1 FROM "workspace" w
			WHERE w."id" = "key_grant_request"."workspace_id"
			  AND w."rotation_required"
		)
		AND EXISTS (
			SELECT 1 FROM "workspace_key" wk
			WHERE wk."workspace_id" = "key_grant_request"."workspace_id"
			  AND wk."version" = "key_grant_request"."requested_version"
			  AND wk."active"
		)
	);
