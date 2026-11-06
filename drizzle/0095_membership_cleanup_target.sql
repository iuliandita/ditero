CREATE POLICY "inbound_webhook_membership_cleanup_read" ON "inbound_webhook" AS PERMISSIVE FOR SELECT TO public USING (current_setting('ditero.activation_scope', true) = 'membership-remove'
			and "inbound_webhook"."user_id" = current_setting('ditero.removal_target', true)
			and exists (select 1 from membership m join "user" u on u.id=m.user_id
			where m.workspace_id="inbound_webhook"."workspace_id" and m.user_id=current_setting('ditero.user_id', true)
			and m.role in ('owner','admin') and u.deleted_at is null));--> statement-breakpoint
CREATE POLICY "inbound_webhook_membership_cleanup_revoke" ON "inbound_webhook" AS PERMISSIVE FOR UPDATE TO public USING (current_setting('ditero.activation_scope', true) = 'membership-remove'
			and "inbound_webhook"."user_id" = current_setting('ditero.removal_target', true)
			and exists (select 1 from membership m join "user" u on u.id=m.user_id
			where m.workspace_id="inbound_webhook"."workspace_id" and m.user_id=current_setting('ditero.user_id', true)
			and m.role in ('owner','admin') and u.deleted_at is null)) WITH CHECK ("inbound_webhook"."revoked_at" is not null
			and current_setting('ditero.activation_scope', true) = 'membership-remove'
			and "inbound_webhook"."user_id" = current_setting('ditero.removal_target', true)
			and exists (select 1 from membership m join "user" u on u.id=m.user_id
			where m.workspace_id="inbound_webhook"."workspace_id" and m.user_id=current_setting('ditero.user_id', true)
			and m.role in ('owner','admin') and u.deleted_at is null));